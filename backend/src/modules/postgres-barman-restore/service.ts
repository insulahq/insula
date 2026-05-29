/**
 * postgres-barman-restore (Phase 3 — 2026-05-22).
 *
 * "Oops I deleted a row last Tuesday at 14:30" recovery via barman-cloud
 * backups. Distinct from postgres-restore which promotes from a Longhorn
 * snapshot (in-cluster, recent). This module spawns a NEW CNPG Cluster
 * CR with `bootstrap.recovery` that pulls from the object store via the
 * shim — restoring days/weeks of WAL replay if needed.
 *
 * Scope of this PR (PHASE 3 CUT):
 *   - Create side-by-side Cluster CR with bootstrap.recovery from a
 *     barman-cloud ObjectStore + optional recoveryTarget.targetTime.
 *   - Status polling: read the new Cluster's status.conditions +
 *     phase to surface progress.
 *   - Cleanup: delete the side-by-side Cluster CR + its PVCs.
 *
 * EXPLICITLY DEFERRED to Phase 3.1:
 *   - Promote operation (swap source ↔ restored cluster). The
 *     destructive cutover requires careful Service/Secret rotation that
 *     deserves its own focused review. For now the operator can:
 *       a. Verify the restored cluster has the expected data via
 *          kubectl exec ... psql
 *       b. Dump rows manually and apply them to source, OR
 *       c. Update connection strings to point at the new cluster (one
 *          Secret rotation + downstream restart cycle), OR
 *       d. Wait for Phase 3.1.
 *     The side-by-side primitive is the strict prerequisite for
 *     promote — promote can land later without invalidating any of
 *     the Phase 3 surface.
 *
 * No lock is acquired: side-by-side restore creates ENTIRELY NEW
 * resources, never mutates the source cluster. Multiple side-by-side
 * restores can run concurrently (operator could be A/B testing
 * recovery target times). The only constraint is name-uniqueness on
 * the new cluster, which k8s itself enforces at apply time.
 *
 * Known gaps (acceptable for Phase 3, follow-ups noted):
 *  - If the SOURCE cluster was itself created from recovery (not initdb),
 *    `source.spec.bootstrap.initdb` is undefined and the restored cluster
 *    bootstraps with CNPG defaults (postgres/postgres) instead of the
 *    source's actual database/owner. Affects transitive-recovery scenarios
 *    only. Fix would be to read post-bootstrap `spec.managed.databases`.
 *  - The wizard's `activeCluster` state is ephemeral — if the operator
 *    closes the wizard mid-restore they need `kubectl get cluster` to
 *    re-discover the side-by-side cluster name. The POST response message
 *    surfaces the name; copy it before closing.
 *  - Promote (cutover source → restored) is NOT in this PR — Phase 3.1.
 */

import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
// Phase 3.1 — promote reuses the postgres-restore PITR primitives. We
// don't reimplement quiesce/suspend/delete/recreate/normalize — the
// existing orchestrator handles all of that.
import {
  acquirePitrLockOrThrow,
  releasePitrLock,
  createPitrJob,
  getPlatformApiImage,
  isPostgresRestoreInProgressClusterWide,
} from '../postgres-restore/service.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';

const CNPG_GROUP = 'postgresql.cnpg.io';
const CNPG_VERSION = 'v1';
const CLUSTERS_PLURAL = 'clusters';
const LONGHORN_GROUP = 'longhorn.io';
const LONGHORN_VERSION = 'v1beta2';
const LONGHORN_NS = 'longhorn-system';

const BARMAN_PLUGIN_NAME = 'barman-cloud.cloudnative-pg.io';

/** Match the planner's RFC drift discovery from 2026-05-20:
 *  parameter is `barmanObjectName` not `objectStoreName`. */
const PARAM_OBJECT_NAME = 'barmanObjectName';

const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

export class BarmanRestoreError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message); this.code = code;
  }
}

export interface CreateBarmanRestoreInput {
  /** Namespace where BOTH the source and the new cluster live. */
  readonly namespace: string;
  /** Source CNPG cluster whose ObjectStore we bootstrap from. */
  readonly sourceClusterName: string;
  /** New cluster name — must differ from source. Validated against the
   *  k8s DNS-label regex; must NOT exist already. */
  readonly newClusterName: string;
  /** Optional ISO-8601 timestamp; null restores to latest. */
  readonly recoveryTargetTime: string | null;
  /** Optional — when set, the new Cluster is sized to N instances.
   *  Defaults to 1 (cheapest restore; operator can scale up later). */
  readonly instances?: number;
  /** Optional override for the barman-cloud `serverName` plugin parameter
   *  on `externalClusters[0]`. Defaults to `sourceClusterName`.
   *
   *  DR-only escape hatch (Unit C): in DR full-mode the SOURCE cluster
   *  is the freshly-bootstrapped one (same name as the old cluster by
   *  bootstrap convention, but the barman archive serverName is whatever
   *  the OLD cluster was named in the bundle). When the bundle's
   *  `cnpgClusters[].serverName` differs from the live source's name,
   *  pass the bundle value here so bootstrap.recovery finds the archive.
   *  When omitted, behaves exactly as before. */
  readonly serverNameOverride?: string;
  /** Optional override for the barman-cloud `barmanObjectName` plugin
   *  parameter. Defaults to the value read from the source cluster's
   *  `spec.plugins[barman-cloud].parameters.barmanObjectName`.
   *
   *  DR-only (Unit C): when restoring from a bundle, the bundle records
   *  the OLD cluster's ObjectStore name. If the freshly-bootstrapped
   *  source has the same name (bootstrap convention), this is a no-op.
   *  If they differ, pass the bundle value. When omitted, behaves
   *  exactly as before. */
  readonly objectStoreOverride?: string;
  /** Skip the PRE-restore fresh CNPG Backup. In DR mode the source
   *  is a freshly-bootstrapped cluster with no useful WAL to flush, so
   *  the mitigation is a no-op and only adds latency. Default false
   *  (preserves the existing "always run pre-restore backup when
   *  recoveryTargetTime is set" behaviour). */
  readonly skipFreshBackup?: boolean;
}

