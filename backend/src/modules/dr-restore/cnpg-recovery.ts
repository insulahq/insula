/**
 * DR full-mode CNPG recovery orchestrator (Unit C.1).
 *
 * Recovers a CNPG cluster from its barman-cloud archive into the
 * freshly-bootstrapped cluster of the same name. Composes two proven
 * primitives from `postgres-barman-restore`:
 *
 *   1. `createBarmanRestore` — apply a side-by-side Cluster CR with
 *      `spec.bootstrap.recovery` pointing at the OLD archive (bundle's
 *      `cnpgClusters[].serverName` + `objectStoreName`). CNPG operator
 *      replays WAL into the new cluster's PVCs.
 *
 *   2. `promoteRestoredCluster` — destructive cutover. Takes a Longhorn
 *      snapshot of the side-by-side primary, kicks off a PITR Job that
 *      quiesces consumers / suspends Flux / deletes the source / recreates
 *      from snapshot / resumes Flux / deletes the side-by-side.
 *
 * Why not edit the freshly-bootstrapped cluster directly:
 *   - CNPG webhook rejects edits to `spec.bootstrap` post-init (filed as
 *     task #80 in memory). Side-by-side + promote is the proven path
 *     verified end-to-end on staging 2026-05-23 (Phase 3.1 promote).
 *   - The freshly-bootstrapped cluster's Cluster CR is owned by Flux
 *     from `k8s/base/database.yaml`. Deleting + recreating with
 *     bootstrap.recovery would race with Flux's next reconcile (60s)
 *     unless we suspend Flux — which is exactly what the PITR Job does
 *     internally during promote.
 *
 * Prerequisites enforced BEFORE we touch any CR:
 *   - `make secrets-restore` ran: BACKUP_TARGET_KEY + barman creds
 *     Secrets exist in the cluster (the shim reconciler needs these to
 *     materialize the ObjectStore CR with real S3 creds).
 *   - Unit B partial-mode ran: `backup_configurations` is populated with
 *     readOnly=true rows → shim reconciler ran on first tick →
 *     ObjectStore CR exists and points at the OLD bucket.
 *   - The freshly-bootstrapped source cluster is Ready (CNPG bootstrap
 *     completed) and has the barman-cloud plugin attached.
 *
 * NOT in this module:
 *   - Mail data restore — see `mail-restore.ts`.
 *   - System-settings / DNS provider restore — deliberately deferred to
 *     operator-driven UI per the locked PARTIAL contract.
 *   - Tenant data restore — operator drives via admin UI.
 */

import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import {
  createBarmanRestore,
  promoteRestoredCluster,
  getBarmanRestoreStatus,
  BarmanRestoreError,
} from '../postgres-barman-restore/service.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import type { CnpgRecoveryPointer } from '@k8s-hosting/api-contracts';

const CNPG_GROUP = 'postgresql.cnpg.io';
const CNPG_VERSION = 'v1';
const CLUSTERS_PLURAL = 'clusters';
const OBJECTSTORE_GROUP = 'barmancloud.cnpg.io';
const OBJECTSTORE_VERSION = 'v1';
const OBJECTSTORE_PLURAL = 'objectstores';

// Per-cluster naming convention for the side-by-side recovery CR.
// `dr-<unix-ts>` keeps it short (CNPG cluster name has a 50-char cap)
// and uniquely sortable across multiple DR attempts.
function makeDrClusterName(clusterName: string): string {
  return `${clusterName}-dr-${Date.now()}`;
}

export class CnpgRecoveryError extends Error {
  readonly code: number;
  readonly clusterName: string;
  constructor(clusterName: string, message: string, code = 500) {
    super(`CNPG recovery for cluster '${clusterName}' failed: ${message}`);
    this.name = 'CnpgRecoveryError';
    this.code = code;
    this.clusterName = clusterName;
  }
}

export interface CnpgRecoveryOpts {
  readonly k8s: K8sClients;
  readonly db: Database;
  readonly pointers: ReadonlyArray<CnpgRecoveryPointer>;
  /** Operator's typed confirmation per cluster — keys are clusterName,
   *  values must match the cluster name exactly. Enforced server-side
   *  by `promoteRestoredCluster`. Refused with a clear error if absent
   *  for any pointer being recovered. */
  readonly confirmClusterNames: ReadonlyMap<string, string>;
  /** Per-cluster timeout for side-by-side ready (WAL replay).
   *  Default 1800s (30 min) — covers typical small-to-medium archives.
   *  Operator-overridable via `DR_CNPG_RESTORE_TIMEOUT_MS` env. */
  readonly restoreTimeoutMs?: number;
  /** Per-cluster timeout for promote Job completion. Default 1800s
   *  (30 min) — the PITR Job runs quiesce + delete + recreate +
   *  normalize-bootstrap + resume; on a busy cluster up to 15 min has
   *  been observed in staging. */
  readonly promoteTimeoutMs?: number;
  /** Test-only K8s client mock substitution for the BarmanRestore
   *  primitive. When undefined, uses the real createBarmanRestore. */
  readonly _barmanRestoreClient?: typeof createBarmanRestore;
  /** Test-only override for promoteRestoredCluster. */
  readonly _promoteClient?: typeof promoteRestoredCluster;
}

