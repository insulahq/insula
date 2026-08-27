/**
 * Per-node host-migration status, read from the ConfigMaps the
 * host-config-reconciler DaemonSet publishes.
 *
 * Why this route exists: a host-migration that fails blocks every later one
 * (ADR-045 W10c halts the chain on purpose, ADR-056 scopes that), and until now
 * the only way to discover it was to SSH to a node and run `insula host-config`.
 * The DEV cluster sat at `0 applied, 11 pending` behind one failure for five
 * weeks before anyone looked. This makes it visible.
 *
 * Data path — deliberately relay-only, so it costs no new privilege:
 *   platform-ops converge → node-local status.json
 *     → host-config-reconciler (already on every node, already publishes one
 *       per-node ConfigMap, reads the file through a READ-ONLY mount)
 *     → host-config-drift-<node>.data.snapshot.hostMigrations
 *     → here.
 *
 * The backend never touches a node. A retry is therefore not something this API
 * can perform: the converge is what applies migrations, it already runs hourly,
 * and it picks up a fixed condition on its own. What the UI offers instead is
 * the state, the reason, and the exact commands — see the runbook.
 */
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type {
  HostMigrationNodeStatus,
  HostMigrationStatusResponse,
  HostMigrationItem,
} from '@insula/api-contracts';

const DRIFT_NS = 'platform-system';
const DRIFT_CM_PREFIX = 'host-config-drift-';

export const HOST_MIGRATION_RUNBOOK_URL =
  'https://github.com/insulahq/insula/blob/main/docs/operations/HOST_MIGRATION_TROUBLESHOOTING.md';

/**
 * Fix a node whose converge timer was never installed. Root-shell on the node.
 *
 * There is no in-cluster remedy on purpose: the host-config reconciler is
 * observe-only by design (read-only mounts, all capabilities dropped,
 * readOnlyRootFilesystem), so nothing in the cluster can write a systemd unit.
 * Re-running the installer is what lays the timers down; it is idempotent.
 */
export const NEVER_CONVERGED_REMEDIATION: string[] = [
  '# On the affected node, as root:',
  'insula --version                 # confirm the CLI is present',
  'systemctl list-timers | grep platform-ops   # expect TWO timers; none means this bug',
  'insula self-upgrade              # installs/repairs the timers, then converges',
  '# If the timers are still absent, re-run the installer (idempotent):',
  'insula bootstrap',
  '# Verify:',
  'systemctl start platform-ops-host-config.service',
  'ls /var/lib/insula/host-migrations   # should no longer be empty',
];

/** Fix a node the reconciler DaemonSet is not covering at all. */
export const RECONCILER_REMEDIATION: string[] = [
  '# The host-config-reconciler DaemonSet has no pod on this node.',
  'kubectl -n platform-system get ds host-config-reconciler',
  'kubectl -n platform-system get pods -l app=host-config-reconciler -o wide',
  '# Usually a taint the DaemonSet does not tolerate, or the node is NotReady:',
  'kubectl describe node <node> | grep -A5 Taints',
];

interface RelayedItem {
  key?: unknown;
  state?: unknown;
  error?: unknown;
  attempt?: unknown;
  failingSince?: unknown;
  skipReason?: unknown;
}

const STATES = new Set([
  'applied',
  'already-applied',
  'would-run',
  'run-failed',
  'blocked',
  'skipped',
  'invalid',
]);

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Pure: turn one relayed snapshot into a node status. Exported for tests —
 * the parsing has to survive a node that has never converged, an older
 * reconciler that does not relay migrations at all, and a malformed document,
 * without any of those looking like a failed migration.
 */
/**
 * How long a node may legitimately show no converge before it counts as broken.
 *
 * The converge timer is `OnCalendar=hourly` with `RandomizedDelaySec=900`, so
 * the worst honest wait after a fresh join is ~75 minutes. Two hours clears
 * that with room to spare.
 *
 * This window is the whole reason the alert is trustworthy. The original relay
 * deliberately treated "no data" as benign to avoid crying wolf on every fresh
 * install — correct instinct, wrong conclusion, because it also silenced the
 * permanent case. Gate on AGE and both are right: quiet while a new node is
 * still within its first converge, loud once it provably missed one.
 */
