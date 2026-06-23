/**
 * Scoped post-namespace-delete volume reaper for tenant hard-delete.
 *
 * WHY: `applyDeleted` requests the namespace delete and then (historically)
 * dropped the tenant DB row immediately — while the namespace was still
 * Terminating and its volumes were still detaching. Two leaks resulted:
 *
 *   1. Released PVs (reclaimPolicy=Retain) whose claimRef is this namespace
 *      survive after the namespace is gone — the `pv-cleanup-released` hook
 *      runs BEFORE the namespace delete, so the PVs are still Bound when it
 *      polls and it reaps nothing in-band (it relies on a 2-min scheduler
 *      retry to catch up).
 *   2. A `volumes.longhorn.io` CR whose PV was already deleted (the common
 *      case for reclaimPolicy=Delete test tenants, where CSI races the
 *      namespace teardown) keeps its `status.kubernetesStatus.namespace`
 *      pointing at the dead namespace. The hook keys its reap on PV NAME, so
 *      once the PV is gone it can no longer find — let alone delete — the
 *      stranded volume CR. This is exactly the orphan the integration
 *      leak-guard (ci-no-leaked-test-tenants.sh Check 3) flags, and the one a
 *      prior session had to force-delete by hand.
 *
 * This helper runs AFTER `deleteNamespace`, scoped to the single tenant
 * namespace being hard-deleted (so it can never touch another tenant's or a
 * system volume), and reaps both classes by namespace — the gap the by-PV-name
 * hook cannot cover. `applyDeleted` calls it before dropping the DB row, so the
 * row is the LAST thing to go.
 *
 * It is best-effort and time-bounded: every delete tolerates 404, and on
 * timeout any straggler is still covered by the `pv-cleanup-released` retry +
 * the operator-driven Orphaned Volumes "Purge All" UI.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/** Minimal PV view the reaper needs (seam for tests). */
export interface ReapPv {
  readonly name: string;
  readonly claimNamespace: string | null;
  readonly phase: string;
}

/** Minimal Longhorn volume CR view (seam for tests). */
export interface ReapLonghornVolume {
  readonly name: string;
  readonly namespace: string | null;
}