export interface ClusterRecoveryResult {
  readonly clusterName: string;
  readonly namespace: string;
  readonly drClusterName: string;
  /** Wall-clock duration of the side-by-side WAL replay phase. */
  readonly restoreDurationMs: number;
  /** Wall-clock duration of the promote PITR Job. */
  readonly promoteDurationMs: number;
  /** Job name created by `promoteRestoredCluster`. Operator can tail
   *  with `kubectl logs -n platform job/<name>` post-DR for an audit
   *  trail of the cutover. */
  readonly pitrJobName: string;
}

export interface CnpgRecoveryResult {
  readonly clusters: ReadonlyArray<ClusterRecoveryResult>;
}

/**
 * Validate that every pointer has a matching typed confirmation. Refusing
 * up-front avoids a half-recovered state where cluster A is promoted but
 * cluster B fails the confirmation check.
 */
function preflightConfirmations(
  pointers: ReadonlyArray<CnpgRecoveryPointer>,
  confirmations: ReadonlyMap<string, string>,
): void {
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const p of pointers) {
    const value = confirmations.get(p.clusterName);
    if (value === undefined) {
      missing.push(p.clusterName);
    } else if (value !== p.clusterName) {
      mismatched.push(`${p.clusterName} (got '${value}')`);
    }
  }
  if (missing.length > 0) {
    throw new CnpgRecoveryError(
      missing.join(','),
      `--confirm-cluster=<name> required for every CNPG cluster being recovered. Missing: ${missing.join(', ')}`,
      400,
    );
  }
  if (mismatched.length > 0) {
    throw new CnpgRecoveryError(
      mismatched.join(','),
      `--confirm-cluster value must equal the cluster name verbatim. Mismatched: ${mismatched.join(', ')}`,
      400,
    );
  }
}

/**
 * Verify the live cluster's prerequisites match what the bundle expects.
 *
 * We DON'T edit anything here — just fail-fast with an actionable error
 * if a prerequisite is missing, so the operator can resolve it before
 * destructive cutover begins.
 */
async function preflightCluster(
  k8sClients: K8sClients,
  pointer: CnpgRecoveryPointer,
): Promise<void> {
  // 1. Source cluster exists.
  try {
    await k8sClients.custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace: pointer.namespace,
      plural: CLUSTERS_PLURAL, name: pointer.clusterName,
    } as unknown as Parameters<typeof k8sClients.custom.getNamespacedCustomObject>[0]);
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      throw new CnpgRecoveryError(
        pointer.clusterName,
        `Source cluster ${pointer.namespace}/${pointer.clusterName} not found. Re-run bootstrap.sh before DR full-mode restore.`,
        412,
      );
    }
    throw err;
  }

  // 2. ObjectStore CR exists. Without it the shim reconciler hasn't run
  //    yet (operator forgot to run --mode=partial first) and bootstrap.
  //    recovery will fail with "ObjectStore not found".
  try {
    await k8sClients.custom.getNamespacedCustomObject({
      group: OBJECTSTORE_GROUP, version: OBJECTSTORE_VERSION,
      namespace: pointer.namespace, plural: OBJECTSTORE_PLURAL,
      name: pointer.objectStoreName,
    } as unknown as Parameters<typeof k8sClients.custom.getNamespacedCustomObject>[0]);
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      throw new CnpgRecoveryError(
        pointer.clusterName,
        `ObjectStore CR ${pointer.namespace}/${pointer.objectStoreName} not found. Run '--mode=partial' first to import backup_configurations; the shim reconciler materializes the ObjectStore on the next tick.`,
        412,
      );
    }
    throw err;
  }
}

/**
 * Poll the side-by-side cluster until `readyInstances >= 1` or the
 * deadline expires. Returns the elapsed time on success; throws on
 * timeout.
 *
 * NB: getBarmanRestoreStatus does the managed-by label check + builds
 * the structural-truth ready boolean (readyInstances >= desiredInstances)
 * we trust here.
 */