export interface CreateBarmanRestoreResult {
  readonly newClusterName: string;
  readonly namespace: string;
  readonly objectStoreName: string;
  readonly recoveryTargetTime: string | null;
  readonly clusterUid: string;
  /** True when a fresh CNPG Backup was attempted before the restore CR
   *  (only when recoveryTargetTime is set + the mitigation isn't
   *  disabled via BARMAN_RESTORE_SKIP_FRESH_BACKUP=true env). */
  readonly freshBackupTriggered: boolean;
  /** Name of the fresh CNPG Backup CR, when it completed successfully.
   *  null when the backup wasn't triggered, failed, or timed out. */
  readonly freshBackupId: string | null;
  /** Operator-actionable warning when the fresh-backup mitigation
   *  failed. The restore still proceeds — this warning surfaces in
   *  the wizard so the operator knows what to watch for during
   *  recovery (large-WAL-gap → CNPG bootstrap timeout loop). null
   *  when mitigation succeeded or wasn't needed. */
  readonly freshBackupWarning: string | null;
}

interface CnpgCluster {
  readonly metadata?: {
    readonly name?: string; readonly namespace?: string; readonly uid?: string;
    readonly labels?: Record<string, string>;
  };
  readonly spec?: {
    readonly instances?: number;
    readonly imageName?: string;
    readonly storage?: { readonly storageClass?: string; readonly size?: string };
    readonly bootstrap?: { readonly initdb?: { readonly database?: string; readonly owner?: string } };
    readonly plugins?: ReadonlyArray<{
      readonly name?: string;
      readonly enabled?: boolean;
      readonly parameters?: Record<string, unknown>;
    }>;
    /** Pod-scheduling constraints that MUST be inherited so the restored
     *  cluster's pods land on the same node class as source (otherwise
     *  they Pending forever on production tainted nodes). */
    readonly affinity?: unknown;
    readonly nodeSelector?: unknown;
    readonly tolerations?: unknown;
  };
  readonly status?: {
    readonly phase?: string;
    readonly readyInstances?: number;
    readonly instances?: number;
    readonly currentPrimary?: string;
    readonly conditions?: ReadonlyArray<{
      readonly type?: string; readonly status?: string; readonly reason?: string; readonly message?: string;
      readonly lastTransitionTime?: string;
    }>;
  };
}

function validateClusterName(s: string, label: string): void {
  if (!s || s.length > 50 || !NAME_RE.test(s)) {
    throw new BarmanRestoreError(`Invalid ${label} '${s}' — must be DNS-label-compatible + ≤50 chars`, 400);
  }
}

/**
 * Read the ObjectStore name from the source cluster's barman-cloud plugin.
 * Mirrors getBarmanObjectStoreName in cnpg-backup-health (kept local to
 * avoid a circular import between the two modules — the value is a tiny
 * sliding-window helper).
 */
function getObjectStoreName(cluster: CnpgCluster): string | null {
  const plugins = cluster.spec?.plugins ?? [];
  for (const p of plugins) {
    if (p.enabled === false) continue;
    const n = (p.name ?? '').toLowerCase();
    if (n !== BARMAN_PLUGIN_NAME && !n.endsWith('barman-cloud') && !n.startsWith('barman-cloud.')) continue;
    const v = p.parameters?.[PARAM_OBJECT_NAME];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Trigger a fresh CNPG Backup for the source cluster + wait briefly
 * for it to complete. Used as a PITR-WAL-gap mitigation:
 *
 *   Without this, an operator restoring to "now minus a few minutes"
 *   from a barman archive that hasn't been backed up in days will have
 *   the recovery pod try to replay days of WAL. CNPG's recovery-pod
 *   controller polls the postgres Unix socket with a ~2-min internal
 *   timeout; when WAL replay takes longer than that, the controller
 *   restarts the recovery pod and replay starts over from base — looping
 *   indefinitely.
 *
 *   Forcing a fresh barman backup right before the restore closes the
 *   WAL gap to seconds. Recovery completes well within CNPG's timeout.
 *
 * Best-effort: when the backup CR can't be created or doesn't complete
 * within the timeout, returns a non-fatal warning so the orchestration
 * continues anyway (operator may have ample time, may not care about
 * the gap, or the CNPG configuration may already tolerate large gaps).
 *
 * Returns:
 *   - `{ ok: true, backupId }` — fresh backup completed
 *   - `{ ok: false, warning }` — couldn't take fresh backup; operator
 *     may hit the CNPG bootstrap-recovery timeout if WAL gap is large
 */
async function triggerFreshBarmanBackup(
  custom: k8s.CustomObjectsApi,
  namespace: string,
  sourceClusterName: string,
  log?: Pick<Logger, 'info' | 'warn'>,
  opts: { readonly timeoutMs?: number; readonly pluginName?: string } = {},
): Promise<{ readonly ok: boolean; readonly backupId?: string; readonly warning?: string }> {
  const timeoutMs = opts.timeoutMs ?? Number.parseInt(process.env.BARMAN_FRESH_BACKUP_TIMEOUT_MS ?? '180000', 10);
  const pluginName = opts.pluginName ?? BARMAN_PLUGIN_NAME;
  const backupName = `pre-restore-${Date.now()}`;
  const body = {
    apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
    kind: 'Backup',
    metadata: {
      name: backupName,
      namespace,
      labels: {
        'insula.host/barman-pre-restore': 'true',
      },
    },
    spec: {
      cluster: { name: sourceClusterName },
      method: 'plugin',
      pluginConfiguration: { name: pluginName },
    },
  };
  try {
    await custom.createNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace,
      plural: 'backups', body,
    } as unknown as Parameters<typeof custom.createNamespacedCustomObject>[0]);
  } catch (err) {
    const msg = (err as Error).message;
    log?.warn?.({ err: msg }, 'barman-restore: pre-restore Backup CR create failed (non-fatal)');
    return { ok: false, warning: `Pre-restore backup could not be triggered: ${msg}. If WAL gap to recoveryTargetTime is large (>>1 hour), restore may loop on CNPG bootstrap timeout.` };
  }
  log?.info?.({ backupName }, 'barman-restore: pre-restore Backup triggered, polling for completion');

  // Poll for completion. Successful Backup has status.phase='completed'.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const b = await custom.getNamespacedCustomObject({
        group: CNPG_GROUP, version: CNPG_VERSION, namespace, plural: 'backups', name: backupName,
      } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]) as { status?: { phase?: string; error?: string } };
      const phase = b.status?.phase;
      if (phase === 'completed') {
        log?.info?.({ backupName }, 'barman-restore: pre-restore Backup completed');
        return { ok: true, backupId: backupName };
      }
      if (phase === 'failed') {
        const err = b.status?.error ?? 'unknown';
        return { ok: false, warning: `Pre-restore backup ${backupName} failed: ${err}. Restore will proceed with stale catalogue — if WAL gap is large, may loop on CNPG bootstrap timeout.` };
      }
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, warning: `Pre-restore backup ${backupName} did not complete within ${Math.round(timeoutMs / 1000)}s. Restore will proceed with stale catalogue — if WAL gap to recoveryTargetTime is large, recovery may loop on CNPG bootstrap timeout.` };
}

