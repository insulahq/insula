/**
 * Keeps every tenant database instance's logins in their target shape.
 *
 * For each running deployment with a database component:
 *   1. the platform's administrator login (db-admin-access.ts) — socket-only
 *      root, trust, or a pod-local Mongo root — converted from the old
 *      password login the first time, and checked from then on. An app
 *      stack's is only checked: its app may log in as root.
 *   2. on a standalone instance, the tenant's administrator account
 *      (tenant-admin.ts), created with a password the platform keeps, set back
 *      when it drifts; and, on the first check, in every new pod and then
 *      daily, a pass over what the tenant could have left while it held root
 *      (*-hardening.ts) — for MongoDB starting with root's password, which the
 *      tenant knew. The panel shows the account once both have run.
 * A full check runs hourly; the ticks between only prove both logins still
 * work, and fall back to a full check when one does not. The result lands in
 * database_admin_state (db-admin-state.ts). An instance whose administrator
 * login the platform has lost — for five minutes, not the seconds of a
 * restart — or that has not answered for an hour is announced once per
 * incident, listing every such instance, and its recovery once. The repair
 * for a lost login is POST /admin/deployments/:id/repair-database-access, a
 * redeploy whose reset container restores the login at start.
 *
 * Runs on one replica (scheduler lease), at start and every ten minutes, four
 * instances at a time, each within a time limit; a new instance is also
 * handled as soon as it is first seen running (reconcileDatabaseAdminFor), at
 * most every 30 s per instance.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { catalogEntries, databaseAdminState, deployments, tenants } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';
import { safeTick } from '../../shared/safe-tick.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { decrypt, encrypt } from '../oidc/crypto.js';
import { buildDbContext, execInDbPod, type DbManagerContext, type Engine } from './db-manager.js';
import { adminLoginWorks, ensureDatabaseAdminAccess, type AdminAccessMode } from './db-admin-access.js';
import type { DbCommandRunner } from './db-exec.js';
import { chooseTenantAdminUsername, ensureTenantAdmin, tenantAdminLogsIn } from './tenant-admin.js';
import {
  loadTenantAdminAccount, markTenantAdminReady, newTenantAdminPassword, recordFirstTenantAdminAccount, tenantAdminReady,
} from './tenant-admin-store.js';
import { rootLogsInWith, rotateRoot } from './mongo-hardening.js';
import { getTenantNamespace, parseJsonField, redeployWithCurrentConfig } from './service.js';
import {
  DATABASE_ADMIN_TICK_MS, HARDEN_INTERVAL_MS, incidentReason, incidentTransition, LOGGED_IN_MODES, ON_DEMAND_MIN_INTERVAL_MS,
  SHAPE_INTERVAL_MS, stateValuesFor, TARGET_MODES,
  type DatabaseAdminStateMode, type InstanceOutcome, type ManagedDatabase, type StateRow, type StateValues,
} from './db-admin-state.js';

export {
  DATABASE_ADMIN_TICK_MS, HARDEN_INTERVAL_MS, incidentTransition, LOCKOUT_ALERT_AFTER_MS, ON_DEMAND_MIN_INTERVAL_MS, SHAPE_INTERVAL_MS,
  stateValuesFor, UNREACHABLE_ALERT_AFTER_MS,
} from './db-admin-state.js';
export type { DatabaseAdminStateMode, InstanceOutcome, ManagedDatabase } from './db-admin-state.js';

/** Instances checked at once. */
const CONCURRENCY = 4;
/** One instance gets this long; a hung exec must not hold up every other tenant. */
const INSTANCE_TIME_LIMIT_MS = 5 * 60 * 1000;
/** Each command in the pod is killed after this (coreutils `timeout`): a hung one must end, not linger. */
const COMMAND_TIME_LIMIT_S = 300;

/** execInDbPod, each command under `timeout`. */
const runWithTimeLimit: DbCommandRunner = (ctx, argv, stdin) => execInDbPod(ctx, ['timeout', String(COMMAND_TIME_LIMIT_S), ...argv], stdin);