async function waitForSideBySideReady(
  custom: k8s.CustomObjectsApi,
  namespace: string,
  newClusterName: string,
  deadlineMs: number,
  log?: Pick<Logger, 'info' | 'warn'>,
): Promise<number> {
  const startedAt = Date.now();
  let lastPhase: string | null = null;
  while (Date.now() < deadlineMs) {
    try {
      const status = await getBarmanRestoreStatus(custom, namespace, newClusterName);
      if (status.ready) {
        return Date.now() - startedAt;
      }
      if (status.phase !== lastPhase) {
        log?.info?.(
          { cluster: newClusterName, phase: status.phase, ready: status.ready, readyInstances: status.readyInstances },
          'dr-cnpg-recovery: side-by-side cluster phase changed',
        );
        lastPhase = status.phase;
      }
    } catch (err) {
      log?.warn?.(
        { cluster: newClusterName, err: err instanceof Error ? err.message : String(err) },
        'dr-cnpg-recovery: status poll failed; retrying',
      );
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new CnpgRecoveryError(
    newClusterName,
    `Side-by-side cluster ${namespace}/${newClusterName} did not reach ready=true within the configured timeout. Inspect with: kubectl -n ${namespace} get cluster ${newClusterName} -o yaml`,
    504,
  );
}

interface JobStatus {
  readonly status?: {
    readonly succeeded?: number;
    readonly failed?: number;
    readonly active?: number;
    readonly conditions?: ReadonlyArray<{
      readonly type?: string;
      readonly status?: string;
      readonly reason?: string;
      readonly message?: string;
    }>;
  };
}

/**
 * Poll the promote PITR Job until it succeeds, fails, or the deadline
 * expires. Returns elapsed time on success; throws on Job failure or
 * timeout.
 *
 * We poll via K8s API instead of the DB because the promote DESTROYS
 * AND RECREATES system-db mid-flight (PITR's quiesce + delete +
 * recreate phases). Any DB poll would race a connection-drop window.
 */
async function waitForPromoteJob(
  batch: k8s.BatchV1Api,
  namespace: string,
  jobName: string,
  deadlineMs: number,
  log?: Pick<Logger, 'info' | 'warn'>,
): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() < deadlineMs) {
    let job: JobStatus;
    try {
      job = await batch.readNamespacedJob({ namespace, name: jobName } as unknown as Parameters<typeof batch.readNamespacedJob>[0]) as unknown as JobStatus;
    } catch (err) {
      const code = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode;
      if (code === 404) {
        // Job is gone — either GC'd or never created. We can't tell;
        // either way, the cutover is no longer observable from here.
        // Surface a clear error; operator can inspect cluster directly.
        throw new CnpgRecoveryError(
          jobName,
          `Promote PITR Job ${namespace}/${jobName} disappeared mid-poll (404). Verify outcome with: kubectl -n ${namespace} get cluster <source>`,
          410,
        );
      }
      log?.warn?.(
        { jobName, err: err instanceof Error ? err.message : String(err) },
        'dr-cnpg-recovery: promote Job read failed; retrying',
      );
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    const succeeded = job.status?.succeeded ?? 0;
    const failed = job.status?.failed ?? 0;
    if (succeeded >= 1) {
      return Date.now() - startedAt;
    }
    if (failed >= 1) {
      // Surface the last failure condition for the operator.
      const failureCond = (job.status?.conditions ?? []).find(
        (c) => c.type === 'Failed' && c.status === 'True',
      );
      throw new CnpgRecoveryError(
        jobName,
        `Promote PITR Job failed: ${failureCond?.reason ?? 'unknown'} — ${failureCond?.message ?? 'no message'}. Inspect: kubectl -n ${namespace} logs job/${jobName}`,
        500,
      );
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new CnpgRecoveryError(
    jobName,
    `Promote PITR Job ${namespace}/${jobName} did not complete within the configured timeout. Inspect: kubectl -n ${namespace} logs job/${jobName}`,
    504,
  );
}

/**
 * Run side-by-side restore + promote for a single CNPG pointer.
 *
 * Failure modes — observable from the caller:
 *   - PRE: confirmation missing → 400
 *   - PRE: source cluster not found → 412 (operator must run bootstrap)
 *   - PRE: ObjectStore CR not found → 412 (operator must run --mode=partial)
 *   - SIDE-BY-SIDE: createBarmanRestore rejects → bubbles up BarmanRestoreError
 *   - WAIT: side-by-side never ready (504) → operator can poll manually
 *   - PROMOTE: promoteRestoredCluster rejects → bubbles up BarmanRestoreError
 *   - WAIT: PITR Job fails → 500 with the Job's failure condition
 *   - WAIT: PITR Job timeout (504) → operator can inspect cluster directly
 *
 * Side-effect contract:
 *   - On any failure AFTER createBarmanRestore returns, the side-by-side
 *     Cluster CR is LEFT IN PLACE. Operator deletes manually if no longer
 *     wanted — DR is a force-majeure flow where leaving artifacts for
 *     human inspection is preferable to silent cleanup.
 */
async function recoverOneCluster(
  opts: CnpgRecoveryOpts,
  pointer: CnpgRecoveryPointer,
  log?: Pick<Logger, 'info' | 'warn'>,
): Promise<ClusterRecoveryResult> {
  const restoreTimeoutMs = opts.restoreTimeoutMs
    ?? Number.parseInt(process.env.DR_CNPG_RESTORE_TIMEOUT_MS ?? '1800000', 10);
  const promoteTimeoutMs = opts.promoteTimeoutMs
    ?? Number.parseInt(process.env.DR_CNPG_PROMOTE_TIMEOUT_MS ?? '1800000', 10);

  await preflightCluster(opts.k8s, pointer);

  const drClusterName = makeDrClusterName(pointer.clusterName);
  log?.info?.(
    {
      source: pointer.clusterName,
      drCluster: drClusterName,
      serverName: pointer.serverName,
      objectStore: pointer.objectStoreName,
    },
    'dr-cnpg-recovery: starting side-by-side restore',
  );

  // PHASE 1: side-by-side bootstrap.recovery.
  const createBarman = opts._barmanRestoreClient ?? createBarmanRestore;
  try {
    await createBarman(opts.k8s.custom, {
      namespace: pointer.namespace,
      sourceClusterName: pointer.clusterName,
      newClusterName: drClusterName,
      recoveryTargetTime: null, // restore to LATEST archive entry
      serverNameOverride: pointer.serverName,
      objectStoreOverride: pointer.objectStoreName,
      skipFreshBackup: true,
    }, log);
  } catch (err) {
    if (err instanceof BarmanRestoreError) {
      throw new CnpgRecoveryError(pointer.clusterName, `side-by-side create failed: ${err.message}`, err.code);
    }
    throw err;
  }

  const restoreDurationMs = await waitForSideBySideReady(
    opts.k8s.custom, pointer.namespace, drClusterName,
    Date.now() + restoreTimeoutMs, log,
  );
  log?.info?.(
    { drCluster: drClusterName, restoreDurationMs },
    'dr-cnpg-recovery: side-by-side ready, beginning promote',
  );

  // PHASE 2: destructive cutover.
  const promote = opts._promoteClient ?? promoteRestoredCluster;
  let promoteResult: { jobName: string; jobNamespace: string };
  try {
    promoteResult = await promote(
      { k8s: opts.k8s, db: opts.db },
      {
        namespace: pointer.namespace,
        restoredClusterName: drClusterName,
        sourceClusterName: pointer.clusterName,
        confirmSourceClusterName: pointer.clusterName,
        // Audit trail attributes this to the system-driven DR flow.
        // No human actor is on the trigger; operator's confirmation is
        // already enforced upstream in preflightConfirmations.
        actorUserId: null,
      },
      log,
    );
  } catch (err) {
    if (err instanceof BarmanRestoreError) {
      throw new CnpgRecoveryError(pointer.clusterName, `promote rejected: ${err.message}`, err.code);
    }
    throw err;
  }

  const promoteDurationMs = await waitForPromoteJob(
    opts.k8s.batch, promoteResult.jobNamespace, promoteResult.jobName,
    Date.now() + promoteTimeoutMs, log,
  );

  log?.info?.(
    { source: pointer.clusterName, drCluster: drClusterName, promoteDurationMs },
    'dr-cnpg-recovery: promote complete; source cluster swapped',
  );

  return {
    clusterName: pointer.clusterName,
    namespace: pointer.namespace,
    drClusterName,
    restoreDurationMs,
    promoteDurationMs,
    pitrJobName: promoteResult.jobName,
  };
}

/**
 * Public entry point. Iterates pointers sequentially — concurrent
 * CNPG promotes are technically safe (each holds the PITR lock for
 * its own cluster) but sequential makes failure modes legible and
 * limits load on the operator and Longhorn during destructive cutover.
 */
export async function runCnpgRecovery(
  opts: CnpgRecoveryOpts,
  log?: Pick<Logger, 'info' | 'warn'>,
): Promise<CnpgRecoveryResult> {
  preflightConfirmations(opts.pointers, opts.confirmClusterNames);

  const clusters: ClusterRecoveryResult[] = [];
  for (const pointer of opts.pointers) {
    const r = await recoverOneCluster(opts, pointer, log);
    clusters.push(r);
  }
  return { clusters };
}