/**
 * Spawn a side-by-side restore by applying a new Cluster CR with
 * bootstrap.recovery pointing at the source's ObjectStore.
 *
 * Returns immediately after Kubernetes accepts the CR; the actual
 * restore happens in the CNPG operator's reconcile loop. Callers poll
 * GET /admin/postgres-barman-restore/status/:name for progress.
 */
export async function createBarmanRestore(
  custom: k8s.CustomObjectsApi,
  inputs: CreateBarmanRestoreInput,
  log?: Pick<Logger, 'info' | 'warn'>,
): Promise<CreateBarmanRestoreResult> {
  validateClusterName(inputs.namespace, 'namespace');
  validateClusterName(inputs.sourceClusterName, 'sourceClusterName');
  validateClusterName(inputs.newClusterName, 'newClusterName');
  // Defense-in-depth (security review HIGH#1): the bundle Zod schema
  // validates serverName / objectStoreName at parse time, but a future
  // internal caller could pass synthesized values that bypass Zod. Apply
  // the same DNS-label regex at the API boundary so a crafted value
  // can't reach the barman-cloud plugin parameters verbatim.
  if (inputs.serverNameOverride !== undefined) {
    validateClusterName(inputs.serverNameOverride, 'serverNameOverride');
  }
  if (inputs.objectStoreOverride !== undefined) {
    validateClusterName(inputs.objectStoreOverride, 'objectStoreOverride');
  }
  if (inputs.newClusterName === inputs.sourceClusterName) {
    throw new BarmanRestoreError('newClusterName MUST differ from sourceClusterName — side-by-side restore creates a separate Cluster CR', 400);
  }
  if (inputs.recoveryTargetTime) {
    const t = new Date(inputs.recoveryTargetTime);
    if (Number.isNaN(t.getTime())) {
      throw new BarmanRestoreError(`recoveryTargetTime is not a parseable ISO-8601 timestamp: ${inputs.recoveryTargetTime}`, 422);
    }
  }
  // Instances default = source's instance count (HA-state-aware).
  // Operator's request 2026-05-22: auto-default to source's HA state
  // instead of always 1. Single-instance source → 1 replica restore;
  // HA-3 source → 3-replica restore so the operator can promote-and-go
  // without a separate scale-up step. Explicit `instances` in the
  // request still overrides. We resolve the source count below after
  // we've read the source CR (default constant 1 used only when source
  // hasn't declared instances either — vanishingly rare).
  //
  // Early-validate the explicit value here so bad input doesn't reach
  // the source fetch (clearer error surface + matches the prior contract).
  const explicitInstances = inputs.instances;
  if (explicitInstances !== undefined) {
    if (!Number.isInteger(explicitInstances) || explicitInstances < 1 || explicitInstances > 5) {
      throw new BarmanRestoreError(`instances must be an integer 1..5; got ${explicitInstances}`, 422);
    }
  }

  // Read source for the ObjectStore + initdb settings.
  let source: CnpgCluster;
  try {
    source = await custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.namespace,
      plural: CLUSTERS_PLURAL, name: inputs.sourceClusterName,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]) as unknown as CnpgCluster;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      throw new BarmanRestoreError(`Source cluster ${inputs.namespace}/${inputs.sourceClusterName} not found`, 404);
    }
    throw err;
  }

  // Resolve the ObjectStore name. Default = whatever the source cluster's
  // barman-cloud plugin parameter says; DR (Unit C) can pass an explicit
  // override from the bundle when the live source's value differs from
  // the archive's. The validity check (must be non-empty) applies to
  // both paths.
  const sourceObjectStore = getObjectStoreName(source);
  const objectStore = inputs.objectStoreOverride ?? sourceObjectStore;
  if (!objectStore) {
    throw new BarmanRestoreError(
      `Source cluster ${inputs.namespace}/${inputs.sourceClusterName} does not use the barman-cloud plugin — barman-cloud restore is only available for plugin-mode clusters`,
      422,
    );
  }
  if (inputs.objectStoreOverride && sourceObjectStore && sourceObjectStore !== inputs.objectStoreOverride) {
    // Informational log only — operator may legitimately be restoring a
    // bundle whose objectStore was renamed after the source went down.
    log?.warn?.(
      { sourceObjectStore, override: inputs.objectStoreOverride },
      'barman-restore: objectStoreOverride differs from source cluster plugin value — using override',
    );
  }

  // Refuse if the new name already exists. The API would 409 on create
  // anyway but we return a clearer message here.
  try {
    await custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.namespace,
      plural: CLUSTERS_PLURAL, name: inputs.newClusterName,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]);
    throw new BarmanRestoreError(`A cluster named ${inputs.newClusterName} already exists in ${inputs.namespace}`, 409);
  } catch (err) {
    if (err instanceof BarmanRestoreError) throw err;
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code !== 404) throw err;
    // 404 is the happy path — the name is free.
  }

  // Carry over the source's instance image + storage class + initdb
  // owner/database so the restored cluster is a faithful peer.
  const imageName = source.spec?.imageName;
  const storage = source.spec?.storage ?? {};
  const initdb = source.spec?.bootstrap?.initdb;
  // Resolve the actual instance count to use.
  const instances = explicitInstances ?? source.spec?.instances ?? 1;
  if (!Number.isInteger(instances) || instances < 1 || instances > 5) {
    throw new BarmanRestoreError(`instances must be an integer 1..5; got ${instances}`, 422);
  }

  const externalName = `${objectStore}-recovery-source`;
  const newCluster = {
    apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
    kind: 'Cluster',
    metadata: {
      name: inputs.newClusterName,
      namespace: inputs.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'platform-api-postgres-barman-restore',
        'insula.host/barman-restore-source': inputs.sourceClusterName,
        ...(inputs.recoveryTargetTime
          ? { 'insula.host/barman-restore-target-time-set': 'true' }
          : { 'insula.host/barman-restore-target-time-set': 'false' }),
      },
      annotations: {
        ...(inputs.recoveryTargetTime
          ? { 'insula.host/barman-restore-target-time': inputs.recoveryTargetTime }
          : {}),
      },
    },
    spec: {
      instances,
      ...(imageName ? { imageName } : {}),
      ...(Object.keys(storage).length > 0 ? { storage } : {}),
      bootstrap: {
        recovery: {
          source: externalName,
          ...(inputs.recoveryTargetTime
            ? { recoveryTarget: { targetTime: inputs.recoveryTargetTime, targetInclusive: true } }
            : {}),
          // Inherit initdb owner/database so the restored DB has the
          // same app-user shape (matters for CNPG-managed credentials).
          ...(initdb ? { database: initdb.database, owner: initdb.owner } : {}),
        },
      },
      // externalClusters joins bootstrap.recovery.source → the
      // barman-cloud plugin that ALREADY knows how to read the
      // ObjectStore. The plugin name + parameter shape mirrors the
      // pluginConfiguration on the source's Backup CRs (verified live
      // on staging 2026-05-22 — see staging Backup CRs for system-db).
      //
      // serverName MUST be set to the SOURCE cluster's name. Barman-
      // cloud namespaces archives by `<destinationPath>/<serverName>/...`
      // and the plugin defaults serverName to the NEW cluster's name —
      // which doesn't have any backups, so the plugin returns "no target
      // backup found" and the restore fails immediately (caught live on
      // staging 2026-05-22 with sysdb-restored-e2e attempt #1). Forcing
      // serverName=source resolves the lookup against the actual archive.
      externalClusters: [
        {
          name: externalName,
          plugin: {
            name: BARMAN_PLUGIN_NAME,
            parameters: {
              [PARAM_OBJECT_NAME]: objectStore,
              // serverName resolution: bundle override > sourceClusterName
              // (the historical default). DR full-mode (Unit C) passes the
              // bundle's `cnpgClusters[].serverName` here so bootstrap.
              // recovery resolves the OLD cluster's archive even when the
              // freshly-bootstrapped source has a different name.
              serverName: inputs.serverNameOverride ?? inputs.sourceClusterName,
            },
          },
        },
      ],
      // Pod-scheduling inheritance (H2 fix 2026-05-22): without these the
      // restored cluster's pod hits the platform-server taint and stays
      // Pending forever. Inherit from source so the restored cluster has
      // the same node-affinity contract.
      ...(source.spec?.affinity ? { affinity: source.spec.affinity } : {}),
      ...(source.spec?.nodeSelector ? { nodeSelector: source.spec.nodeSelector } : {}),
      ...(source.spec?.tolerations ? { tolerations: source.spec.tolerations } : {}),
      // INTENTIONAL: do NOT inherit source.spec.plugins. The new cluster
      // is for verification + read-only inspection until the operator
      // explicitly promotes (Phase 3.1). Attaching the plugin would
      // start archiving the restored cluster's own WAL to the SAME
      // ObjectStore — both serverName-namespaced so no collision, but
      // (a) confusing to operators inspecting the bucket, and (b) needless
      // bytes/time spent archiving a verify-and-discard cluster. The
      // operator can re-enable the plugin via `kubectl edit cluster`
      // after Promote if they want the restored cluster to take archives.
      // No `spec.backup` either — the plugin model owns archives.
    },
  };

  // PITR WAL-gap mitigation 2026-05-23: trigger a fresh barman backup
  // BEFORE the restored cluster CR is applied. This closes the WAL gap
  // to seconds so CNPG's recovery-pod bootstrap timeout (~2 min) doesn't
  // fire before WAL replay completes. Best-effort — if the backup fails
  // or times out we surface a warning to the caller + continue. The
  // operator can still trigger the restore + just risks the CNPG
  // recovery loop for large WAL gaps; that's better than blocking on
  // a failed pre-restore backup.
  //
  // Disabled when SKIP_FRESH_BACKUP=true (test mode) or when no
  // recoveryTargetTime is set (no WAL replay needed → no gap to close).
  let freshBackup: { ok: boolean; backupId?: string; warning?: string } = { ok: true };
  // DR / test escape hatches:
  //   - per-call `inputs.skipFreshBackup` (Unit C — DR full-mode source is
  //     a freshly-bootstrapped cluster with no useful WAL to flush)
  //   - env BARMAN_RESTORE_SKIP_FRESH_BACKUP=true (CI default for harness)
  const skipFresh = inputs.skipFreshBackup === true
    || process.env.BARMAN_RESTORE_SKIP_FRESH_BACKUP === 'true';
  if (inputs.recoveryTargetTime && !skipFresh) {
    log?.info?.({ source: inputs.sourceClusterName }, 'barman-restore: triggering fresh backup to close WAL gap before restore');
    freshBackup = await triggerFreshBarmanBackup(custom, inputs.namespace, inputs.sourceClusterName, log);
    if (!freshBackup.ok) {
      log?.warn?.({ warning: freshBackup.warning }, 'barman-restore: fresh-backup mitigation failed — continuing anyway');
    }
  }

  let created: CnpgCluster;
  try {
    created = await custom.createNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.namespace,
      plural: CLUSTERS_PLURAL, body: newCluster,
    } as unknown as Parameters<typeof custom.createNamespacedCustomObject>[0]) as unknown as CnpgCluster;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code === 409) {
      throw new BarmanRestoreError(`Cluster ${inputs.newClusterName} already exists (TOCTOU race)`, 409);
    }
    throw err;
  }
  log?.info?.({ ns: inputs.namespace, source: inputs.sourceClusterName, newCluster: inputs.newClusterName, objectStore, recoveryTargetTime: inputs.recoveryTargetTime }, 'barman-restore: side-by-side Cluster CR created');
  return {
    newClusterName: inputs.newClusterName,
    namespace: inputs.namespace,
    objectStoreName: objectStore,
    recoveryTargetTime: inputs.recoveryTargetTime,
    clusterUid: created.metadata?.uid ?? '',
    freshBackupTriggered: Boolean(inputs.recoveryTargetTime) && !skipFresh,
    freshBackupId: freshBackup.backupId ?? null,
    freshBackupWarning: freshBackup.warning ?? null,
  };
}

