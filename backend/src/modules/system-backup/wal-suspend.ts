/**
 * DR safety helpers: temporarily suspend / resume CNPG WAL archiving on
 * a single Cluster CR without disturbing the rest of the wal-archive
 * state (ObjectStore CR, ScheduledBackup CR, `system_wal_archive_state`
 * DB row, audit log).
 *
 * Why a separate module from `wal-archive.ts`:
 *   - `wal-archive.ts` owns the full enable/disable lifecycle, including
 *     state-DB writes, ObjectStore CR creation, ScheduledBackup CR
 *     teardown, and audit-log rows. That's the *operator-initiated*
 *     path through the WAL Archive admin UI.
 *   - The DR safety mechanism wants a much narrower semantic: "the
 *     target this cluster archives to is frozen; pause archiving until
 *     the operator confirms data integrity and flips the target back to
 *     writable." On resume, archiving must pick up exactly where it
 *     left off — no ObjectStore re-creation, no schedule reset, no
 *     state-row touching. So we only patch `Cluster.spec.plugins[]` to
 *     detach/re-attach the `barman-cloud.cloudnative-pg.io` entry.
 *
 * Audit-log + DB-state writes belong at the CALLER (the mark-writable
 * route in A1 Phase C). This module is intentionally side-effect-free
 * except for the single Cluster CR patch.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import { readClusterCR } from './wal-archive.js';

const CNPG_GROUP = 'postgresql.cnpg.io';
const CNPG_VERSION = 'v1';
const BARMAN_PLUGIN_NAME = 'barman-cloud.cloudnative-pg.io';
const OBJECT_STORE_NAME = (cluster: string) => `${cluster}-objectstore`;

// Per-cluster mutex to serialize concurrent suspend/resume on the same
// Cluster CR. Without this, two simultaneous mark-writable POSTs for
// targets routing through the same cluster could each read the CR
// (seeing no barman plugin), build `[...existing, entry]` from stale
// state, and issue conflicting merge-patches. The second patch's
// `spec.plugins` is computed against the pre-first-patch snapshot and
// could either lose entries or produce a duplicate barman entry that
// the CNPG admission webhook rejects.
//
// Map key is `${namespace}/${cluster}`. The promise chain is single-
// threaded per key; the Map is unbounded but cluster count is small
// (≤ instances per platform) so leakage is bounded by cluster count.
const clusterLocks = new Map<string, Promise<unknown>>();

async function withClusterLock<T>(
  namespace: string,
  cluster: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${namespace}/${cluster}`;
  const prior = clusterLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const slot = new Promise<void>((resolve) => { release = resolve; });
  const next = prior.then(() => slot);
  clusterLocks.set(key, next);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    // Clean up the map entry IFF we're still the head — otherwise a
    // later caller has already pushed its own chain on top.
    if (clusterLocks.get(key) === next) {
      clusterLocks.delete(key);
    }
  }
}

// Structural shape we accept from any ClusterCR plugin list. Matches
// the readonly shape exported (transitively) from wal-archive.ts —
// `name` is `string | undefined` in that type because the K8s schema
// makes the field nominally optional even though every concrete entry
// carries it.
type PluginEntry = {
  readonly name?: string;
  readonly isWALArchiver?: boolean;
  readonly parameters?: Readonly<Record<string, string>>;
};

/**
 * Patch the Cluster CR's `spec.plugins[]` to remove the barman-cloud
 * plugin entry. Subsequent WAL writes from this cluster will be no-ops
 * (CNPG continues running, the operator just can't archive). Idempotent
 * — running twice is a no-op.
 *
 * Returns `true` when the plugin was attached and is now detached;
 * `false` when the cluster was already not archiving (already detached
 * or never enabled).
 */
export async function suspendCnpgArchiving(
  k8s: K8sClients,
  namespace: string,
  cluster: string,
): Promise<boolean> {
  return withClusterLock(namespace, cluster, async () => {
    const cr = await readClusterCR(k8s, namespace, cluster);
    if (!cr) {
      // Cluster doesn't exist (or is being torn down) — nothing to do.
      return false;
    }
    const existing = cr.spec?.plugins ?? [];
    const hadBarman = existing.some((p) => p.name === BARMAN_PLUGIN_NAME);
    if (!hadBarman) return false;
    const merged = existing.filter((p) => p.name !== BARMAN_PLUGIN_NAME);
    await patchPlugins(k8s, namespace, cluster, merged);
    return true;
  });
}

/**
 * Patch the Cluster CR's `spec.plugins[]` to re-attach the barman-cloud
 * entry with the provided ObjectStore reference. Default
 * `isWALArchiver = true` matches the post-enable steady state.
 * Idempotent — running twice keeps the same entry shape.
 *
 * Returns `true` when archiving was off and is now on; `false` when it
 * was already on (no patch needed).
 */
export async function resumeCnpgArchiving(
  k8s: K8sClients,
  namespace: string,
  cluster: string,
  options: { objectStoreName?: string; isWALArchiver?: boolean } = {},
): Promise<boolean> {
  return withClusterLock(namespace, cluster, async () => {
    const cr = await readClusterCR(k8s, namespace, cluster);
    if (!cr) {
      throw new Error(`CNPG cluster ${namespace}/${cluster} not found — cannot resume archiving`);
    }
    const existing = cr.spec?.plugins ?? [];
    if (existing.some((p) => p.name === BARMAN_PLUGIN_NAME)) {
      return false;
    }
    const entry: PluginEntry = {
      name: BARMAN_PLUGIN_NAME,
      isWALArchiver: options.isWALArchiver ?? true,
      parameters: { barmanObjectName: options.objectStoreName ?? OBJECT_STORE_NAME(cluster) },
    };
    await patchPlugins(k8s, namespace, cluster, [...existing, entry]);
    return true;
  });
}

async function patchPlugins(
  k8s: K8sClients,
  namespace: string,
  cluster: string,
  plugins: readonly PluginEntry[],
): Promise<void> {
  await (k8s.custom as unknown as {
    patchNamespacedCustomObject: (a: {
      group: string;
      version: string;
      namespace: string;
      plural: string;
      name: string;
      body: unknown;
    }, opts?: unknown) => Promise<unknown>;
  }).patchNamespacedCustomObject({
    group: CNPG_GROUP,
    version: CNPG_VERSION,
    namespace,
    plural: 'clusters',
    name: cluster,
    body: { spec: { plugins } },
  }, MERGE_PATCH);
}
