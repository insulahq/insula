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

const CNPG_GROUP = 'postgresql.cnpg.io';
const CNPG_VERSION = 'v1';
const CLUSTERS_PLURAL = 'clusters';

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
}

export interface CreateBarmanRestoreResult {
  readonly newClusterName: string;
  readonly namespace: string;
  readonly objectStoreName: string;
  readonly recoveryTargetTime: string | null;
  readonly clusterUid: string;
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
  if (inputs.newClusterName === inputs.sourceClusterName) {
    throw new BarmanRestoreError('newClusterName MUST differ from sourceClusterName — side-by-side restore creates a separate Cluster CR', 400);
  }
  if (inputs.recoveryTargetTime) {
    const t = new Date(inputs.recoveryTargetTime);
    if (Number.isNaN(t.getTime())) {
      throw new BarmanRestoreError(`recoveryTargetTime is not a parseable ISO-8601 timestamp: ${inputs.recoveryTargetTime}`, 422);
    }
  }
  const instances = inputs.instances ?? 1;
  if (!Number.isInteger(instances) || instances < 1 || instances > 5) {
    throw new BarmanRestoreError(`instances must be an integer 1..5; got ${instances}`, 422);
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

  const objectStore = getObjectStoreName(source);
  if (!objectStore) {
    throw new BarmanRestoreError(
      `Source cluster ${inputs.namespace}/${inputs.sourceClusterName} does not use the barman-cloud plugin — barman-cloud restore is only available for plugin-mode clusters`,
      422,
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

  const externalName = `${objectStore}-recovery-source`;
  const newCluster = {
    apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
    kind: 'Cluster',
    metadata: {
      name: inputs.newClusterName,
      namespace: inputs.namespace,
      labels: {
        'app.kubernetes.io/managed-by': 'platform-api-postgres-barman-restore',
        'platform.phoenix-host.net/barman-restore-source': inputs.sourceClusterName,
        ...(inputs.recoveryTargetTime
          ? { 'platform.phoenix-host.net/barman-restore-target-time-set': 'true' }
          : { 'platform.phoenix-host.net/barman-restore-target-time-set': 'false' }),
      },
      annotations: {
        ...(inputs.recoveryTargetTime
          ? { 'platform.phoenix-host.net/barman-restore-target-time': inputs.recoveryTargetTime }
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
              serverName: inputs.sourceClusterName,
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
