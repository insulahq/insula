/**
 * Pre-capture database dump hook (Phase 1 of tenant-backup-v2, ADR-047).
 *
 * Runs BEFORE the files-component restic capture. For every tenant
 * deployment whose catalog entry is type='database', it asks SQL
 * Manager (`db-manager.ts`) to dump every database into the tenant
 * PVC. The dump file lands at `/exports/<name>-<iso>.sql` (placement
 * controlled by `exportDatabaseToPvc`). When the files-component then
 * runs `tar -cf - .` over the PVC, the dump is included in the
 * resulting restic snapshot — guaranteed-consistent, alongside the
 * raw on-disk DB files.
 *
 * Design note: the backup-tool image carries NO DB tenants. The dump
 * runs INSIDE the live tenant DB pod via `execInPod`, using the root
 * password the SQL Manager already holds. This avoids:
 *   - duplicating mariadb-tenant / postgresql-tenant binaries in the
 *     backup image
 *   - shipping a second copy of the root password into the backup ns
 *   - opening a network path from the backup pod to the live DB
 *
 * Failure semantics:
 *   - One deployment failing (pod not running, dump exited non-zero)
 *     does NOT abort the bundle. The error is recorded per
 *     deployment; the orchestrator still proceeds to the files
 *     capture, which gets crash-consistent on-disk files for the
 *     failed deployment.
 *   - One database failing inside a deployment (e.g. mid-transaction
 *     lock) does NOT abort the others in that deployment.
 *   - Per-deployment time bound (default 5 min) protects the bundle
 *     window from a hung dump.
 */

import type { Engine } from '../../deployments/db-manager.js';

/**
 * Minimal projection of a deployment row + its catalog entry. The caller
 * (orchestrator) does the JOIN against `deployments` × `catalog_entries`
 * filtered by tenantId; we only see the fields needed to dispatch.
 */
export interface PreDumpDeployment {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly namespace: string;
  readonly catalogCode: string;
  readonly catalogRuntime: string | null;
  /** Catalog entry type — only 'database' rows trigger the hook. */
  readonly catalogType: string;
  /** Deployment.configuration jsonb — carries the root password env. */
  readonly configuration: Record<string, unknown> | null;
}

/**
 * Subset of the SQL Manager surface this hook depends on. Injected so
 * unit tests can stub the k8s exec without spinning up a kube tenant.
 */
export interface PreDumpDeps {
  readonly buildDbContext: (
    dep: PreDumpDeployment,
  ) => Promise<{
    readonly kubeconfigPath: string | undefined;
    readonly namespace: string;
    readonly podName: string;
    readonly containerName: string;
    readonly engine: Engine;
    readonly rootPassword: string;
    readonly rootUsername: string;
  }>;
  readonly listDatabases: (ctx: {
    readonly namespace: string;
    readonly podName: string;
    readonly containerName: string;
    readonly engine: Engine;
    readonly kubeconfigPath: string | undefined;
    readonly rootPassword: string;
    readonly rootUsername: string;
  }) => Promise<ReadonlyArray<{ readonly name: string }>>;
  readonly exportDatabaseToPvc: (
    ctx: {
      readonly namespace: string;
      readonly podName: string;
      readonly containerName: string;
      readonly engine: Engine;
      readonly kubeconfigPath: string | undefined;
      readonly rootPassword: string;
      readonly rootUsername: string;
    },
    database: string,
    outputFileName: string,
    deploymentSubPath: string,
  ) => Promise<{ readonly pvcPath: string; readonly sizeBytes: number }>;
  /**
   * Optional: report free space on the DB pod's data volume so the hook can
   * refuse to write a logical dump into a nearly-full PVC (which could ENOSPC
   * the live database). Returns null when it cannot be determined (→ proceed).
   */
  readonly checkFreeSpace?: (ctx: {
    readonly namespace: string;
    readonly podName: string;
    readonly containerName: string;
    readonly engine: Engine;
    readonly kubeconfigPath: string | undefined;
    readonly rootPassword: string;
    readonly rootUsername: string;
  }) => Promise<{ readonly freeBytes: number; readonly usedPercent: number } | null>;
}

export interface PreDumpDatabaseResult {
  readonly database: string;
  readonly pvcPath: string;
  readonly sizeBytes: number;
}

export interface PreDumpDatabaseFailure {
  readonly database: string;
  readonly error: string;
  /**
   * True when the dump could not run for a benign, recoverable reason (dump
   * tool absent in a bring-your-own image, PVC too full, engine unsupported
   * for logical dump). The raw-files snapshot still covers the data → the
   * orchestrator records this as `degraded`, NOT a bundle failure. False =
   * the dump command errored unexpectedly (`failed`).
   */
  readonly benign: boolean;
}

export interface PreDumpDeploymentResult {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly namespace: string;
  readonly engine: Engine | null;
  readonly databaseDumps: ReadonlyArray<PreDumpDatabaseResult>;
  readonly databaseFailures: ReadonlyArray<PreDumpDatabaseFailure>;
  /** Top-level error (e.g. listDatabases failed). NULL if at least one DB attempted. */
  readonly error?: string;
  readonly durationMs: number;
}

export interface PreDumpOptions {
  /** Hard ceiling per deployment. Default: 5 min. */
  readonly perDeploymentTimeoutMs?: number;
  /** Backup id; included in dump filenames so retries don't collide. */
  readonly backupId?: string;
  /** Optional progress hook for the orchestrator. */
  readonly onProgress?: (msg: string) => void;
}

const DEFAULT_PER_DEPLOYMENT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Iterate the tenant's database deployments, dispatch a pre-capture
 * dump per database, return per-deployment results. Sequential (one
 * deployment at a time) by design — concurrent dumps over `kubectl
 * exec` against the same kube apiserver have caused load spikes in
 * past runs (`project_files_streaming_e2e_2026_05_07`).
 */
