/**
 * Restore executor: `databases-by-id` (gap G4).
 *
 * Recovers a tenant's add-on database(s) from the per-database `.sql`
 * dump captured INSIDE the files snapshot (ADR-047). The pre-capture
 * hook (`tenant-bundles/components/database-predump.ts` →
 * `db-manager.ts:exportDatabaseToPvc`) dumps each database into the DB pod's
 * OWN storage subPath on the tenant PVC:
 *
 *     database/<engine>/<name>/predump-<db>-<bundleId>.sql   (standalone DB)
 *
 * (exportDatabaseToPvc TRIES to move it to a shared `exports/` dir but that move
 * is a silent no-op for DBs — the pre-dump hook passes the wrong subPath — so the
 * dump stays put; it is captured by the files component in place and persists on
 * the live PVC). This executor therefore `find`s the dump wherever it is and
 * imports it back into the RUNNING database pod via the existing SQL-Manager
 * primitive `importSqlFromPvcFile` — the dump already sits in the DB pod's mount,
 * so it is referenced directly. It does NOT re-invent the mysql/psql import path.
 *
 * Dump→bundle pinning: the pre-dump uses the backup job id as its
 * `backupId`, and `restore_items.bundle_id` IS that same backup job id,
 * so the dump filename is deterministic: `predump-<db>-<bundleId>.sql`.
 * We therefore match dumps for EXACTLY this bundle (a `files-paths`
 * restore is a non-deleting `cp -a` overlay, so the PVC may also carry
 * predumps from OTHER bundles — matching on the bundle id restores the
 * point-in-time dump the operator chose, never a stray newer one).
 *
 * Failure semantics (per the gap G4 brief):
 *   - DB workload not running  → graceful SKIP (common on a freshly
 *                                rebuilt cluster where the DB deployment
 *                                was not re-deployed yet). NOT a failure.
 *   - no dump on the PVC       → graceful SKIP.
 *   - genuine import ERROR     → the item FAILS.
 *
 * Selector shapes (per api-contracts/restore.ts):
 *   { kind: 'all' }                     → every database deployment of the tenant
 *   { kind: 'ids', deploymentIds: […] } → the given deployments (each validated
 *                                         to belong to the tenant AND be a
 *                                         `type='database'` catalog deployment)
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import {
  databasesSelectorSchema,
  type DatabasesSelector,
} from '@insula/api-contracts';
import type { BackupStore } from '../../tenant-bundles/bundle-store.js';
import {
  restoreItems,
  restoreJobs,
  tenants,
  deployments,
  catalogEntries,
  backupComponents,
  type RestoreItem,
} from '../../../db/schema.js';
import { ApiError } from '../../../shared/errors.js';
import { createK8sClients, type K8sClients } from '../../k8s-provisioner/k8s-client.js';
import {
  buildDbContext,
  listDatabases,
  importSqlFromPvcFile,
  importMongoArchiveFromPvcFile,
  type DbManagerContext,
} from '../../deployments/db-manager.js';
import { getReadyFileManagerPod } from '../../file-manager/service.js';
import { execInPod } from '../../../shared/k8s-exec.js';
import { buildFilesPathsJobSpec, findNodeAttachingPvc, waitForJob } from './files-paths.js';
import { resolveShimBackupTarget } from '../../tenant-bundles/resolve-backup-target.js';
import { buildResticRepoUri, buildResticEnv, deriveResticPassword } from '../../tenant-bundles/restic-driver.js';
import {
  FILES_CAPTURE_ROOT,
  buildResticCredsStringData,
  createResticCredsSecret,
  wireSecretOwnerRef,
} from '../../tenant-bundles/components/files.js';

const TOOLS_IMAGE_DEFAULT = 'ghcr.io/insulahq/insula/tenant-backup-tools:latest';
const RESTIC_SNAPSHOT_ID_RE = /^[0-9a-f]{8,64}$/;

const DUMP_PREFIX = 'predump-';
/** progress_message column is varchar(500). */
const PROGRESS_MAX = 500;

// ─── Domain types ────────────────────────────────────────────────────────────

/** Minimal projection of a database deployment the executor acts on. */
export interface TargetDeployment {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly catalogCode: string;
  readonly catalogRuntime: string | null;
  readonly configuration: Record<string, unknown> | null;
  /** PVC subPath = the DB's on-disk datadir; where its predump is captured. */
  readonly storagePath: string | null;
}