const ENGINES: ReadonlySet<string> = new Set(['mariadb', 'mysql', 'postgresql', 'mongodb']);

/** Running deployments with a database component the SQL Manager can manage. */
export async function listManagedDatabases(db: Database, deploymentId?: string): Promise<ManagedDatabase[]> {
  const rows = await db
    .select({ d: deployments, e: catalogEntries, tenantName: tenants.name })
    .from(deployments)
    .innerJoin(catalogEntries, eq(catalogEntries.id, deployments.catalogEntryId))
    .innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(and(
      eq(deployments.status, 'running'),
      ne(tenants.status, 'archived'),
      ...(deploymentId ? [eq(deployments.id, deploymentId)] : []),
    ));
  const out: ManagedDatabase[] = [];
  for (const { d, e, tenantName } of rows) {
    const components = parseJsonField<Array<{ name: string; database?: string }>>(e.components) ?? [];
    const dbc = components.find((c) => typeof c.database === 'string' && ENGINES.has(c.database));
    if (!dbc?.database) continue;
    out.push({
      deploymentId: d.id,
      deploymentName: d.name,
      tenantId: d.tenantId,
      tenantName,
      engine: dbc.database as Engine,
      componentName: dbc.name,
      standalone: e.type === 'database',
      entry: e,
      configuration: parseJsonField<Record<string, unknown>>(d.configuration) ?? {},
      extraMountCount: Array.isArray(d.extraMounts) ? d.extraMounts.length : 0,
    });
  }
  return out;
}

export interface ReconcileDeps {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly kubeconfigPath?: string;
  readonly encryptionKey: string;
  /** Injected in tests; execInDbPod otherwise. */
  readonly run?: DbCommandRunner;
  readonly now?: () => Date;
}

/** MongoDB: the configuration now carries `password` for root (a JSON update, so a concurrent edit keeps its other keys). */
async function persistMongoRootPassword(db: Database, deploymentId: string, password: string): Promise<void> {
  await db.update(deployments)
    .set({ configuration: sql`jsonb_set(coalesce(${deployments.configuration}, '{}'::jsonb), '{MONGO_INITDB_ROOT_PASSWORD}', to_jsonb(${password}::text))` })
    .where(eq(deployments.id, deploymentId));
}

/**
 * MongoDB after a rotation: if root no longer takes the configured password
 * but takes the one the platform set (a deployment edit raced the save), put
 * that one back. Returns the context to go on with.
 */
async function recoverMongoRoot(deps: ReconcileDeps, md: ManagedDatabase, ctx: DbManagerContext, prev: StateRow | undefined, run: DbCommandRunner, changes: string[]): Promise<DbManagerContext> {
  if (md.engine !== 'mongodb' || !prev?.rootSecretCipher) return ctx;
  const secret = decrypt(prev.rootSecretCipher, deps.encryptionKey);
  const x = { ctx, run };
  if (secret === ctx.rootPassword || (await rootLogsInWith(x, ctx.rootPassword)) || !(await rootLogsInWith(x, secret))) return ctx;
  await persistMongoRootPassword(deps.db, md.deploymentId, secret);
  changes.push("put root's password back into the configuration");
  return { ...ctx, rootPassword: secret };
}

/**
 * Replace the password the tenant knew. The new one is kept BEFORE it is set,
 * so a failure in between never loses it — and a candidate kept by an earlier
 * try that did not finish is the one set again, never replaced by another.
 */