// ─── Status ─────────────────────────────────────────────────────────────────

export interface BarmanRestoreStatus {
  readonly clusterName: string;
  readonly namespace: string;
  /** CNPG cluster.status.phase — typical values: "Cluster in healthy
   *  state", "Setting up primary", "Creating a new replica", "Failed". */
  readonly phase: string | null;
  readonly readyInstances: number | null;
  readonly desiredInstances: number | null;
  readonly currentPrimary: string | null;
  readonly conditions: ReadonlyArray<{
    readonly type: string;
    readonly status: string;
    readonly reason: string | null;
    readonly message: string | null;
    readonly lastTransitionTime: string | null;
  }>;
  /** True when phase indicates the cluster has finished bootstrap +
   *  has a primary instance. */
  readonly ready: boolean;
}

export async function getBarmanRestoreStatus(
  custom: k8s.CustomObjectsApi,
  namespace: string,
  newClusterName: string,
): Promise<BarmanRestoreStatus> {
  validateClusterName(namespace, 'namespace');
  validateClusterName(newClusterName, 'newClusterName');

  let cluster: CnpgCluster;
  try {
    cluster = await custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace,
      plural: CLUSTERS_PLURAL, name: newClusterName,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]) as unknown as CnpgCluster;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      throw new BarmanRestoreError(`Restored cluster ${namespace}/${newClusterName} not found`, 404);
    }
    throw err;
  }

  // Refuse to surface state for clusters we didn't create — narrow the
  // endpoint's exposure. The label is set by createBarmanRestore + can
  // only come from this module.
  const managedBy = cluster.metadata?.labels?.['app.kubernetes.io/managed-by'];
  if (managedBy !== 'platform-api-postgres-barman-restore') {
    throw new BarmanRestoreError(`Cluster ${namespace}/${newClusterName} is not managed by barman-restore`, 403);
  }

  const phase = cluster.status?.phase ?? null;
  const readyInstances = cluster.status?.readyInstances ?? null;
  const desiredInstances = cluster.status?.instances ?? cluster.spec?.instances ?? null;
  const currentPrimary = cluster.status?.currentPrimary ?? null;
  const conditions = (cluster.status?.conditions ?? []).map((c) => ({
    type: c.type ?? '',
    status: c.status ?? '',
    reason: c.reason ?? null,
    message: c.message ?? null,
    lastTransitionTime: c.lastTransitionTime ?? null,
  }));
  // ready = at least one instance is healthy. We deliberately do NOT
  // string-match on CNPG's `phase` field (e.g. "Cluster in healthy
  // state") — that text changes between CNPG versions and a future
  // wording shift would silently leave ready=false. The instance count
  // is the structural truth: if CNPG reports readyInstances>=1 AND
  // matching desiredInstances, postgres is serving traffic.
  const ready =
    readyInstances !== null
    && desiredInstances !== null
    && readyInstances >= desiredInstances
    && readyInstances > 0;

  return { clusterName: newClusterName, namespace, phase, readyInstances, desiredInstances, currentPrimary, conditions, ready };
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

