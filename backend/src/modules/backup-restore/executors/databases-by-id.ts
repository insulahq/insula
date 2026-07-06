/**
 * Restore executor: `databases-by-id` (gap G4).
 *
 * Recovers a tenant's add-on database(s) from the per-database `.sql`
 * dump captured INSIDE the files snapshot (ADR-047). The pre-capture
 * hook (`tenant-bundles/components/database-predump.ts` →
 * `db-manager.ts:exportDatabaseToPvc`) dumps each database and MOVES it to
 * the flat per-tenant exports dir on the tenant PVC:
 *
 *     exports/predump-<db>-<bundleId>.sql
 *
 * (exportDatabaseToPvc returns `/exports/<file>` — it `mv`s the dump out of
 * the DB's data subPath into `exports/`). So after a `files-paths` restore
 * lands the snapshot on the live PVC, the `.sql` sits in `exports/`. This
 * executor then imports each dump back into the RUNNING database pod via the
 * existing SQL-Manager primitive `importSqlFromPvcFile` (which copies the file
 * from `exports/` into the deployment's own subPath for the pod) — it does NOT
 * re-invent the mysql/psql import path.
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
  type RestoreItem,
} from '../../../db/schema.js';
import { ApiError } from '../../../shared/errors.js';
import { createK8sClients, type K8sClients } from '../../k8s-provisioner/k8s-client.js';
import {
  buildDbContext,
  listDatabases,
  importSqlFromPvcFile,
  type DbManagerContext,
} from '../../deployments/db-manager.js';
import { getReadyFileManagerPod } from '../../file-manager/service.js';
import { execInPod } from '../../../shared/k8s-exec.js';

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
  const suffix = `-${bundleId}.sql`;
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

    // 2. Dumps for THIS bundle only.
    const files = await deps.listDumpFiles(ctx, dep.deploymentName);
    const bundleDumps = files.filter(
      (f) => f.startsWith(DUMP_PREFIX) && f.endsWith(suffix) && f.length > DUMP_PREFIX.length + suffix.length,
    );
    if (bundleDumps.length === 0) {
      outcomes.push(skippedOutcome(
        dep,
        `skipped ${dep.deploymentName}: no database dump found on the PVC for this bundle (expected exports/${DUMP_PREFIX}*${suffix})`,
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
    // predump lives in the flat per-tenant `exports/` dir; importSqlFromPvcFile
    // copies it INTO the deployment's own subPath (databases/<deploy>) for the
    // DB pod, so the source path is `exports/…` and the target subPath is the
    // deployment's.
    const importSubPath = `databases/${dep.deploymentName}`;
    const imported: string[] = [];
    const skipped: string[] = [];
    const failed: { database: string; error: string }[] = [];

    for (const file of bundleDumps) {
      const sanitizedDb = file.slice(DUMP_PREFIX.length, file.length - suffix.length);
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
      const res = await deps.importSql(ctx, realDb, `exports/${file}`, importSubPath);
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
  };

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
      },
    });
  }
  return selectTargetDeployments(selector, tenantId, [], requestedById);
}

/**
 * List predump filenames in the flat per-tenant `exports/` dir on the tenant
 * PVC via the file-manager pod (which mounts the whole PVC at `/data`).
 * `exportDatabaseToPvc` moves every predump there regardless of deployment, so
 * the dir is the same for all of a tenant's databases; the caller filters by
 * the `-<bundleId>.sql` suffix + maps each dump's db-name to the deployment's
 * live databases. `deploymentName` is unused for the path (kept for the
 * dep-scoped signature). A missing dir returns `[]` — never throws. `ls` runs
 * as a bare argv (no shell).
 */
async function listPredumpFiles(
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  _deploymentName: string,
): Promise<string[]> {
  const fmPod = await getReadyFileManagerPod(k8s, namespace);
  const dir = `/data/exports`;
  const res = await execInPod(kubeconfigPath, namespace, fmPod, 'file-manager', ['ls', '-1', dir]);
  if (res.exitCode !== 0) return [];
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function setProgress(app: FastifyInstance, item: RestoreItem, msg: string): Promise<void> {
  await app.db.update(restoreItems)
    .set({ progressMessage: msg.slice(0, PROGRESS_MAX) })
    .where(eq(restoreItems.id, item.id));
}