async function rotateMongoRoot(deps: ReconcileDeps, md: ManagedDatabase, ctx: DbManagerContext, prev: StateRow | undefined, run: DbCommandRunner): Promise<DbManagerContext | null> {
  const pending = prev?.rootSecretCipher ? decrypt(prev.rootSecretCipher, deps.encryptionKey) : null;
  const next = pending && pending !== ctx.rootPassword ? pending : newTenantAdminPassword();
  const rootSecretCipher = next === pending ? prev!.rootSecretCipher! : encrypt(next, deps.encryptionKey);
  await deps.db.insert(databaseAdminState)
    .values({ deploymentId: md.deploymentId, tenantId: md.tenantId, engine: md.engine, mode: 'restricted', rootSecretCipher })
    .onConflictDoUpdate({ target: databaseAdminState.deploymentId, set: { rootSecretCipher } });
  if (!(await rotateRoot({ ctx, run }, next))) return null;
  await persistMongoRootPassword(deps.db, md.deploymentId, next);
  return { ...ctx, rootPassword: next };
}

/**
 * Between two full checks: do both logins still work? One command each. Null
 * when a full check is due anyway.
 */
async function quickCheck(deps: ReconcileDeps, md: ManagedDatabase, ctx: DbManagerContext, prev: StateRow | undefined, now: Date, run: DbCommandRunner): Promise<InstanceOutcome | null> {
  if (!prev?.shapedAt || now.getTime() - prev.shapedAt.getTime() >= SHAPE_INTERVAL_MS) return null;
  const mode = prev.mode as DatabaseAdminStateMode;
  if (!LOGGED_IN_MODES.has(mode)) return null;
  if (md.standalone) {
    // A new pod is hardened at once: it may be a restore of an older data directory.
    if (TARGET_MODES.has(mode) && prev.hardenedPod !== ctx.podName) return null;
    if (!(await tenantAdminReady(deps.db, md.deploymentId))) return null;
    const account = await loadTenantAdminAccount(deps.db, md.deploymentId, deps.encryptionKey);
    if (!account || !(await tenantAdminLogsIn(ctx, account, run))) return null;
  }
  if (!(await adminLoginWorks(ctx, mode as AdminAccessMode, run))) return null;
  return { md, mode, changes: [], detail: prev.detail ?? undefined, pod: ctx.podName };
}

/**
 * A standalone instance stored with extra mounts (from before they were refused): a
 * folder of the tenant's over /usr/local/bin is its code running as the
 * container's root. Cleared, and the instance redeployed without them — it
 * restarts once.
 */
async function dropExtraMounts(deps: ReconcileDeps, md: ManagedDatabase): Promise<InstanceOutcome> {
  // The redeploy first (a database instance's render leaves extra mounts out
  // already), the row after: a redeploy that fails is tried again next time.
  const [dep] = await deps.db.select().from(deployments).where(eq(deployments.id, md.deploymentId));
  if (dep) await redeployWithCurrentConfig(deps.db, dep, deps.k8s);
  await deps.db.update(deployments).set({ extraMounts: null }).where(eq(deployments.id, md.deploymentId));
  return {
    md, mode: 'unreachable', changes: ['removed its extra mounts and restarted it once (a database instance takes none)'],
    detail: 'restarted without its extra mounts',
  };
}