export async function deleteBarmanRestore(
  custom: k8s.CustomObjectsApi,
  namespace: string,
  newClusterName: string,
  log?: Pick<Logger, 'info' | 'warn'>,
): Promise<{ readonly deleted: boolean }> {
  validateClusterName(namespace, 'namespace');
  validateClusterName(newClusterName, 'newClusterName');

  // Refuse to delete clusters we didn't manage — same label guard as
  // status. Operators can still kubectl-delete by hand if needed.
  let cluster: CnpgCluster;
  try {
    cluster = await custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace,
      plural: CLUSTERS_PLURAL, name: newClusterName,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]) as unknown as CnpgCluster;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code
      ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) return { deleted: false }; // idempotent
    throw err;
  }
  const managedBy = cluster.metadata?.labels?.['app.kubernetes.io/managed-by'];
  if (managedBy !== 'platform-api-postgres-barman-restore') {
    throw new BarmanRestoreError(`Cluster ${namespace}/${newClusterName} is not managed by barman-restore — refusing to delete`, 403);
  }

  await custom.deleteNamespacedCustomObject({
    group: CNPG_GROUP, version: CNPG_VERSION, namespace,
    plural: CLUSTERS_PLURAL, name: newClusterName,
  } as unknown as Parameters<typeof custom.deleteNamespacedCustomObject>[0]);

  log?.info?.({ ns: namespace, cluster: newClusterName }, 'barman-restore: side-by-side Cluster CR deleted');
  return { deleted: true };
}

