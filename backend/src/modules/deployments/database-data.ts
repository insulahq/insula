/**
 * Where a standalone database instance's data lives, and moving it (roadmap R48).
 *
 * Attached data sits in the protected folder, `database/<engine>/<name>`, which
 * the file manager, SFTP, rsync and scp see as empty. Every way to raw files
 * moves the folder out first, with the instance stopped:
 *
 *  - Detach data → `kept-databases/<name>`; the instance cannot start until
 *    its data is attached again.
 *  - Attach data ← any folder (the detached one by default); its configuration
 *    files are cleaned and the instance is redeployed with the reset init
 *    container armed, so the platform's login comes back on that start, and
 *    the database-admin pass hardens whatever the folder brought.
 *  - Creating an instance on an existing folder attaches it.
 *  - A permanent delete moves the folder out (kept, or into the recycle bin
 *    from there) or removes it.
 *  - A folder in `database/` that belongs to no instance is listed when the
 *    folder is viewed, and moved out when the tenant asks.
 *  - An instance still on a custom or legacy path is moved in once.
 *
 * A move happens under the instance's database-admin lock (the same one the
 * reconciler takes), with the row read again inside it, after its pods are
 * gone, and refuses a folder another deployment uses (its storage path, an
 * extra mount, a site folder, a container volume, another instance's detached
 * data): moving it would leave that deployment's mount pointing at the
 * database's live files. What a move is about to do is written to the row
 * first, so a step that fails leaves something a retry can finish — never a
 * row that says the data is somewhere it is not.
 */
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import {
  DATABASE_ROOT,
  KEPT_DATABASES_ROOT,
  canonicalDatabasePath,
  folderProblem,
  isUnderDatabaseRoot,
  type DatabaseFoldersResponse,
  type ReleaseOrphanFoldersResponse,
} from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { catalogEntries, deployments, ingressRoutes, tenants } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  canMoveFolder,
  folderSizes,
  folderState,
  isPlatformPath,
  keptFolderCandidates,
  listProtectedEntries,
  moveFolder,
  moveToKept,
  removeFolder,
  sanitizeDataFolder,
  unlinkInPlace,
  withPlatformFiles,
  type MoveOutcome,
  type PlatformFilesRun,
} from './database-folders.js';

export interface DataDeps {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly kubeconfigPath?: string;
}

/** Stopping and redeploying an instance — the deployment service's, passed in. */
export interface InstanceControl {
  /** Scale the instance down and mark it stopped. */
  stop(): Promise<void>;
  /**
   * Re-render the pod template from the row (its storage path) with the reset
   * init container armed, at `replicas` (0 keeps it stopped).
   */
  redeploy(replicas: number): Promise<void>;
}

type DeploymentRow = typeof deployments.$inferSelect;

interface Standalone {
  readonly row: DeploymentRow;
  readonly catalogCode: string;
  readonly namespace: string;
}

/** How long a move may hold the instance's lock. */
const LOCK_TTL_MS = 15 * 60 * 1000;
/** How long to wait for an instance's pods to be gone before moving its data. */
const PODS_GONE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Refuses to start (restart, upgrade, roll back, repair) an instance whose
 * data is detached: its pod would come up on an empty folder and initialise a
 * fresh database there, which Attach would then refuse to overwrite.
 */
export function refuseDetachedData(row: { readonly name: string; readonly dataDetachedPath?: string | null }, action: string): void {
  if (!row.dataDetachedPath) return;
  throw new ApiError(
    'DATABASE_DATA_DETACHED',
    `The data of '${row.name}' is detached, in ${row.dataDetachedPath}. Attach it before you ${action} the instance.`,
    409,
    { detachedPath: row.dataDetachedPath },
  );
}