/** One instance. Never throws for the instance's own failures. */
export async function reconcileInstance(deps: ReconcileDeps, md: ManagedDatabase, prev?: StateRow): Promise<InstanceOutcome> {
  const run = deps.run ?? runWithTimeLimit;
  const now = (deps.now ?? (() => new Date()))();
  if (md.standalone && md.extraMountCount > 0) {
    try {
      return await dropExtraMounts(deps, md);
    } catch (err) {
      return { md, mode: 'unreachable', changes: [], detail: `its extra mounts could not be removed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  let ctx: DbManagerContext;
  try {
    const namespace = await getTenantNamespace(deps.db, md.tenantId);
    ctx = await buildDbContext(deps.k8s, deps.kubeconfigPath, namespace, md.deploymentName, md.entry, md.configuration, md.engine, md.componentName);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'POD_NOT_FOUND') return { md, mode: 'unreachable', changes: [], detail: 'no running pod' };
    return { md, mode: 'unreachable', changes: [], detail: err instanceof Error ? err.message : String(err) };
  }
  if (md.engine === 'mongodb' && !ctx.rootPassword) return { md, mode: 'open', changes: [], full: true };

  const changes: string[] = [];
  let access;
  try {
    ctx = await recoverMongoRoot(deps, md, ctx, prev, run, changes);
    if (changes.length === 0) {
      const quick = await quickCheck(deps, md, ctx, prev, now, run);
      if (quick) return quick;
    }
    access = await ensureDatabaseAdminAccess(ctx, { standalone: md.standalone }, run);
  } catch (err) {
    // The database never judged a login (DbUnreachableError) or the exec failed: not a lockout.
    return { md, mode: 'unreachable', changes, detail: err instanceof Error ? err.message : String(err) };
  }
  changes.push(...access.changed);
  const base = { md, mode: access.mode, changes, pod: ctx.podName, full: true } as const;
  if (!md.standalone || !LOGGED_IN_MODES.has(access.mode)) return { ...base, detail: access.detail };

  let rotated = false;
  let detail = access.detail;
  try {
    if (md.engine === 'mongodb' && access.mode === 'restricted' && !prev?.rootRotatedAt) {
      const next = await rotateMongoRoot(deps, md, ctx, prev, run);
      if (next) {
        ctx = next;
        rotated = true;
        changes.push('root has a new password only the platform knows (the tenant knew the old one)');
      } else detail = "root's password could not be replaced; the next check tries again";
    }
    // Only where root is the platform's alone; and again in a new pod, which
    // may be a restore of an older data directory.
    const due = !prev?.hardenedAt || prev.hardenedPod !== ctx.podName || now.getTime() - prev.hardenedAt.getTime() >= HARDEN_INTERVAL_MS;
    // A pass that did not finish is tried again hourly, not on every tick.
    const retryWait = prev?.hardenTriedAt ? now.getTime() - prev.hardenTriedAt.getTime() < SHAPE_INTERVAL_MS : false;
    const harden = TARGET_MODES.has(access.mode) && due && !retryWait;
    let account = await loadTenantAdminAccount(deps.db, md.deploymentId, deps.encryptionKey);
    if (!account) {
      // Recorded BEFORE it is created, so a crash in between leaves a known
      // password to set, never an account nobody can name.
      const candidate = { username: await chooseTenantAdminUsername(ctx, run), password: newTenantAdminPassword() };
      account = await recordFirstTenantAdminAccount(deps.db, md.deploymentId, candidate, deps.encryptionKey);
    }
    const result = await ensureTenantAdmin(ctx, account, { harden }, run);
    changes.push(...result.changes);
    const hardened = harden && result.problems.length === 0;
    const stuck = (harden && result.problems.length > 0) || (retryWait && Boolean(prev?.stuckSince));
    if (harden && result.problems.length > 0) detail = `the hardening pass did not finish, it is tried again within the hour: ${result.problems.join('; ')}`;
    else if (stuck) detail = prev?.detail ?? undefined;
    // Shown once it exists AND what a tenant could have left is gone — or
    // root is not the platform's alone anyway (settled on the password
    // login: the socket does not work in this pod).
    if (hardened || (!TARGET_MODES.has(access.mode) && !access.partial)) await markTenantAdminReady(deps.db, md.deploymentId, now);
    return { ...base, detail, hardened, stuck, hardenTried: harden && result.problems.length > 0, rotated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, detail: `the tenant administrator account could not be set up: ${msg}`, rotated };
  }
}

async function recordOutcome(db: Database, o: InstanceOutcome, prev: StateRow | undefined, now: Date): Promise<StateValues> {
  const values = stateValuesFor(o, prev, now);
  await db.insert(databaseAdminState).values(values)
    .onConflictDoUpdate({ target: databaseAdminState.deploymentId, set: values });
  return values;
}

/** "Tenant — instance (engine)" for a notification list item. */
function subjectOf(md: ManagedDatabase): string {
  return `${md.tenantName} — ${md.deploymentName} (${md.engine})`;
}

export interface TickResult {
  readonly checked: number;
  readonly changed: number;
  readonly locked: number;
  readonly unreachable: number;
}

/**
 * One run per instance at a time, across replicas: a run lock per instance
 * (scheduler-lease.ts, released when the run ends — never given up early, so
 * a run past the time limit still holds it until its commands end, which
 * `timeout` bounds). Past the limit the caller gets an outcome now and moves
 * on. Null: another run holds the instance; nothing to record.
 */
async function reconcileOnce(deps: ReconcileDeps, md: ManagedDatabase, prev: StateRow | undefined): Promise<InstanceOutcome | null> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), INSTANCE_TIME_LIMIT_MS);
    timer.unref?.();
  });
  const leased = withSchedulerLease(deps.db, `database-admin:${md.deploymentId}`, 2 * INSTANCE_TIME_LIMIT_MS,
    () => reconcileInstance(deps, md, prev), { release: true, maxHoldMs: Infinity, startupRetry: false });
  try {
    const first = await Promise.race([leased, limit]);
    if (first === 'timeout') {
      leased.catch(() => undefined);
      return { md, mode: 'unreachable', changes: [], detail: `the check took longer than ${INSTANCE_TIME_LIMIT_MS / 60000} minutes` };
    }
    return first.ran ? first.value : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Run `work` over `items`, `n` at a time. */
async function inParallel<T>(items: readonly T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** One pass over the given instances (all running ones when omitted). */
export async function reconcileDatabaseAdmin(deps: ReconcileDeps, only?: ReadonlyArray<ManagedDatabase>): Promise<TickResult> {
  const now = deps.now ?? (() => new Date());
  const instances = only ?? await listManagedDatabases(deps.db);
  if (instances.length === 0) return { checked: 0, changed: 0, locked: 0, unreachable: 0 };
  const prevRows = await deps.db.select().from(databaseAdminState)
    .where(inArray(databaseAdminState.deploymentId, instances.map((i) => i.deploymentId)));
  const prev = new Map(prevRows.map((r) => [r.deploymentId, r]));

  const announced: Array<{ md: ManagedDatabase; row: StateValues }> = [];
  const recovered: Array<{ md: ManagedDatabase; since: Date }> = [];
  const counts = { changed: 0, locked: 0, unreachable: 0 };
  await inParallel(instances, CONCURRENCY, async (md) => {
    try {
      const before = prev.get(md.deploymentId);
      const o = await reconcileOnce(deps, md, before);
      if (!o) return;
      const row = await recordOutcome(deps.db, o, before, now());
      const label = `${md.tenantName}/${md.deploymentName} (${md.engine})`;
      if (o.changes.length > 0) {
        counts.changed += 1;
        console.log(`[database-admin] ${label}: ${o.changes.join('; ')}`);
      }
      if (o.mode === 'unreachable') counts.unreachable += 1;
      if (o.mode === 'locked') {
        counts.locked += 1;
        console.error(`[database-admin] ${label}: the platform cannot log in as administrator — ${o.detail ?? 'no detail'}`);
      }
      // Logged when it comes about, not on every tick (an app stack stays there).
      if ((o.mode === 'password' && before?.mode !== 'password') || (o.mode === 'unreachable' && !before?.unreachableSince)) {
        console.warn(`[database-admin] ${label}: ${o.mode} — ${o.detail ?? ''}`);
      }
      const transition = incidentTransition(o.mode, before, row, now());
      if (transition === 'announce-lost') announced.push({ md, row });
      const since = before?.lockedSince ?? before?.unreachableSince;
      if (transition === 'announce-restored' && since) recovered.push({ md, since });
    } catch (err) {
      // One instance's bookkeeping failing must not stop the rest.
      console.error(`[database-admin] ${md.tenantName}/${md.deploymentName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  await announce(deps.db, announced, recovered, now);
  return { checked: instances.length, ...counts };
}

async function announce(
  db: Database,
  newlyLocked: ReadonlyArray<{ md: ManagedDatabase; row: StateValues }>,
  recovered: ReadonlyArray<{ md: ManagedDatabase; since: Date }>,
  now: () => Date,
): Promise<void> {
  try {
    if (newlyLocked.length > 0) {
      const { notifyAdminTenantDatabaseAccessLost } = await import('../notifications/events.js');
      const sent = await notifyAdminTenantDatabaseAccessLost(db, {
        count: String(newlyLocked.length),
        tenantList: newlyLocked.map(({ md, row }) => `${subjectOf(md)}: ${incidentReason(row)}`),
      }, `db-admin-lost:${newlyLocked.map(({ md, row }) => `${md.deploymentId}@${(row.lockedSince ?? row.unreachableSince)?.getTime() ?? 0}`).sort().join(',')}`);
      if (sent) {
        await db.update(databaseAdminState).set({ alertedAt: now() })
          .where(inArray(databaseAdminState.deploymentId, newlyLocked.map(({ md }) => md.deploymentId)));
      }
    }
    if (recovered.length > 0) {
      const { notifyAdminTenantDatabaseAccessRestored } = await import('../notifications/events.js');
      await notifyAdminTenantDatabaseAccessRestored(db, {
        count: String(recovered.length),
        tenantList: recovered.map(({ md }) => subjectOf(md)),
      }, `db-admin-restored:${recovered.map(({ md, since }) => `${md.deploymentId}@${since.getTime()}`).sort().join(',')}`);
    }
  } catch (err) {
    // Not alerted: the next pass announces it again (alerted_at is still empty).
    console.error(`[database-admin] the notification could not be sent: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const lastOnDemand = new Map<string, number>();

/** Handle one deployment now (a new instance came up; its account is awaited). Never throws; at most every 30 s. */
export async function reconcileDatabaseAdminFor(deps: ReconcileDeps, deploymentId: string): Promise<void> {
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  if (nowMs - (lastOnDemand.get(deploymentId) ?? 0) < ON_DEMAND_MIN_INTERVAL_MS) return;
  if (lastOnDemand.size > 1000) {
    for (const [id, at] of lastOnDemand) if (nowMs - at >= ON_DEMAND_MIN_INTERVAL_MS) lastOnDemand.delete(id);
  }
  lastOnDemand.set(deploymentId, nowMs);
  try {
    const one = await listManagedDatabases(deps.db, deploymentId);
    if (one.length > 0) await reconcileDatabaseAdmin(deps, one);
  } catch (err) {
    console.warn(`[database-admin] ${deploymentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The instance's last recorded login mode, or null when never checked. */
export async function databaseAdminMode(db: Database, deploymentId: string): Promise<DatabaseAdminStateMode | null> {
  const [row] = await db.select({ mode: databaseAdminState.mode }).from(databaseAdminState).where(eq(databaseAdminState.deploymentId, deploymentId));
  return (row?.mode as DatabaseAdminStateMode | undefined) ?? null;
}

export function startDatabaseAdminScheduler(deps: ReconcileDeps & { readonly tickMs?: number; readonly firstDelayMs?: number }): () => void {
  const tickMs = deps.tickMs ?? DATABASE_ADMIN_TICK_MS;
  const log = { warn: (msg: string, err?: unknown) => console.warn(`[database-admin] ${msg}`, err ?? '') };
  const tick = (): void => safeTick(
    'database-admin',
    () => withSchedulerLease(deps.db, 'database-admin-access', tickMs * 1.5, async () => {
      const r = await reconcileDatabaseAdmin(deps);
      if (r.checked > 0) {
        console.log(`[database-admin] checked ${r.checked} instance(s): ${r.changed} changed, ${r.locked} locked, ${r.unreachable} unreachable`);
      }
    }),
    log,
  );
  const first = setTimeout(tick, deps.firstDelayMs ?? 60_000);
  const timer = setInterval(tick, tickMs);
  return () => { clearTimeout(first); clearInterval(timer); };
}