export const CONVERGE_GRACE_MS = 2 * 60 * 60 * 1000;

export function interpretNodeSnapshot(
  node: string,
  snapshotRaw: string | undefined,
  /** Node age in ms. Unknown/NaN → give the benefit of the doubt (stay quiet). */
  nodeAgeMs?: number,
): HostMigrationNodeStatus {
  const pastGrace = typeof nodeAgeMs === 'number'
    && Number.isFinite(nodeAgeMs)
    && nodeAgeMs > CONVERGE_GRACE_MS;
  const empty = (
    note: string,
    extra: Partial<HostMigrationNodeStatus> = {},
  ): HostMigrationNodeStatus => ({
    node,
    collectedAt: null,
    mode: null,
    source: null,
    ok: null,
    appliedCount: 0,
    failedCount: 0,
    blockedCount: 0,
    pendingCount: 0,
    skippedCount: 0,
    invalidCount: 0,
    reason: null,
    items: [],
    note,
    ...extra,
  });

  if (!snapshotRaw) {
    if (!pastGrace) return empty('No report from this node yet.');
    return empty(
      'The host-config reconciler is not publishing for this node, so nothing can be reported '
        + 'about it. It publishes every 60s, so this is not a delay.',
      { reconcilerMissing: true, remediation: RECONCILER_REMEDIATION },
    );
  }

  let snap: { hostMigrations?: unknown };
  try {
    snap = JSON.parse(snapshotRaw) as { hostMigrations?: unknown };
  } catch {
    return empty('This node reported an unreadable snapshot.');
  }

  const hm = snap.hostMigrations as Record<string, unknown> | undefined | null;
  if (!hm || typeof hm !== 'object') {
    // Within the grace window this is genuinely "not yet" — a fresh node, or an
    // older reconciler that predates the relay. Past it, the relay is working
    // and simply has no host-migration state to carry, which means the converge
    // has never run here and nothing is going to run it.
    if (!pastGrace) return empty('This node has not reported host-migration state yet.');
    return empty(
      'This node has NEVER converged — no host-migration has ever run on it, and it is well past '
        + 'the hourly converge window. The converge timer is missing, so this will not fix itself.',
      { neverConverged: true, remediation: NEVER_CONVERGED_REMEDIATION },
    );
  }

  const rawItems = Array.isArray(hm['items']) ? (hm['items'] as RelayedItem[]) : [];
  const items: HostMigrationItem[] = rawItems.flatMap((i) => {
    const key = str(i.key);
    const state = str(i.state);
    if (!key || !state || !STATES.has(state)) return [];
    return [
      {
        key,
        state: state as HostMigrationItem['state'],
        error: str(i.error),
        attempt: num(i.attempt),
        failingSince: str(i.failingSince),
        skipReason: str(i.skipReason),
      },
    ];
  });

  // Take max(relayed, recounted) — both halves matter, in opposite directions:
  //
  //  - recounting stops a stale or older relay from claiming "0 failed" while
  //    shipping a failed item (it can never hide something we can see);
  //  - honouring the relayed counter stops a *truncated* list from under-
  //    reporting (the relay caps items to keep the ConfigMap under etcd's ~1 MiB
  //    limit, and counts there are derived before capping, so they stay exact).
  //
  // Both directions fail toward "needs attention", which is the safe way for a
  // health indicator to be wrong.
  const count = (s: string, relayed: unknown): number =>
    Math.max(items.filter((i) => i.state === s).length, Math.max(0, int(relayed)));

  // `appliedCount` from the relay counts only what ran IN THAT PASS — an
  // already-applied script `continue`s before the counter (host-migrations.ts),
  // and in enforce mode `would-run` never appears at all. So a fully caught-up
  // node relays `0 applied, 0 pending`, which on screen is indistinguishable
  // from a node that has never run anything — the very ambiguity this feature
  // exists to remove. Report the CUMULATIVE state instead: applied + already-
  // applied. max() with the relayed value keeps it honest if the item list was
  // truncated (applied items are the first the relay drops).
  return {
    node,
    collectedAt: str(hm['collectedAt']),
    mode: str(hm['mode']),
    source: str(hm['source']),
    ok: typeof hm['ok'] === 'boolean' ? (hm['ok'] as boolean) : null,
    appliedCount: Math.max(
      int(hm['appliedCount']),
      items.filter((i) => i.state === 'applied' || i.state === 'already-applied').length,
    ),
    failedCount: count('run-failed', hm['failedCount']),
    blockedCount: count('blocked', hm['blockedCount']),
    pendingCount: count('would-run', hm['pendingCount']),
    skippedCount: count('skipped', hm['skippedCount']),
    invalidCount: items.filter((i) => i.state === 'invalid').length,
    // A whole-run refusal (catalog over MAX_SCRIPTS) arrives as ok:false with
    // NO items. Without carrying the reason, that node renders as a healthy
    // "0 applied" while running nothing at all.
    reason: str(hm['reason']),
    items,
  };
}