/** A requested deployment row (kind:'ids' validation input). */
export interface RequestedDeploymentRow {
  readonly tenantId: string;
  readonly catalogType: string | null;
  readonly deployment: TargetDeployment;
}

export interface DeploymentOutcome {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly status: 'imported' | 'skipped' | 'failed';
  /** Real database names imported successfully. */
  readonly imported: readonly string[];
  /** Human-readable skip reasons (workload down / no dump / no target db). */
  readonly skipped: readonly string[];
  /** Databases whose import command failed. */
  readonly failed: readonly { readonly database: string; readonly error: string }[];
}

export interface DatabasesRestoreSummary {
  readonly deployments: readonly DeploymentOutcome[];
  readonly totalImported: number;
  readonly totalSkipped: number;
  readonly totalFailed: number;
}

/**
 * Injected side-effect surface. `Ctx` is the per-deployment DB context
 * threaded from `buildDbContext` into the other calls (opaque to the
 * orchestration — mirrors `database-predump.ts` so tests can stub the
 * k8s exec without a live cluster).
 */
export interface DatabasesRestoreDeps<Ctx> {
  /** Build the DB pod/creds context. MUST throw a POD_NOT_FOUND ApiError when the pod is not running. */
  readonly buildDbContext: (dep: TargetDeployment) => Promise<Ctx>;
  /** List filenames directly under `databases/<deploymentName>/` on the PVC. */
  readonly listDumpFiles: (ctx: Ctx, deploymentName: string) => Promise<readonly string[]>;
  /** List the (user) database names currently present in the pod. */
  readonly listDatabaseNames: (ctx: Ctx) => Promise<readonly string[]>;
  /** Import a `.sql` file (PVC-relative) into `database`. */
  readonly importSql: (
    ctx: Ctx,
    database: string,
    filePath: string,
    deploymentSubPath: string,
  ) => Promise<{ readonly success: boolean; readonly error?: string }>;
  /**
   * Restore a MongoDB `.archive.gz` dump (mongorestore --archive --drop).
   * No db-name argument — the archive carries its own namespaces and
   * mongorestore recreates the collections, so the target db need NOT
   * currently exist. Optional so unit tests + SQL-only call sites can omit it.
   */
  readonly importMongoArchive?: (
    ctx: Ctx,
    filePath: string,
    deploymentSubPath: string,
  ) => Promise<{ readonly success: boolean; readonly error?: string }>;
}

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────

/**
 * Replicate the pre-dump filename char-sanitisation so a database name
 * maps to the same token the capture wrote. `database-predump.ts`
 * applies this to the whole filename; only the `<db>` segment can hold
 * chars outside the allowlist (the literal parts + the `bkp-<uuid>`
 * bundle id are already safe), so sanitising the name alone is faithful.
 */
export function sanitizeDumpName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Last path segment (filename) of a PVC-relative path. */
export function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Parent directory (PVC-relative) of a path; '' when top-level. */
export function dirName(p: string): string {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '';
}

/** Narrow: was the DB context build rejected because the pod is not running? */
export function isPodNotRunning(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'POD_NOT_FOUND') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /no running pod/i.test(message);
}

/**
 * Resolve the selector to the concrete set of database deployments.
 *
 * - `kind: 'all'` → every database deployment already fetched for the tenant.
 * - `kind: 'ids'` → each requested id, validated against `requestedById`:
 *     missing / foreign tenant → 404; non-database catalog type → 400.
 */
export function selectTargetDeployments(
  selector: DatabasesSelector,
  tenantId: string,
  tenantDbDeployments: readonly TargetDeployment[],
  requestedById: ReadonlyMap<string, RequestedDeploymentRow>,
): TargetDeployment[] {
  if (selector.kind === 'all') {
    return [...tenantDbDeployments];
  }
  const out: TargetDeployment[] = [];
  for (const id of selector.deploymentIds) {
    const row = requestedById.get(id);
    if (!row || row.tenantId !== tenantId) {
      throw new ApiError(
        'DEPLOYMENT_NOT_FOUND',
        `Deployment '${id}' not found for this tenant`,
        404,
        { deployment_id: id },
        'Pick a database deployment that belongs to this tenant.',
      );
    }
    if (row.catalogType !== 'database') {
      throw new ApiError(
        'VALIDATION_ERROR',
        `Deployment '${id}' is not a database deployment`,
        400,
        { deployment_id: id, type: row.catalogType },
        'databases-by-id only restores catalog deployments whose entry type is "database".',
      );
    }
    out.push(row.deployment);
  }
  return out;
}