// ─── Phase 3.1 (2026-05-23) — PROMOTE ──────────────────────────────────────
//
// Destructive cutover: swap a side-by-side restored cluster's data into
// the SOURCE cluster's name + role. Key design: reuse the existing
// postgres-restore PITR machinery. Promote = take a Longhorn snapshot of
// the restored cluster's primary PVC + invoke promotePostgresFromSnapshot
// with `clusterName=<source>, snapshotName=<just-taken>`. The PITR
// orchestrator handles quiesce-consumers / suspend-Flux / delete-source /
// recreate-source / normalize-bootstrap / restore-consumers / resume-Flux.
// Post-PITR-success, pitr-job.ts also deletes the side-by-side restored
// Cluster CR (driven by BARMAN_PROMOTE_MODE env var).
//
// Failure modes:
//   - snapshot-take fails → release PITR lock + throw, source untouched
//   - Job-create fails → release PITR lock + throw, source untouched,
//     orphan Longhorn snapshot cleaned up by recoverInterruptedRestore
//   - PITR fails mid-run → existing auto-recovery returns source to
//     pre-promote state (recreates from the wrapped Longhorn snapshot)
//   - PITR succeeds + restored cluster delete fails → admin notification
//     with manual kubectl command, source already swapped (non-fatal)

export interface PromoteRestoredClusterInputs {
  readonly namespace: string;
  readonly restoredClusterName: string;
  readonly sourceClusterName: string;
  /** Type-to-confirm: MUST equal sourceClusterName (server-side
   *  enforcement of the wizard's type-to-confirm input). */
  readonly confirmSourceClusterName: string;
  readonly actorUserId: string | null;
}

export interface PromoteRestoredClusterResult {
  readonly snapshotName: string;
  readonly jobName: string;
  readonly jobNamespace: string;
  readonly sourceClusterName: string;
  readonly restoredClusterName: string;
  readonly namespace: string;
}

interface PvcMeta {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly volumeName?: string };
}

/**
 * Take a Longhorn-native snapshot of the restored cluster's CURRENT
 * primary PVC. Returns the snapshot name once it's `readyToUse=true`.
 *
 * Uses the same `pitr-restore` labels the postgres-restore module
 * uses on its temp resources — so if this orchestration crashes, the
 * orphan snapshot is cleaned up by `recoverInterruptedRestore` at
 * next platform-api startup (label selector `pitr-restore=true`).
 */