/**
 * True when any node needs attention. Deliberately broader than "something
 * failed":
 *  - `blocked` — nothing failed on this node's own account, it is queued behind
 *    another failure. That is the silent case the whole feature exists for.
 *  - `invalid` — a script that will NEVER run, because its name/version did not
 *    validate. Silent in exactly the same way.
 *  - `ok === false` — a whole-run refusal, which carries NO items at all, so
 *    every count above is legitimately zero.
 * Pending alone is NOT degraded: it is normal between a release and the next
 * hourly converge.
 */
export function isDegraded(nodes: readonly HostMigrationNodeStatus[]): boolean {
  return nodes.some(
    (n) =>
      n.failedCount > 0
      || n.blockedCount > 0
      || n.invalidCount > 0
      || n.ok === false
      // A node that has NEVER converged is the worst case, not a neutral one:
      // every migration ever shipped is unapplied and nothing is retrying.
      // Before this, it rendered as "no report yet" and read as healthy.
      || n.neverConverged === true
      || n.reconcilerMissing === true,
  );
}

export async function readHostMigrationStatus(k8s: K8sClients): Promise<HostMigrationStatusResponse> {
  let snapshots: Array<{ node: string; raw: string | undefined }> = [];
  try {
    const list = (await k8s.core.listNamespacedConfigMap({
      namespace: DRIFT_NS,
    } as unknown as Parameters<typeof k8s.core.listNamespacedConfigMap>[0])) as {
      items?: Array<{ metadata?: { name?: string }; data?: Record<string, string> }>;
    };
    snapshots = (list.items ?? [])
      .filter((cm) => (cm.metadata?.name ?? '').startsWith(DRIFT_CM_PREFIX))
      .map((cm) => ({
        node: (cm.metadata?.name ?? '').slice(DRIFT_CM_PREFIX.length) || '(unknown)',
        raw: cm.data?.['snapshot'],
      }));
  } catch {
    snapshots = [];
  }

  // Node ages, for the grace window, AND coverage: listing only the drift
  // ConfigMaps means a node the reconciler never publishes for is simply absent
  // from the response, and an absent row is the one thing an operator cannot
  // notice. Best-effort — without the node list we still render what we have,
  // just with no ages (so nothing is accused of never converging).
  const ages = new Map<string, number>();
  try {
    const nodeList = (await k8s.core.listNode()) as {
      items?: Array<{ metadata?: { name?: string; creationTimestamp?: string | Date } }>;
    };
    for (const n of nodeList.items ?? []) {
      const name = n.metadata?.name;
      if (!name) continue;
      const created = n.metadata?.creationTimestamp;
      const ms = created ? new Date(created).getTime() : NaN;
      ages.set(name, Number.isFinite(ms) ? Date.now() - ms : Number.NaN);
      if (!snapshots.some((s) => s.node === name)) snapshots.push({ node: name, raw: undefined });
    }
  } catch {
    /* node list unavailable — keep the ConfigMap-derived view */
  }

  const nodes = snapshots
    .map((s) => interpretNodeSnapshot(s.node, s.raw, ages.get(s.node)))
    .sort((a, b) => a.node.localeCompare(b.node));

  return { nodes, degraded: isDegraded(nodes), runbookUrl: HOST_MIGRATION_RUNBOOK_URL };
}