/**
 * Import every captured dump for this bundle back into each target
 * deployment's running DB pod. Never throws for a down workload or a
 * missing dump — those are recorded as skips. Genuine import failures
 * are recorded per-database (the caller decides how to surface them).
 */
export async function restoreDatabasesForDeployments<Ctx>(
  targets: readonly TargetDeployment[],
  bundleId: string,
  deps: DatabasesRestoreDeps<Ctx>,
  onProgress?: (msg: string) => void | Promise<void>,
): Promise<DatabasesRestoreSummary> {
  // SQL engines dump `predump-<db>-<bundleId>.sql`; MongoDB dumps
  // `predump-<db>-<bundleId>.archive.gz`. Match either.
  const sqlSuffix = `-${bundleId}.sql`;
  const mongoSuffix = `-${bundleId}.archive.gz`;
  const outcomes: DeploymentOutcome[] = [];

  for (const dep of targets) {
    if (onProgress) await onProgress(`restoring databases for ${dep.deploymentName}…`);

    // 1. DB context — a not-running pod is a graceful skip, not a failure.
    let ctx: Ctx;
    try {
      ctx = await deps.buildDbContext(dep);
    } catch (err) {
      if (isPodNotRunning(err)) {
        outcomes.push(skippedOutcome(
          dep,
          `skipped ${dep.deploymentName}: database workload not running (re-deploy it first, then re-run this restore)`,
        ));
        continue;
      }
      throw err;
    }

    // 2. Dumps for THIS bundle (PVC-relative paths). The DB predump lands in
    // the DB pod's OWN storage subPath — e.g.
    // database/<engine>/<name>/predump-<db>-<bundleId>.sql — NOT a shared
    // exports/ dir (exportDatabaseToPvc's move to exports/ is a silent no-op
    // for DBs because the pre-dump hook passes the wrong subPath). So we LOCATE
    // the dump by name wherever it is and import it in place.
    const paths = await deps.listDumpFiles(ctx, dep.deploymentName);
    const bundleDumps = paths.filter((p) => {
      const b = baseName(p);
      if (!b.startsWith(DUMP_PREFIX)) return false;
      return (b.endsWith(sqlSuffix) && b.length > DUMP_PREFIX.length + sqlSuffix.length)
        || (b.endsWith(mongoSuffix) && b.length > DUMP_PREFIX.length + mongoSuffix.length);
    });
    if (bundleDumps.length === 0) {
      outcomes.push(skippedOutcome(
        dep,
        `skipped ${dep.deploymentName}: no database dump found on the PVC for this bundle (expected ${DUMP_PREFIX}*${sqlSuffix} or ${DUMP_PREFIX}*${mongoSuffix})`,
      ));
      continue;
    }

    // 3. Map sanitised → real database name(s) for the currently-present dbs.
    // Keep ALL reals per key so a collision (two live db names that sanitise
    // to the same token, e.g. "my db" and "my_db") is DETECTED — importing a
    // dump into an arbitrarily-chosen one would corrupt the wrong database.
    const bySanitized = new Map<string, string[]>();
    for (const name of await deps.listDatabaseNames(ctx)) {
      const key = sanitizeDumpName(name);
      const reals = bySanitized.get(key) ?? [];
      reals.push(name);
      bySanitized.set(key, reals);
    }

    // 4. Import each dump into its target database (import errors fail). The
    // predump sits in the DB pod's OWN mount subPath, so importSqlFromPvcFile
    // references it directly: source = the predump's full PVC path, target
    // subPath = its parent dir (= the DB's mount).
    const imported: string[] = [];
    const skipped: string[] = [];
    const failed: { database: string; error: string }[] = [];

    // Segregate dumps by engine class. All of a tenant's DB engines share the
    // ONE tenant PVC, so the (global) dump search returns SIBLING deployments'
    // dumps too. Restoring a mongo `.archive.gz` with a SQL context (or a
    // `.sql` with a mongo context) throws UNSUPPORTED_ENGINE. Only restore
    // dumps whose file type matches THIS deployment's engine; the rest belong
    // to sibling deployments and are restored under their own target. (Caught
    // by the multi-engine E2E on DEV 2026-07-07.)
    const depIsMongo = /mongo/i.test(dep.catalogRuntime ?? dep.catalogCode ?? '');

    for (const p of bundleDumps) {
      const b = baseName(p);
      const isMongo = b.endsWith(mongoSuffix);
      const thisSuffix = isMongo ? mongoSuffix : sqlSuffix;
      const sanitizedDb = b.slice(DUMP_PREFIX.length, b.length - thisSuffix.length);

      // Skip a dump whose engine class doesn't match this deployment — it
      // belongs to a sibling deployment sharing the PVC.
      if (isMongo !== depIsMongo) {
        continue;
      }

      // MongoDB: mongorestore recreates the archive's namespaces, so the
      // target db need NOT currently exist — restore unconditionally.
      if (isMongo) {
        if (!deps.importMongoArchive) {
          skipped.push(`mongo dump '${sanitizedDb}' in ${dep.deploymentName} skipped — mongorestore path unavailable in this executor`);
          continue;
        }
        const res = await deps.importMongoArchive(ctx, p, dirName(p));
        if (res.success) imported.push(sanitizedDb);
        else failed.push({ database: sanitizedDb, error: res.error ?? 'mongorestore failed' });
        continue;
      }

      const reals = bySanitized.get(sanitizedDb) ?? [];
      if (reals.length === 0) {
        skipped.push(`database '${sanitizedDb}' not present in ${dep.deploymentName} (skipped — recreate it, then re-run this restore)`);
        continue;
      }
      if (reals.length > 1) {
        // Ambiguous — importing into an arbitrary match could corrupt the
        // wrong database. Skip and tell the operator to disambiguate.
        skipped.push(`dump '${sanitizedDb}' maps to ${reals.length} live databases in ${dep.deploymentName} (${reals.join(', ')}) — skipped to avoid importing into the wrong one; rename to disambiguate, then re-run`);
        continue;
      }
      const realDb = reals[0]!;
      const res = await deps.importSql(ctx, realDb, p, dirName(p));
      if (res.success) {
        imported.push(realDb);
      } else {
        failed.push({ database: realDb, error: res.error ?? 'import command failed' });
      }
    }

    const status: DeploymentOutcome['status'] = failed.length > 0
      ? 'failed'
      : imported.length > 0
        ? 'imported'
        : 'skipped';
    outcomes.push({
      deploymentId: dep.deploymentId,
      deploymentName: dep.deploymentName,
      status,
      imported,
      skipped,
      failed,
    });
  }

  return summarise(outcomes);
}