async function takeLonghornSnapshotOfRestoredCluster(
  custom: k8s.CustomObjectsApi,
  core: k8s.CoreV1Api,
  namespace: string,
  restoredClusterName: string,
  sourceNamespace: string,
  log?: Pick<Logger, 'info' | 'warn'>,
  opts: { readonly timeoutMs?: number } = {},
): Promise<{ readonly snapshotName: string; readonly longhornVolume: string }> {
  // 1. Resolve restored cluster's currentPrimary pod → matching PVC
  let restored: { readonly status?: { readonly currentPrimary?: string } };
  try {
    restored = await custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace, plural: CLUSTERS_PLURAL, name: restoredClusterName,
    } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]) as never;
  } catch (err) {
    throw new BarmanRestoreError(`Restored cluster ${namespace}/${restoredClusterName} lookup failed: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  const primaryPodName = restored.status?.currentPrimary;
  if (!primaryPodName) {
    throw new BarmanRestoreError(`Restored cluster ${namespace}/${restoredClusterName} has no currentPrimary — cannot snapshot`, 409);
  }

  // The PVC for a CNPG instance has the same name as the pod
  // (`<cluster>-<n>`). Confirm + read its Longhorn volume name.
  let pvc: PvcMeta;
  try {
    pvc = await core.readNamespacedPersistentVolumeClaim({
      namespace, name: primaryPodName,
    } as unknown as Parameters<typeof core.readNamespacedPersistentVolumeClaim>[0]) as unknown as PvcMeta;
  } catch (err) {
    throw new BarmanRestoreError(`PVC ${namespace}/${primaryPodName} lookup failed: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  const longhornVolume = pvc.spec?.volumeName;
  if (!longhornVolume) {
    throw new BarmanRestoreError(`PVC ${namespace}/${primaryPodName} has no volumeName — Longhorn binding incomplete?`, 409);
  }

  // 2. Create a Longhorn-native Snapshot CR. Name + labels mirror
  // postgres-restore's pattern so recoverInterruptedRestore cleans it
  // up if we crash before consuming it.
  const ts = Date.now();
  const snapshotName = `barman-promote-${ts}`;
  const snapBody = {
    apiVersion: `${LONGHORN_GROUP}/${LONGHORN_VERSION}`,
    kind: 'Snapshot',
    metadata: {
      name: snapshotName,
      namespace: LONGHORN_NS,
      labels: {
        'insula.host/pitr-restore': 'true',
        'insula.host/pitr-namespace': sourceNamespace,
        'insula.host/barman-promote': 'true',
      },
    },
    spec: {
      createSnapshot: true,
      volume: longhornVolume,
      labels: { source: 'barman-promote', restoredCluster: restoredClusterName },
    },
  };
  try {
    await custom.createNamespacedCustomObject({
      group: LONGHORN_GROUP, version: LONGHORN_VERSION, namespace: LONGHORN_NS, plural: 'snapshots', body: snapBody,
    } as unknown as Parameters<typeof custom.createNamespacedCustomObject>[0]);
  } catch (err) {
    throw new BarmanRestoreError(`Longhorn snapshot create failed: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  log?.info?.({ snapshotName, longhornVolume, restoredClusterName }, 'barman-promote: Longhorn snapshot created, polling readyToUse');

  // 3. Poll readyToUse=true. Longhorn-native CoW is fast (~seconds)
  // but on a busy node it can stretch; configurable timeout.
  // Operator escape hatch: `BARMAN_PROMOTE_SNAPSHOT_TIMEOUT_MS` env on
  // platform-api overrides the 60s default. Set higher for production
  // hardware under load; lower for predictable test envs.
  const envTimeout = Number.parseInt(process.env.BARMAN_PROMOTE_SNAPSHOT_TIMEOUT_MS ?? '', 10);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 60_000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let snap: { readonly status?: { readonly readyToUse?: boolean } };
    try {
      snap = await custom.getNamespacedCustomObject({
        group: LONGHORN_GROUP, version: LONGHORN_VERSION, namespace: LONGHORN_NS, plural: 'snapshots', name: snapshotName,
      } as unknown as Parameters<typeof custom.getNamespacedCustomObject>[0]) as never;
    } catch (err) {
      log?.warn?.({ err: err instanceof Error ? err.message : String(err) }, 'barman-promote: snapshot read failed during poll; retrying');
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }
    if (snap.status?.readyToUse === true) {
      return { snapshotName, longhornVolume };
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new BarmanRestoreError(
    `Longhorn snapshot ${snapshotName} did not reach readyToUse=true within ${timeoutMs}ms. Check Longhorn node health (kubectl -n longhorn-system get volumes.longhorn.io ${longhornVolume}).`,
    504,
  );
}

interface PromoteDeps {
  /** Full K8sClients — passed verbatim to createPitrJob /
   *  getPlatformApiImage which require the complete bundle. Using the
   *  shared type (instead of a structural subset) keeps the promote
   *  flow compile-time-safe against future K8sClients additions. */
  readonly k8s: K8sClients;
  readonly db: Database;
}

/**
 * Orchestrate the cutover. Synchronous setup (snapshot + lock + Job
 * creation); the Job pod runs the existing PITR orchestrator + the
 * post-success restored-cluster delete. Returns 202-shaped data; caller
 * polls /admin/postgres-restore/status for live progress (same modal
 * as a normal PITR).
 */
export async function promoteRestoredCluster(
  deps: PromoteDeps,
  inputs: PromoteRestoredClusterInputs,
  log?: Pick<Logger, 'info' | 'warn'>,
): Promise<PromoteRestoredClusterResult> {
  // 1. Type-to-confirm gate. Server-side enforcement so a UI bug or
  // bad cURL can't skip the operator's typed confirmation.
  if (inputs.confirmSourceClusterName !== inputs.sourceClusterName) {
    throw new BarmanRestoreError(
      `confirmSourceClusterName (${inputs.confirmSourceClusterName}) does not match sourceClusterName (${inputs.sourceClusterName}) — refusing destructive cutover`,
      409,
    );
  }
  // 2. Standard name validation.
  validateClusterName(inputs.namespace, 'namespace');
  validateClusterName(inputs.restoredClusterName, 'restoredClusterName');
  validateClusterName(inputs.sourceClusterName, 'sourceClusterName');
  if (inputs.restoredClusterName === inputs.sourceClusterName) {
    throw new BarmanRestoreError('restoredClusterName must differ from sourceClusterName', 400);
  }

  // 3. Fetch restored cluster, check managed-by label + ready state.
  let restored: {
    readonly metadata?: { readonly labels?: Record<string, string> };
    readonly status?: { readonly readyInstances?: number; readonly currentPrimary?: string };
  };
  try {
    restored = await deps.k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.namespace, plural: CLUSTERS_PLURAL, name: inputs.restoredClusterName,
    } as unknown as Parameters<typeof deps.k8s.custom.getNamespacedCustomObject>[0]) as never;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      throw new BarmanRestoreError(`Restored cluster ${inputs.namespace}/${inputs.restoredClusterName} not found`, 404);
    }
    throw err;
  }
  const managedBy = restored.metadata?.labels?.['app.kubernetes.io/managed-by'];
  if (managedBy !== 'platform-api-postgres-barman-restore') {
    throw new BarmanRestoreError(`Cluster ${inputs.namespace}/${inputs.restoredClusterName} is not managed by barman-restore`, 403);
  }
  if ((restored.status?.readyInstances ?? 0) < 1 || !restored.status?.currentPrimary) {
    throw new BarmanRestoreError(`Restored cluster ${inputs.namespace}/${inputs.restoredClusterName} is not Ready (readyInstances=${restored.status?.readyInstances ?? 0}) — promote requires the restored cluster's primary up so its data is snapshot-able`, 409);
  }

  // 4. Fetch source cluster — must exist + have bootstrap.initdb so
  // the PITR orchestrator's preflight can read it. (The orchestrator
  // reads live source at preflight; we just check it's present here
  // so we fail fast before taking a snapshot.)
  let source: { readonly spec?: { readonly bootstrap?: { readonly initdb?: { readonly database?: string } } } };
  try {
    source = await deps.k8s.custom.getNamespacedCustomObject({
      group: CNPG_GROUP, version: CNPG_VERSION, namespace: inputs.namespace, plural: CLUSTERS_PLURAL, name: inputs.sourceClusterName,
    } as unknown as Parameters<typeof deps.k8s.custom.getNamespacedCustomObject>[0]) as never;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (code === 404) {
      throw new BarmanRestoreError(`Source cluster ${inputs.namespace}/${inputs.sourceClusterName} not found — cannot promote into a non-existent source`, 404);
    }
    throw err;
  }
  if (!source.spec?.bootstrap?.initdb?.database) {
    throw new BarmanRestoreError(
      `Source cluster ${inputs.namespace}/${inputs.sourceClusterName} has no spec.bootstrap.initdb.database — PITR orchestrator's preflight would reject. Operator may need to normalize the source's bootstrap manually before promote (see normalize-bootstrap CI guard).`,
      422,
    );
  }

  // 5. Pre-check the PITR cluster-wide lock. Refuse if a PITR (or
  // a previous promote) is already in flight.
  const lockState = await isPostgresRestoreInProgressClusterWide(deps.db);
  if (lockState.inProgress) {
    throw new BarmanRestoreError(
      `A postgres restore is already in progress (snapshot=${lockState.snapshot ?? 'unknown'}, source=${lockState.source}). Wait for it to finish.`,
      409,
    );
  }

  // 6. Acquire the lock atomically. Same machinery the PITR route uses.
  // Lock keyed with a human-readable placeholder snapshot label — gives
  // operators inspecting the status modal during the snapshot-take
  // window (~5-60s) a clear "(taking snapshot ...)" message instead of
  // an opaque pending-<timestamp>. The Job's own writePersistedLock
  // overwrites this with the real snapshot name once orchestration
  // begins (review MEDIUM 2026-05-23).
  try {
    await acquirePitrLockOrThrow(deps.db, {
      clusterNamespace: inputs.namespace,
      clusterName: inputs.sourceClusterName,
      snapshotName: `(taking snapshot of ${inputs.restoredClusterName})`,
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 409) {
      throw new BarmanRestoreError((err as Error).message, 409);
    }
    throw err;
  }

  // From here, ALL error paths must release the lock — the Job pod
  // doesn't exist yet so its finally block can't run.
  let snapshot: { readonly snapshotName: string; readonly longhornVolume: string };
  try {
    snapshot = await takeLonghornSnapshotOfRestoredCluster(
      deps.k8s.custom, deps.k8s.core, inputs.namespace, inputs.restoredClusterName, inputs.namespace, log,
    );
  } catch (err) {
    await releasePitrLock(deps.db, { failed: true, error: (err as Error).message, taskKind: 'postgres.barman-promote' }).catch(() => undefined);
    throw err;
  }
  log?.info?.({ snapshot: snapshot.snapshotName }, 'barman-promote: snapshot ready, creating PITR Job');

  let image: string;
  try {
    image = await getPlatformApiImage(deps.k8s);
  } catch (err) {
    await releasePitrLock(deps.db, { failed: true, error: (err as Error).message, taskKind: 'postgres.barman-promote' }).catch(() => undefined);
    throw new BarmanRestoreError(`Failed to resolve platform-api image: ${(err as Error).message}`, 500);
  }

  // 7. Create the PITR Job, passing BARMAN_PROMOTE_* env vars so
  // pitr-job.ts knows to delete the side-by-side cluster on success.
  let job: { readonly jobName: string; readonly namespace: string };
  try {
    job = await createPitrJob(deps.k8s, {
      clusterNamespace: inputs.namespace,
      clusterName: inputs.sourceClusterName,
      snapshotName: snapshot.snapshotName,
      recoveryTargetTime: null,
      actorUserId: inputs.actorUserId,
      image,
      extraEnv: [
        { name: 'BARMAN_PROMOTE_MODE', value: 'true' },
        { name: 'BARMAN_PROMOTE_RESTORED_CLUSTER', value: inputs.restoredClusterName },
      ],
    });
  } catch (err) {
    await releasePitrLock(deps.db, { failed: true, error: (err as Error).message, taskKind: 'postgres.barman-promote' }).catch(() => undefined);
    throw new BarmanRestoreError(`Failed to create PITR Job: ${(err as Error).message}`, 500);
  }

  return {
    snapshotName: snapshot.snapshotName,
    jobName: job.jobName,
    jobNamespace: job.namespace,
    sourceClusterName: inputs.sourceClusterName,
    restoredClusterName: inputs.restoredClusterName,
    namespace: inputs.namespace,
  };
}