/** Two volume paths overlap when one is the other or lies inside it. */
export function foldersOverlap(a: string, b: string): boolean {
  const x = a.replace(/^\/+|\/+$/g, '');
  const y = b.replace(/^\/+|\/+$/g, '');
  if (x === '' || y === '') return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

async function loadStandalone(db: Database, tenantId: string, deploymentId: string): Promise<Standalone> {
  const [r] = await db
    .select({ row: deployments, type: catalogEntries.type, code: catalogEntries.code, namespace: tenants.kubernetesNamespace })
    .from(deployments)
    .innerJoin(catalogEntries, eq(catalogEntries.id, deployments.catalogEntryId))
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(and(eq(deployments.id, deploymentId), eq(deployments.tenantId, tenantId)));
  if (!r) throw new ApiError('DEPLOYMENT_NOT_FOUND', `Deployment '${deploymentId}' not found`, 404);
  if (r.type !== 'database') {
    throw new ApiError('NOT_A_DATABASE_INSTANCE', 'Only a standalone database instance has data to detach or attach.', 409);
  }
  if (!r.namespace) throw new ApiError('CONFIG_INVALID', 'The tenant has no namespace.', 409);
  return { row: r.row, catalogCode: r.code, namespace: r.namespace };
}

/**
 * Every folder a deployment of the tenant mounts or holds (except
 * `exceptId`'s), with the deployment's name: storage paths, extra mounts,
 * container volumes, site folders, and detached database data.
 */
export async function foldersInUse(db: Database, tenantId: string, exceptId?: string): Promise<Array<{ folder: string; owner: string }>> {
  const rows = await db
    .select({
      id: deployments.id, name: deployments.name, storagePath: deployments.storagePath,
      dataDetachedPath: deployments.dataDetachedPath, extraMounts: deployments.extraMounts, customSpec: deployments.customSpec,
    })
    .from(deployments)
    .where(eq(deployments.tenantId, tenantId));
  const used: Array<{ folder: string; owner: string }> = [];
  for (const r of rows) {
    if (r.id === exceptId) continue;
    if (r.storagePath) used.push({ folder: r.storagePath, owner: r.name });
    if (r.dataDetachedPath) used.push({ folder: r.dataDetachedPath, owner: r.name });
    for (const m of (r.extraMounts as Array<{ folder?: unknown }> | null) ?? []) {
      if (typeof m?.folder === 'string') used.push({ folder: m.folder, owner: r.name });
    }
    const volumes = (r.customSpec as { volumes?: Record<string, { folder?: unknown } | undefined> } | null)?.volumes ?? {};
    for (const v of Object.values(volumes)) {
      if (typeof v?.folder === 'string') used.push({ folder: v.folder, owner: r.name });
    }
  }
  const routes = await db
    .select({ siteFolder: ingressRoutes.siteFolder, owner: deployments.name, deploymentId: deployments.id })
    .from(ingressRoutes)
    .innerJoin(deployments, eq(deployments.id, ingressRoutes.deploymentId))
    .where(eq(deployments.tenantId, tenantId));
  for (const r of routes) {
    if (r.siteFolder && r.deploymentId !== exceptId) used.push({ folder: r.siteFolder, owner: r.owner });
  }
  return used;
}

async function refuseFolderInUse(db: Database, tenantId: string, folder: string, exceptId?: string): Promise<void> {
  const conflicts = (await foldersInUse(db, tenantId, exceptId)).filter((u) => foldersOverlap(u.folder, folder));
  if (conflicts.length > 0) {
    const owners = [...new Set(conflicts.map((c) => c.owner))];
    throw new ApiError(
      'FOLDER_IN_USE',
      `The folder ${folder} is used by ${owners.join(', ')}. Remove it from there first — a database's data folder cannot be shared.`,
      409,
      { folder, owners },
    );
  }
}

/** A folder a tenant names as a database's data: a plain folder, and not the kept folder itself. */
function refuseSourceFolder(folder: string): void {
  const problem = folderProblem(folder);
  if (problem) throw new ApiError('INVALID_PATH', problem, 400, { path: folder });
  if (folder === KEPT_DATABASES_ROOT) {
    throw new ApiError('INVALID_PATH', `Choose one folder inside ${KEPT_DATABASES_ROOT}, not the whole folder.`, 400, { path: folder });
  }
}

/** Runs `fn` holding the instance's database-admin lock, or refuses while something else holds it. */
async function withInstanceLock<T>(db: Database, deploymentId: string, fn: () => Promise<T>): Promise<T> {
  const r = await withSchedulerLease(db, `database-admin:${deploymentId}`, LOCK_TTL_MS, fn,
    { release: true, maxHoldMs: Infinity, startupRetry: false });
  if (!r.ran) {
    throw new ApiError('DATABASE_BUSY', 'The database is being checked or changed right now. Try again in a minute.', 409);
  }
  return r.value;
}

/** Waits until no pod of the instance exists, terminating ones included; throws when they outlast the wait. */
export async function waitForNoPods(k8s: K8sClients, namespace: string, name: string, timeoutMs = PODS_GONE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pods = await k8s.core.listNamespacedPod({ namespace, labelSelector: `app=${name}` });
    if (((pods as { items?: unknown[] }).items ?? []).length === 0) return;
    if (Date.now() > deadline) {
      throw new ApiError('DATABASE_STILL_RUNNING', `The database ${name} did not stop in time; try again.`, 409);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** The tenant-facing error for a failed move; the script's own words go to the log only. */
function moveError(outcome: MoveOutcome & { ok: false }, what: string, where: string): ApiError {
  if (outcome.reason === 'failed') console.warn(`[database-folders] ${where}: ${what} failed: ${outcome.detail}`);
  if (outcome.reason === 'stranded') console.warn(`[database-folders] ${where}: ${what}: moved but hard links are left and it could not be moved back: ${outcome.detail}`);
  switch (outcome.reason) {
    case 'links': return new ApiError('FOLDER_HAS_HARD_LINKS', `${what}: the folder holds files with a second name elsewhere (hard links), or there is no space to copy them apart. Remove the extra names, free some space, and try again.`, 409);
    case 'stranded': return new ApiError('FOLDER_MOVE_FAILED', `${what} could not be finished; the instance stays stopped. Contact support.`, 500);
    case 'missing': return new ApiError('FOLDER_NOT_FOUND', `${what}: the folder does not exist.`, 404);
    case 'exists': return new ApiError('FOLDER_EXISTS', `${what}: the destination already exists.`, 409);
    case 'symlink': return new ApiError('FOLDER_IS_LINK', `${what}: the folder or one of its parents is a link or not a folder.`, 400);
    default: return new ApiError('FOLDER_MOVE_FAILED', `${what} failed. Try again; if it keeps failing, contact support.`, 500);
  }
}

/**
 * The last steps before a moved-in folder may start: no file in it still has
 * a second name elsewhere, and its configuration is cleaned. Either failing
 * stops the start (the data stays where it is, the instance stopped).
 */
async function prepareForStart(run: PlatformFilesRun, folder: string, where: string): Promise<void> {
  if (!(await unlinkInPlace(run, folder))) {
    throw new ApiError('FOLDER_HAS_HARD_LINKS', 'The folder holds files with a second name elsewhere (hard links) that could not be copied apart — free some space and try again.', 409);
  }
  await sanitizeDataFolder(run, folder).catch((err: unknown) => {
    console.warn(`[database-folders] ${where}: cleaning the configuration of ${folder} failed: ${err instanceof Error ? err.message : String(err)}`);
    throw new ApiError('FOLDER_MOVE_FAILED', 'The data folder could not be prepared for the database. Try again; if it keeps failing, contact support.', 500);
  });
}

/**
 * Detach data: stop the instance and move its folder to
 * `kept-databases/<name>` (or a time-suffixed name when that is taken).
 */
export async function detachDatabaseData(
  deps: DataDeps, tenantId: string, deploymentId: string, control: InstanceControl,
): Promise<{ detachedPath: string }> {
  await loadStandalone(deps.db, tenantId, deploymentId);
  return withInstanceLock(deps.db, deploymentId, async () => {
    const { row, namespace } = await loadStandalone(deps.db, tenantId, deploymentId);
    if (row.status === 'deleted' || row.deletedAt) throw new ApiError('DEPLOYMENT_DELETED', 'Restore the instance first.', 409);
    if (row.dataDetachedPath) {
      throw new ApiError('DATABASE_DATA_DETACHED', `The data is already detached, in ${row.dataDetachedPath}.`, 409, { detachedPath: row.dataDetachedPath });
    }
    const folder = row.storagePath;
    if (!folder || !isUnderDatabaseRoot(folder)) {
      throw new ApiError('DATABASE_FOLDER_NOT_PROTECTED', 'The data is still being moved into the protected folder. Try again shortly.', 409);
    }
    if (row.status !== 'stopped') await control.stop();
    await waitForNoPods(deps.k8s, namespace, row.name);
    return withPlatformFiles(deps.k8s, deps.kubeconfigPath, namespace, 'database-detach', async (run) => {
      for (const candidate of keptFolderCandidates(row.name)) {
        // Recorded before the move: should the move land and anything after it
        // fail, the row already says where the data went, and Attach (which
        // finishes a move that landed) puts it back.
        await deps.db.update(deployments)
          .set({ dataDetachedPath: candidate, dataDetachedAt: new Date(), status: 'stopped' })
          .where(eq(deployments.id, deploymentId));
        const moved = await moveFolder(run, folder, candidate, false);
        if (moved.ok) return { detachedPath: candidate };
        if (moved.reason === 'exists') continue;
        await deps.db.update(deployments).set({ dataDetachedPath: null, dataDetachedAt: null }).where(eq(deployments.id, deploymentId));
        throw moveError(moved, 'Detaching the data', `${namespace}/${row.name}`);
      }
      await deps.db.update(deployments).set({ dataDetachedPath: null, dataDetachedAt: null }).where(eq(deployments.id, deploymentId));
      throw new ApiError('FOLDER_EXISTS', `Detaching the data: ${KEPT_DATABASES_ROOT}/${row.name} and its alternatives are taken.`, 409);
    });
  });
}

/**
 * Attach data: move `requestedPath` (default: the detached folder) into the
 * instance's protected folder, clean its configuration, and start the
 * instance with the reset init container. A move that already landed (the
 * source is gone, the instance's folder holds data, the row still says
 * detached) is finished rather than refused.
 */
export async function attachDatabaseData(
  deps: DataDeps, tenantId: string, deploymentId: string, requestedPath: string | undefined, control: InstanceControl,
): Promise<{ storagePath: string }> {
  await loadStandalone(deps.db, tenantId, deploymentId);
  return withInstanceLock(deps.db, deploymentId, async () => {
    const { row, catalogCode, namespace } = await loadStandalone(deps.db, tenantId, deploymentId);
    if (row.status === 'deleted' || row.deletedAt) throw new ApiError('DEPLOYMENT_DELETED', 'Restore the instance first.', 409);
    const source = (requestedPath ?? row.dataDetachedPath ?? '').replace(/^\/+|\/+$/g, '');
    if (!source) throw new ApiError('PATH_REQUIRED', 'Choose the folder to attach.', 400);
    refuseSourceFolder(source);
    if (!row.dataDetachedPath && row.status !== 'stopped') {
      throw new ApiError('DATABASE_DATA_ATTACHED', 'This instance still has its data. Detach it first.', 409);
    }
    await refuseFolderInUse(deps.db, tenantId, source, deploymentId);
    const target = row.storagePath && isUnderDatabaseRoot(row.storagePath)
      ? row.storagePath
      : canonicalDatabasePath(catalogCode, row.name);
    const where = `${namespace}/${row.name}`;
    await waitForNoPods(deps.k8s, namespace, row.name);
    await withPlatformFiles(deps.k8s, deps.kubeconfigPath, namespace, 'database-attach', async (run) => {
      const moved = await moveFolder(run, source, target, true);
      if (!moved.ok) {
        const [src, dst] = await folderState(run, source, target);
        const landed = moved.reason === 'missing' && src === 'missing' && dst === 'dir' && Boolean(row.dataDetachedPath);
        if (!landed) {
          if (moved.reason === 'exists') {
            throw new ApiError('DATABASE_DATA_ATTACHED', 'This instance still has data in its folder. Detach it first.', 409);
          }
          throw moveError(moved, 'Attaching the data', where);
        }
        console.log(`[database-folders] ${where}: finishing an attach whose move had already landed`);
      }
      await prepareForStart(run, target, where);
    });
    await deps.db.update(deployments)
      .set({
        storagePath: target,
        ...(row.storagePath && row.storagePath !== target ? { storageRelocatedFrom: row.storagePath } : {}),
        dataDetachedPath: null,
        dataDetachedAt: null,
        lastError: null,
      })
      .where(eq(deployments.id, deploymentId));
    await control.redeploy(row.replicaCount ?? 1);
    return { storagePath: target };
  });
}

/**
 * A new instance created on an existing folder: move that folder into the
 * instance's protected folder and clean its configuration before the first
 * start. A missing folder is a new, empty instance. Whatever already sits in
 * the protected folder under that name (data a permanent delete left there
 * before R48) is moved out first.
 */
export async function adoptFolderForNewDatabase(
  deps: DataDeps, tenantId: string, namespace: string, source: string, target: string,
): Promise<'adopted' | 'empty'> {
  const clean = source.replace(/^\/+|\/+$/g, '');
  refuseSourceFolder(clean);
  await refuseFolderInUse(deps.db, tenantId, clean);
  const where = `${namespace}/${target}`;
  return withPlatformFiles(deps.k8s, deps.kubeconfigPath, namespace, 'database-adopt', async (run) => {
    let moved = await moveFolder(run, clean, target, true);
    if (!moved.ok && moved.reason === 'exists') {
      const aside = await moveToKept(run, target, target.split('/').pop() ?? 'database');
      if (!aside.ok) throw moveError(aside, 'Moving old data aside', where);
      moved = await moveFolder(run, clean, target, true);
    }
    if (moved.ok) {
      await prepareForStart(run, target, where);
      return 'adopted';
    }
    if (moved.reason === 'missing') return 'empty';
    throw moveError(moved, 'Using the folder', where);
  });
}

/**
 * A permanent delete of a standalone instance: its folder (or its detached
 * data) leaves the protected folder — to `kept-databases/<name>` (returned, so
 * a delete with data can send it on to the recycle bin), or removed for good.
 * Nothing moves while a pod of the instance still runs: its open files would
 * follow the folder.
 */
export async function releaseDatabaseFolderOnDelete(
  deps: DataDeps, namespace: string, row: Pick<DeploymentRow, 'name' | 'storagePath' | 'dataDetachedPath'>, mode: 'keep' | 'remove',
): Promise<string | null> {
  if (row.dataDetachedPath) {
    const detached = row.dataDetachedPath;
    const attachedTo = row.storagePath && isUnderDatabaseRoot(row.storagePath) ? row.storagePath : null;
    // A detach (or a move into the protected folder) that never moved the
    // data marks it detached while it still sits in the instance's folder.
    const where = await withPlatformFiles(deps.k8s, deps.kubeconfigPath, namespace, 'database-delete', async (run) =>
      attachedTo ? (await folderState(run, detached, attachedTo)) : (['dir', 'missing'] as const));
    if (!(where[0] !== 'dir' && where[1] === 'dir')) {
      if (mode === 'keep') return detached;
      await withPlatformFiles(deps.k8s, deps.kubeconfigPath, namespace, 'database-delete', (run) => removeFolder(run, detached));
      return null;
    }
  }
  const folder = row.storagePath;
  if (!folder || !isUnderDatabaseRoot(folder)) return null;
  await waitForNoPods(deps.k8s, namespace, row.name);
  return withPlatformFiles(deps.k8s, deps.kubeconfigPath, namespace, 'database-delete', async (run) => {
    if (mode === 'remove') {
      await removeFolder(run, folder);
      return null;
    }
    const kept = await moveToKept(run, folder, row.name);
    return kept.ok ? kept.path : null;
  });
}

interface FolderRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly storagePath: string | null;
  readonly dataDetachedPath: string | null;
  readonly code: string;
}

async function standaloneRows(db: Database, tenantId: string): Promise<FolderRow[]> {
  return db
    .select({
      id: deployments.id, name: deployments.name, status: deployments.status,
      storagePath: deployments.storagePath, dataDetachedPath: deployments.dataDetachedPath, code: catalogEntries.code,
    })
    .from(deployments)
    .innerJoin(catalogEntries, eq(catalogEntries.id, deployments.catalogEntryId))
    .where(and(eq(deployments.tenantId, tenantId), eq(catalogEntries.type, 'database')));
}

/**
 * Entries of the protected folder that belong to nothing: no instance (live,
 * stopped or recently deleted — by its path or its name's path) and no other
 * deployment's folder. Only `database/<engine>/<name>` folders with plain names
 * count; anything else there is left alone.
 */
async function orphanEntries(run: PlatformFilesRun, db: Database, tenantId: string, rows: readonly FolderRow[]): Promise<string[]> {
  const known = [
    ...rows.flatMap((r) => [r.storagePath, canonicalDatabasePath(r.code, r.name)]),
    ...(await foldersInUse(db, tenantId)).map((u) => u.folder),
  ].filter((p): p is string => typeof p === 'string' && isUnderDatabaseRoot(p));
  return (await listProtectedEntries(run)).filter((entry) =>
    entry.split('/').length === 3 && isPlatformPath(entry) && !known.some((k) => foldersOverlap(k, entry)));
}

/**
 * The tenant's standalone instances with where their data is and how big it
 * is, and the folders in the protected folder that belong to none — what the
 * file manager shows in the protected folder. Changes nothing.
 */
export async function listDatabaseFolders(deps: DataDeps, tenantId: string, namespace: string): Promise<DatabaseFoldersResponse> {
  const rows = await standaloneRows(deps.db, tenantId);
  const folderOf = (r: FolderRow): string => r.dataDetachedPath ?? r.storagePath ?? `databases/${r.name}`;
  const { sizes, orphans } = await withPlatformFiles(deps.k8s, deps.kubeconfigPath, namespace, 'database-folders', async (run) => {
    const found = await orphanEntries(run, deps.db, tenantId, rows);
    return { sizes: await folderSizes(run, [...rows.map(folderOf), ...found]), orphans: found };
  });
  return {
    root: DATABASE_ROOT,
    keptRoot: KEPT_DATABASES_ROOT,
    instances: rows
      .map((r) => ({
        deploymentId: r.id,
        name: r.name,
        catalogCode: r.code,
        status: r.status,
        detachedPath: r.dataDetachedPath,
        folder: folderOf(r),
        sizeBytes: sizes.get(folderOf(r)) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    orphans: orphans.map((folder) => ({ folder, sizeBytes: sizes.get(folder) ?? null })).sort((a, b) => a.folder.localeCompare(b.folder)),
  };
}

/** Moves every folder of the protected folder that belongs to nothing out to `kept-databases/`. */
export async function releaseOrphanFolders(deps: DataDeps, tenantId: string, namespace: string): Promise<ReleaseOrphanFoldersResponse> {
  const rows = await standaloneRows(deps.db, tenantId);
  return withPlatformFiles(deps.k8s, deps.kubeconfigPath, namespace, 'database-orphans', async (run) => {
    const moved: Array<{ from: string; to: string }> = [];
    for (const entry of await orphanEntries(run, deps.db, tenantId, rows)) {
      const out = await moveToKept(run, entry, entry.split('/').pop() ?? 'database');
      if (out.ok) moved.push({ from: entry, to: out.path });
      else console.warn(`[database-folders] ${namespace}: could not move ${entry} out of ${DATABASE_ROOT}/: ${out.detail}`);
    }
    return { moved };
  });
}

/** Instances whose data is not in the protected folder yet, of active tenants. */
async function rowsToRelocate(db: Database, limit: number) {
  return db
    .select({ row: deployments, code: catalogEntries.code, namespace: tenants.kubernetesNamespace })
    .from(deployments)
    .innerJoin(catalogEntries, eq(catalogEntries.id, deployments.catalogEntryId))
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(and(
      eq(catalogEntries.type, 'database'),
      eq(tenants.status, 'active'),
      isNull(deployments.dataDetachedPath),
      or(isNull(deployments.storagePath), sql`NOT (${deployments.storagePath} = ${DATABASE_ROOT} OR ${deployments.storagePath} LIKE ${`${DATABASE_ROOT}/%`})`),
    ))
    .orderBy(asc(deployments.createdAt))
    .limit(limit);
}

async function notifyRelocation(db: Database, row: DeploymentRow, namespace: string, detail: string, action: string, items: string[], key: string): Promise<void> {
  const { notifyAdminOperationalEvent } = await import('../notifications/events.js');
  await notifyAdminOperationalEvent(db, 'database', {
    subsystem: 'Tenant databases',
    objectLabel: `${row.name} (${namespace})`,
    detail,
    severityLabel: 'warning',
    recommendedAction: action,
    items,
  }, key).catch(() => undefined);
}

/** Moves that failed, and when each may be tried again (per API replica; a restart forgets). */
const relocationBackoff = new Map<string, { readonly failures: number; readonly retryAt: number }>();
const BACKOFF_BASE_MS = 60 * 60 * 1000;
const BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

function noteRelocationFailure(rowId: string, now: number): number {
  const failures = (relocationBackoff.get(rowId)?.failures ?? 0) + 1;
  relocationBackoff.set(rowId, { failures, retryAt: now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)) });
  return failures;
}

type RelocateResult = 'moved' | 'blocked' | 'skipped';

/**
 * One instance's move into the protected folder, under its lock. Checked
 * first without touching the instance; then the row is marked (its data
 * "detached" at the old path, so nothing starts it mid-move), the instance
 * stopped, the row and the stopped pod template pointed at the new folder,
 * the data moved and prepared, the mark cleared and the instance started. A
 * move that fails cleanly is undone; one whose outcome is unknown keeps the
 * mark — Attach data then finishes it either way.
 */
async function relocateOne(deps: DataDeps, rowId: string, tenantId: string, code: string, namespace: string, control: InstanceControl): Promise<RelocateResult> {
  return withInstanceLock(deps.db, rowId, async () => {
    const [row] = await deps.db.select().from(deployments).where(eq(deployments.id, rowId));
    if (!row || !row.storagePath || row.dataDetachedPath || isUnderDatabaseRoot(row.storagePath)) return 'skipped';
    const source = row.storagePath;
    const target = canonicalDatabasePath(code, row.name);
    const where = `${namespace}/${row.name}`;
    const conflicts = (await foldersInUse(deps.db, tenantId, row.id)).filter((u) => foldersOverlap(u.folder, source));
    if (conflicts.length > 0) {
      await notifyRelocation(deps.db, row, namespace,
        `Its data folder ${source} cannot move into the protected ${DATABASE_ROOT}/ folder: other deployments use it.`,
        'Ask the tenant to remove the folder from those deployments; the move then happens on its own.',
        [...new Set(conflicts.map((c) => `${c.owner}: ${c.folder}`))], `database-folder-relocate-blocked:${row.id}`);
      return 'blocked';
    }
    // Nothing is stopped for a move that cannot happen.
    const precheck = await withPlatformFiles(deps.k8s, deps.kubeconfigPath, namespace, 'database-relocate', async (run) => {
      const can = await canMoveFolder(run, source, target);
      if (can.ok || can.reason === 'missing') return can;
      if (can.reason === 'exists') {
        const [src, dst] = await folderState(run, source, target);
        return src === 'dir' && dst === 'dir' ? { ok: true } as const : can;
      }
      return can;
    });
    if (!precheck.ok && precheck.reason !== 'missing') throw moveError(precheck, `Moving ${source}`, where);

    const wasRunning = row.status !== 'stopped' && row.status !== 'deleted';
    const replicas = row.replicaCount ?? 1;
    await deps.db.update(deployments)
      .set({ dataDetachedPath: source, dataDetachedAt: new Date() })
      .where(eq(deployments.id, row.id));
    const unmark = (): Promise<unknown> => deps.db.update(deployments).set({ dataDetachedPath: null, dataDetachedAt: null }).where(eq(deployments.id, row.id));
    let state: 'not-moved' | 'moved' | 'unknown' = 'not-moved';
    try {
      if (wasRunning) await control.stop();
      await waitForNoPods(deps.k8s, namespace, row.name);
      await deps.db.update(deployments).set({ storagePath: target, storageRelocatedFrom: source }).where(eq(deployments.id, row.id));
      await control.redeploy(0);
      state = 'unknown';
      await withPlatformFiles(deps.k8s, deps.kubeconfigPath, namespace, 'database-relocate', async (run) => {
        let out = await moveFolder(run, source, target, true);
        if (!out.ok && out.reason === 'exists') {
          const aside = await moveToKept(run, target, row.name);
          if (!aside.ok) { state = 'not-moved'; throw moveError(aside, 'Moving old data aside', where); }
          out = await moveFolder(run, source, target, true);
        }
        if (!out.ok && out.reason !== 'missing') {
          if (out.reason !== 'stranded') state = 'not-moved';
          throw moveError(out, `Moving ${source}`, where);
        }
        state = 'moved';
        if (out.ok) await prepareForStart(run, target, where);
      });
    } catch (err) {
      if (state === 'not-moved') {
        // The data never left the old folder: back as it was, running if it ran.
        await deps.db.update(deployments).set({ storagePath: source, storageRelocatedFrom: row.storageRelocatedFrom, dataDetachedPath: null, dataDetachedAt: null }).where(eq(deployments.id, row.id));
        await control.redeploy(wasRunning ? replicas : 0).catch(async (e: unknown) => {
          await notifyRelocation(deps.db, row, namespace,
            `Moving its data into the protected ${DATABASE_ROOT}/ folder failed, and it could not be started again on ${source}.`,
            'Start the instance; its data is still in its old folder.',
            [err instanceof Error ? err.message : String(err), e instanceof Error ? e.message : String(e)], `database-folder-relocate-stranded:${row.id}`);
        });
      } else {
        // Moved, or not known: the mark stays, so nothing starts it on the
        // wrong folder. Attach data (default: the old path) finishes the move
        // if it landed, or makes it if it did not.
        await notifyRelocation(deps.db, row, namespace,
          `Moving its data from ${source} into the protected ${DATABASE_ROOT}/ folder was interrupted. The instance is stopped, its data marked detached at ${source}.`,
          'Use Attach data on the instance (with no folder chosen): it finishes the move.',
          [err instanceof Error ? err.message : String(err)], `database-folder-relocate-interrupted:${row.id}`);
      }
      throw err;
    }
    await unmark();
    if (wasRunning) await control.redeploy(replicas);
    return 'moved';
  });
}

/**
 * Moves instances still on a custom or legacy path into the protected folder
 * — one restart each — and records the old path for older bundles. A folder
 * another deployment uses is left where it is and the operator is told; a
 * move that fails waits (one hour, doubling to a day) before the next try.
 */
export async function relocateDatabaseFolders(
  deps: DataDeps, controlFor: (row: DeploymentRow) => InstanceControl, limit = 1, now: () => number = Date.now,
): Promise<{ moved: number; blocked: number }> {
  let moved = 0;
  let blocked = 0;
  // More candidates than moves: a blocked or waiting one must not hold the
  // others back.
  for (const { row, code, namespace } of await rowsToRelocate(deps.db, 50)) {
    if (moved >= limit) break;
    if (!namespace || !row.storagePath) continue;
    if ((relocationBackoff.get(row.id)?.retryAt ?? 0) > now()) continue;
    try {
      const r = await relocateOne(deps, row.id, row.tenantId, code, namespace, controlFor(row));
      if (r === 'moved') {
        moved += 1;
        relocationBackoff.delete(row.id);
        console.log(`[database-folders] ${namespace}/${row.name}: data moved from ${row.storagePath} into the protected folder`);
      } else if (r === 'blocked') {
        blocked += 1;
      }
    } catch (err) {
      const failures = noteRelocationFailure(row.id, now());
      console.warn(`[database-folders] ${namespace}/${row.name}: moving ${row.storagePath} failed (try ${failures}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { moved, blocked };
}