function skippedOutcome(dep: TargetDeployment, reason: string): DeploymentOutcome {
  return {
    deploymentId: dep.deploymentId,
    deploymentName: dep.deploymentName,
    status: 'skipped',
    imported: [],
    skipped: [reason],
    failed: [],
  };
}

function summarise(outcomes: readonly DeploymentOutcome[]): DatabasesRestoreSummary {
  let totalImported = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  for (const o of outcomes) {
    totalImported += o.imported.length;
    totalSkipped += o.skipped.length;
    totalFailed += o.failed.length;
  }
  return { deployments: outcomes, totalImported, totalSkipped, totalFailed };
}

/** One-line, ≤500-char honest summary for the item's progress_message. */
export function formatSummary(summary: DatabasesRestoreSummary): string {
  const parts = summary.deployments.map((d) => {
    if (d.status === 'imported') {
      const extra = d.skipped.length > 0 ? `, ${d.skipped.length} skipped` : '';
      return `${d.deploymentName}: imported ${d.imported.length} db(s)${extra}`;
    }
    if (d.status === 'failed') {
      return `${d.deploymentName}: FAILED ${d.failed.length} import(s)${d.imported.length ? ` (${d.imported.length} ok)` : ''}`;
    }
    return d.skipped[0] ?? `${d.deploymentName}: skipped`;
  });
  const head = `databases restore — imported ${summary.totalImported}, skipped ${summary.totalSkipped}, failed ${summary.totalFailed}`;
  return `${head}: ${parts.join('; ')}`.slice(0, PROGRESS_MAX);
}