export interface ReapDeps {
  readonly listPvs: () => Promise<readonly ReapPv[]>;
  readonly listLonghornVolumes: () => Promise<readonly ReapLonghornVolume[]>;
  readonly deletePv: (name: string) => Promise<void>;
  readonly deleteLonghornVolume: (name: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export interface ReapResult {
  readonly pvsReaped: readonly string[];
  readonly lhVolsReaped: readonly string[];
  /** True if a Bound PV for the namespace never released within the budget. */
  readonly timedOut: boolean;
}

export const DEFAULT_REAP_TIMEOUT_MS = 45_000;
export const DEFAULT_REAP_INTERVAL_MS = 3_000;

/**
 * Reap this namespace's Released PVs (+ their Longhorn volume CRs) and any
 * Longhorn volume CR still tagged with this namespace.
 *
 * The loop waits ONLY while a Bound PV for the namespace still exists — that is
 * precisely the window in which `deleteNamespace` deletes the PVC and the PV
 * transitions Bound → Released so we can reap it. Once no Bound PV remains for
 * the namespace and nothing new was reaped this pass, we're done — we do NOT
 * wait on the namespace object itself to finish terminating (other finalizers
 * are not our concern, and a no-storage tenant must return immediately rather
 * than block the delete path). This also keeps the reap O(1) under unit-test
 * mocks where the namespace never "disappears".
 *
 * Pure over the injected seam — unit-testable without a cluster.
 */
export async function reapNamespaceVolumes(
  deps: ReapDeps,
  namespace: string,
  opts: { readonly timeoutMs?: number; readonly intervalMs?: number } = {},
): Promise<ReapResult> {
  // Safety guard (mirrors orphaned-volumes/deleteOrphan): only ever act on
  // tenant namespaces. A non-tenant namespace here would be a caller bug.
  if (!namespace.startsWith('tenant-')) {
    return { pvsReaped: [], lhVolsReaped: [], timedOut: false };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_REAP_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  const reapedPvs = new Set<string>();
  const reapedVols = new Set<string>();
  const started = deps.now();

  for (;;) {
    const pvs = await deps.listPvs().catch(() => [] as ReapPv[]);
    let freshThisPass = 0;
    // Bound (or otherwise non-Released) PVs claimed by this namespace that
    // could still transition to Released — the only reason to keep waiting.
    let pendingBoundForNs = 0;
    for (const pv of pvs) {
      if (pv.claimNamespace !== namespace) continue;
      if (pv.phase !== 'Released') {
        // NEVER touch a non-Released PV — a Bound PV is still serving a live
        // pod and reaping it would be data loss. Just note it to keep waiting.
        pendingBoundForNs++;
        continue;
      }
      if (reapedPvs.has(pv.name)) continue;
      freshThisPass++;
      await deps.deletePv(pv.name).catch(() => undefined);
      // CSI convention: the Longhorn volume CR name == the PV name. Deleting
      // the PV alone never reclaims the volume CR under Retain semantics.
      await deps.deleteLonghornVolume(pv.name).catch(() => undefined);
      reapedPvs.add(pv.name);
      reapedVols.add(pv.name);
    }

    // Catch-all: Longhorn volume CRs still tagged with this namespace whose PV
    // is already gone (the by-PV-name hook is blind to these).
    const vols = await deps.listLonghornVolumes().catch(() => [] as ReapLonghornVolume[]);
    for (const v of vols) {
      if (v.namespace !== namespace) continue;
      if (reapedVols.has(v.name)) continue;
      freshThisPass++;
      await deps.deleteLonghornVolume(v.name).catch(() => undefined);
      reapedVols.add(v.name);
    }

    // Done once no Bound PV remains to release AND nothing new was reaped this
    // pass (eventual-consistency settled). A no-storage tenant exits on pass 1.
    if (pendingBoundForNs === 0 && freshThisPass === 0) {
      return { pvsReaped: [...reapedPvs], lhVolsReaped: [...reapedVols], timedOut: false };
    }
    if (deps.now() - started >= timeoutMs) {
      return { pvsReaped: [...reapedPvs], lhVolsReaped: [...reapedVols], timedOut: true };
    }
    await deps.sleep(intervalMs);
  }
}

interface RawPv {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly claimRef?: { readonly namespace?: string } };
  readonly status?: { readonly phase?: string };
}

interface RawLhVolume {
  readonly metadata?: { readonly name?: string };
  readonly status?: { readonly kubernetesStatus?: { readonly namespace?: string } };
}

function isNotFound(err: unknown): boolean {
  const status = (err as { statusCode?: number; code?: number }).statusCode
    ?? (err as { code?: number }).code
    ?? (err as { body?: { code?: number } }).body?.code;
  return status === 404;
}

/** Real K8s-backed deps for `reapNamespaceVolumes`. */
export function realReapDeps(k8s: K8sClients): ReapDeps {
  return {
    listPvs: async () => {
      const list = await k8s.core.listPersistentVolume({}) as { items?: readonly RawPv[] };
      return (list.items ?? [])
        .map((pv) => ({
          name: pv.metadata?.name ?? '',
          claimNamespace: pv.spec?.claimRef?.namespace ?? null,
          phase: pv.status?.phase ?? '',
        }))
        .filter((pv) => pv.name !== '');
    },
    listLonghornVolumes: async () => {
      const list = await k8s.custom.listNamespacedCustomObject({
        group: 'longhorn.io', version: 'v1beta2',
        namespace: 'longhorn-system', plural: 'volumes',
      } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0])
        .catch(() => ({ items: [] })) as { items?: readonly RawLhVolume[] };
      return (list.items ?? [])
        .map((v) => ({
          name: v.metadata?.name ?? '',
          namespace: v.status?.kubernetesStatus?.namespace ?? null,
        }))
        .filter((v) => v.name !== '');
    },
    deletePv: async (name) => {
      try {
        await k8s.core.deletePersistentVolume({ name });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
    deleteLonghornVolume: async (name) => {
      try {
        await k8s.custom.deleteNamespacedCustomObject({
          group: 'longhorn.io', version: 'v1beta2',
          namespace: 'longhorn-system', plural: 'volumes', name,
        } as unknown as Parameters<typeof k8s.custom.deleteNamespacedCustomObject>[0]);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