export async function preCaptureDatabaseDumps(
  deployments: ReadonlyArray<PreDumpDeployment>,
  deps: PreDumpDeps,
  opts: PreDumpOptions = {},
): Promise<ReadonlyArray<PreDumpDeploymentResult>> {
  const timeoutMs = opts.perDeploymentTimeoutMs ?? DEFAULT_PER_DEPLOYMENT_TIMEOUT_MS;
  const backupId = opts.backupId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const results: PreDumpDeploymentResult[] = [];

  for (const dep of deployments) {
    if (dep.catalogType !== 'database') {
      continue; // not our concern; orchestrator may pass mixed lists
    }
    const t0 = Date.now();
    if (opts.onProgress) opts.onProgress(`pre-dump ${dep.deploymentName}…`);

    const result = await withTimeout(timeoutMs, runOneDeployment(dep, deps, backupId));
    const durationMs = Date.now() - t0;

    if (result.kind === 'timeout') {
      results.push({
        deploymentId: dep.deploymentId,
        deploymentName: dep.deploymentName,
        namespace: dep.namespace,
        engine: null,
        databaseDumps: [],
        databaseFailures: [],
        error: `pre-dump timed out after ${timeoutMs}ms`,
        durationMs,
      });
      continue;
    }
    results.push({ ...result.value, durationMs });
  }

  return results;
}

async function runOneDeployment(
  dep: PreDumpDeployment,
  deps: PreDumpDeps,
  backupId: string,
): Promise<Omit<PreDumpDeploymentResult, 'durationMs'>> {
  let engine: Engine | null = null;
  try {
    const ctx = await deps.buildDbContext(dep);
    engine = ctx.engine;
    const databases = await deps.listDatabases(ctx);

    // Guard: refuse to write a logical dump into a nearly-full PVC — the
    // write could ENOSPC the tenant's LIVE database and take the app down.
    // Degrade VISIBLY instead; the crash-consistent raw-files snapshot still
    // captures every database.
    if (deps.checkFreeSpace) {
      const space = await deps.checkFreeSpace(ctx).catch(() => null);
      if (space && (space.usedPercent >= 90 || space.freeBytes < 200 * 1024 * 1024)) {
        return {
          deploymentId: dep.deploymentId,
          deploymentName: dep.deploymentName,
          namespace: dep.namespace,
          engine,
          databaseDumps: [],
          databaseFailures: databases.map((d) => ({
            database: d.name,
            error: `PVC ${space.usedPercent}% full — logical dump skipped to avoid filling the volume and crashing the live database. The crash-consistent raw-files snapshot still captured this database; grow the tenant volume or free space, then re-run the bundle for a fresh logical dump.`,
            benign: true,
          })),
        };
      }
    }

    const dumps: PreDumpDatabaseResult[] = [];
    const failures: PreDumpDatabaseFailure[] = [];
    // Subpath convention matches the existing SQL Manager helper
    // (`databases/<engine>-<suffix>` per db-manager.ts:1856). The
    // orchestrator passes the deployment.name unchanged; that's what
    // exportDatabaseToPvc treats as the subPath.
    const deploymentSubPath = `databases/${dep.deploymentName}`;
    // MongoDB dumps are a self-contained gzip BSON archive (`.archive.gz`);
    // the SQL engines write a `.sql` text dump. The restore executor keys
    // off this extension to choose mongorestore vs the SQL import path.
    const dumpExt = engine === 'mongodb' ? 'archive.gz' : 'sql';
    for (const d of databases) {
      const filename = sanitizeFilename(`predump-${d.name}-${backupId}.${dumpExt}`);
      try {
        const out = await deps.exportDatabaseToPvc(ctx, d.name, filename, deploymentSubPath);
        dumps.push({ database: d.name, pvcPath: out.pvcPath, sizeBytes: out.sizeBytes });
      } catch (err) {
        failures.push({ database: d.name, error: errorMessage(err), benign: isBenignDumpError(err) });
      }
    }

    return {
      deploymentId: dep.deploymentId,
      deploymentName: dep.deploymentName,
      namespace: dep.namespace,
      engine,
      databaseDumps: dumps,
      databaseFailures: failures,
    };
  } catch (err) {
    return {
      deploymentId: dep.deploymentId,
      deploymentName: dep.deploymentName,
      namespace: dep.namespace,
      engine,
      databaseDumps: [],
      databaseFailures: [],
      error: errorMessage(err),
    };
  }
}

async function withTimeout<T>(
  ms: number,
  p: Promise<T>,
): Promise<{ kind: 'value'; value: T } | { kind: 'timeout' }> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutP = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
  });
  try {
    const winner = await Promise.race([p.then((value) => ({ kind: 'value' as const, value })), timeoutP]);
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Classify a dump error as benign (recoverable → `degraded`) vs. a genuine
 * failure. Benign = the dump tool is absent (bring-your-own image), the engine
 * has no logical-dump path, or the PVC was too full to write safely. In every
 * benign case the crash-consistent raw-files snapshot still covers the data,
 * so the bundle stays restorable and the operator just sees a degraded dump.
 */
function isBenignDumpError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'EXPORT_NOT_AVAILABLE' || code === 'UNSUPPORTED_ENGINE') return true;
  const msg = errorMessage(err).toLowerCase();
  return /not available in this|not supported|pvc .*full/.test(msg);
}

function sanitizeFilename(name: string): string {
  // Restrict to a conservative filename charset. Anything outside is
  // replaced with `_` to defend against accidental path traversal at
  // the SQL Manager / file-manager boundary.
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
}