// ─── Executor entrypoint ─────────────────────────────────────────────────────

export async function execDatabasesByIdItem(args: {
  app: FastifyInstance;
  item: RestoreItem;
  store?: BackupStore;
}): Promise<void> {
  const { app, item } = args;

  // Zod at the boundary — the item selector was validated on add, but
  // re-parse here to get a typed value the executor can trust.
  const parsed = databasesSelectorSchema.safeParse(item.selector);
  if (!parsed.success) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `databases-by-id: invalid selector — ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      400,
    );
  }
  const selector = parsed.data;

  // Resolve tenant → namespace (mirrors files-paths).
  const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, item.restoreJobId)).limit(1);
  if (!job) throw new ApiError('NOT_FOUND', `Restore job ${item.restoreJobId} not found`, 404);
  const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, job.tenantId)).limit(1);
  if (!tenant) throw new ApiError('NOT_FOUND', `Tenant ${job.tenantId} not found`, 404);
  const namespace = tenant.kubernetesNamespace;
  if (!namespace) throw new ApiError('CONFIG_INVALID', `Tenant ${job.tenantId} has no kubernetes_namespace`, 400);

  const targets = await resolveTargetDeployments(app, job.tenantId, selector);
  if (targets.length === 0) {
    await setProgress(app, item, 'databases restore — no database deployments to restore');
    return;
  }

  const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined
    ?? process.env.KUBECONFIG_PATH ?? process.env.KUBECONFIG;
  const k8s: K8sClients = createK8sClients(kubeconfigPath);

  const deps: DatabasesRestoreDeps<DbManagerContext> = {
    buildDbContext: (dep) => buildDbContext(
      k8s,
      kubeconfigPath,
      namespace,
      dep.deploymentName,
      { runtime: dep.catalogRuntime, code: dep.catalogCode },
      dep.configuration ?? {},
    ),
    listDumpFiles: (_ctx, deploymentName) => listPredumpFiles(k8s, kubeconfigPath, namespace, deploymentName),
    listDatabaseNames: async (ctx) => (await listDatabases(ctx)).map((d) => d.name),
    importSql: async (ctx, database, filePath, deploymentSubPath) => {
      const result = await importSqlFromPvcFile(ctx, database, '', filePath, deploymentSubPath);
      return { success: result.success, error: result.error };
    },
    importMongoArchive: async (ctx, filePath, deploymentSubPath) => {
      const result = await importMongoArchiveFromPvcFile(ctx, filePath, deploymentSubPath);
      return { success: result.success, error: result.error };
    },
  };

  // Snapshot-restore: predumps no longer persist on the live PVC (capture
  // deletes them after the files snapshot to keep the tenant PVC footprint at
  // ~0 — a 2-5 GB PVC can't hold a retention window of full dumps). Fetch this
  // bundle's predumps back from the files restic snapshot into each DB's
  // datadir BEFORE the import. Safe on the running DB (restores a single dump
  // FILE, not the datadir). Best-effort: on an old bundle whose predump is
  // still on the PVC, or a restic hiccup, we fall through to the live-PVC find.
  await fetchPredumpsFromSnapshot({
    app,
    k8s,
    kubeconfigPath,
    namespace,
    tenantId: job.tenantId,
    bundleId: item.bundleId,
    storagePaths: targets.map((t) => t.storagePath).filter((s): s is string => Boolean(s)),
    cartId: item.restoreJobId,
    itemId: item.id,
  }).catch(async (err) => {
    await setProgress(app, item, `predump snapshot fetch fell back to live PVC: ${(err as Error).message.slice(0, 180)}`);
  });

  const summary = await restoreDatabasesForDeployments(
    targets,
    item.bundleId,
    deps,
    (msg) => setProgress(app, item, msg),
  );

  await setProgress(app, item, formatSummary(summary));

  if (summary.totalFailed > 0) {
    // Progress message already carries the per-deployment breakdown.
    throw new ApiError(
      'DB_RESTORE_IMPORT_FAILED',
      `database restore had ${summary.totalFailed} import failure(s)`,
      500,
      { imported: summary.totalImported, skipped: summary.totalSkipped, failed: summary.totalFailed },
    );
  }
}

// ─── DB + k8s I/O (thin; the logic above is pure/injected) ────────────────────

async function resolveTargetDeployments(
  app: FastifyInstance,
  tenantId: string,
  selector: DatabasesSelector,
): Promise<TargetDeployment[]> {
  if (selector.kind === 'all') {
    const rows = await app.db
      .select({
        deploymentId: deployments.id,
        deploymentName: deployments.name,
        configuration: deployments.configuration,
        storagePath: deployments.storagePath,
        catalogCode: catalogEntries.code,
        catalogRuntime: catalogEntries.runtime,
      })
      .from(deployments)
      .innerJoin(catalogEntries, eq(deployments.catalogEntryId, catalogEntries.id))
      .where(and(eq(deployments.tenantId, tenantId), eq(catalogEntries.type, 'database')));
    const tenantDbDeployments: TargetDeployment[] = rows.map((r) => ({
      deploymentId: r.deploymentId,
      deploymentName: r.deploymentName,
      catalogCode: r.catalogCode,
      catalogRuntime: r.catalogRuntime,
      configuration: r.configuration,
      storagePath: r.storagePath,
    }));
    return selectTargetDeployments(selector, tenantId, tenantDbDeployments, new Map());
  }

  // kind === 'ids' — fetch requested deployments (any tenant / any type) so
  // we can return a clear 404 (foreign/missing) vs 400 (not a database).
  const rows = await app.db
    .select({
      deploymentId: deployments.id,
      deploymentName: deployments.name,
      configuration: deployments.configuration,
      storagePath: deployments.storagePath,
      deploymentTenantId: deployments.tenantId,
      catalogCode: catalogEntries.code,
      catalogRuntime: catalogEntries.runtime,
      catalogType: catalogEntries.type,
    })
    .from(deployments)
    .leftJoin(catalogEntries, eq(deployments.catalogEntryId, catalogEntries.id))
    .where(inArray(deployments.id, [...selector.deploymentIds]));

  const requestedById = new Map<string, RequestedDeploymentRow>();
  for (const r of rows) {
    requestedById.set(r.deploymentId, {
      tenantId: r.deploymentTenantId,
      catalogType: r.catalogType ?? null,
      deployment: {
        deploymentId: r.deploymentId,
        deploymentName: r.deploymentName,
        catalogCode: r.catalogCode ?? '',
        catalogRuntime: r.catalogRuntime ?? null,
        configuration: r.configuration,
        storagePath: r.storagePath,
      },
    });
  }
  return selectTargetDeployments(selector, tenantId, [], requestedById);
}

/**
 * Fetch this bundle's predumps back from the files restic snapshot into each DB
 * deployment's datadir on the live PVC. Predumps are deleted from the live PVC
 * after capture (to keep the tenant PVC footprint at ~0 — a 2-5 GB PVC can't
 * hold a retention window of full dumps), so restore must re-materialise them.
 * Spawns ONE files-restore Job scoped to the predump paths (reusing
 * buildFilesPathsJobSpec): the `cp -a` overlay lands each predump at
 * `/source/<storagePath>/predump-…`, i.e. the DB pod's data dir, where the
 * import step then finds it. Restoring a single dump FILE onto a running DB is
 * safe (unlike a datadir overlay — no quiesce needed). Idempotent.
 */
async function fetchPredumpsFromSnapshot(args: {
  app: FastifyInstance;
  k8s: K8sClients;
  kubeconfigPath?: string;
  namespace: string;
  tenantId: string;
  bundleId: string;
  storagePaths: readonly string[];
  cartId: string;
  itemId: string;
}): Promise<void> {
  const { app, k8s, namespace, tenantId, bundleId } = args;
  const storagePaths = [...new Set(
    args.storagePaths.map((s) => s.replace(/^\/+/, '').replace(/\/+$/, '')).filter(Boolean),
  )];
  if (storagePaths.length === 0) return;

  // Resolve the files restic snapshot id for this bundle (same source files-paths reads).
  const [comp] = await app.db.select().from(backupComponents)
    .where(and(eq(backupComponents.backupJobId, bundleId), eq(backupComponents.component, 'files')))
    .limit(1);
  if (!comp?.sha256 || !RESTIC_SNAPSHOT_ID_RE.test(comp.sha256)) return; // no files snapshot → nothing to fetch

  const secretsKeyHex = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!secretsKeyHex) throw new ApiError('CONFIG_INVALID', 'PLATFORM_ENCRYPTION_KEY not configured', 500);

  const target = await resolveShimBackupTarget(k8s.core, 'tenant', app.log);
  const passwordHex = deriveResticPassword(secretsKeyHex, tenantId);
  const repoUri = buildResticRepoUri(target, tenantId, 'files');
  const env = buildResticEnv(target);

  // Include this bundle's predump files in each DB's datadir. restic --include
  // supports the `*` glob (matches the `<db>` segment).
  const includePaths = storagePaths.flatMap((sp) => [
    `${FILES_CAPTURE_ROOT}/${sp}/predump-*-${bundleId}.sql`,
    `${FILES_CAPTURE_ROOT}/${sp}/predump-*-${bundleId}.archive.gz`,
  ]);

  const safe = bundleId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 40);
  const jobName = `rs-dbpd-${safe}`.slice(0, 63);
  const credsSecretName = `rs-dbpd-creds-${safe}`.slice(0, 63);
  const pvcName = `${namespace}-storage`;
  const pinToNode = await findNodeAttachingPvc(k8s, namespace, pvcName);

  let credsCreated = false;
  let ownerRefWired = false;
  try {
    await createResticCredsSecret(k8s, namespace, credsSecretName,
      buildResticCredsStringData({ passwordHex, repoUri, env }), 'restore-files');
    credsCreated = true;

    const spec = buildFilesPathsJobSpec({
      jobName, namespace, pvcName, tenantId, cartId: args.cartId, itemId: args.itemId,
      credsSecretName, snapshotId: comp.sha256, includePaths,
      jobImage: TOOLS_IMAGE_DEFAULT, pinToNode, activeDeadlineSeconds: 10 * 60,
    });
    const createdJob = await (k8s.batch as unknown as {
      createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<{ metadata?: { uid?: string } }>;
    }).createNamespacedJob({ namespace, body: spec });
    const jobUid = createdJob.metadata?.uid;
    if (jobUid) {
      try { await wireSecretOwnerRef(k8s, namespace, credsSecretName, jobName, jobUid); ownerRefWired = true; }
      catch { /* creds GC via the finally-delete */ }
    }
    await waitForJob(k8s, namespace, jobName, 10 * 60 * 1000);
    try {
      await (k8s.batch as unknown as {
        deleteNamespacedJob: (a: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
      }).deleteNamespacedJob({ name: jobName, namespace, propagationPolicy: 'Background' });
    } catch { /* ttl GC backstop */ }
  } finally {
    if (credsCreated && !ownerRefWired) {
      try {
        await (k8s.core as unknown as {
          deleteNamespacedSecret: (a: { name: string; namespace: string }) => Promise<unknown>;
        }).deleteNamespacedSecret({ name: credsSecretName, namespace });
      } catch { /* best-effort */ }
    }
  }
}

/**
 * Locate predump files ANYWHERE under the tenant PVC (mounted at `/data` in the
 * file-manager pod) and return their PVC-relative paths. Predumps land in each
 * database's own storage subPath (e.g. `database/<engine>/<name>/predump-*.sql`),
 * which varies by deployment, so a `find` by name is more robust than assuming a
 * fixed dir; the caller filters by the `-<bundleId>.sql` suffix, maps each dump's
 * db-name to the deployment's live databases, and imports each in place.
 * `deploymentName` is unused (kept for the dep-scoped signature). No match →
 * `[]` — never throws. `find` runs as a bare argv (no shell).
 */
async function listPredumpFiles(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  _deploymentName: string,
): Promise<string[]> {
  const fmPod = await getReadyFileManagerPod(k8s, namespace);
  const res = await execInPod(kubeconfigPath, namespace, fmPod, 'file-manager',
    ['find', '/data', '-type', 'f', '(', '-name', 'predump-*.sql', '-o', '-name', 'predump-*.archive.gz', ')']);
  if (res.exitCode !== 0) return [];
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    .map((p) => p.replace(/^\/data\//, ''));
}

async function setProgress(app: FastifyInstance, item: RestoreItem, msg: string): Promise<void> {
  await app.db.update(restoreItems)
    .set({ progressMessage: msg.slice(0, PROGRESS_MAX) })
    .where(eq(restoreItems.id, item.id));
}
