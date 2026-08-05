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
export function interpretNodeSnapshot(node: string, snapshotRaw: string | undefined): HostMigrationNodeStatus {
  const empty = (note: string): HostMigrationNodeStatus => ({
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
    items: [],
    note,
  });

  if (!snapshotRaw) return empty('No report from this node yet.');

  let snap: { hostMigrations?: unknown };
  try {
    snap = JSON.parse(snapshotRaw) as { hostMigrations?: unknown };
  } catch {
    return empty('This node reported an unreadable snapshot.');
  }

  const hm = snap.hostMigrations as Record<string, unknown> | undefined | null;
  if (!hm || typeof hm !== 'object') {
    // An older reconciler that predates the relay, or a node that has never
    // converged. Neither is a migration problem — say so rather than showing a
    // scary zero.
    return empty('This node has not reported host-migration state yet.');
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

  // Recount here rather than trusting the relayed counters: the API is the
  // contract the UI renders, and a stale or older relay must not be able to
  // report "0 failed" while shipping a failed item.
  const count = (s: string): number => items.filter((i) => i.state === s).length;

  return {
    node,
    collectedAt: str(hm['collectedAt']),
    mode: str(hm['mode']),
    source: str(hm['source']),
    ok: typeof hm['ok'] === 'boolean' ? (hm['ok'] as boolean) : null,
    appliedCount: int(hm['appliedCount']),
    failedCount: count('run-failed'),
    blockedCount: count('blocked'),
    pendingCount: count('would-run'),
    skippedCount: count('skipped'),
    items,
  };
}

/** True when any node has a failed or blocked migration. */
export function isDegraded(nodes: readonly HostMigrationNodeStatus[]): boolean {
  return nodes.some((n) => n.failedCount > 0 || n.blockedCount > 0);
}

export async function readHostMigrationStatus(k8s: K8sClients): Promise<HostMigrationStatusResponse> {
  let nodes: HostMigrationNodeStatus[] = [];
  try {
    const list = (await k8s.core.listNamespacedConfigMap({
      namespace: DRIFT_NS,
    } as unknown as Parameters<typeof k8s.core.listNamespacedConfigMap>[0])) as {
      items?: Array<{ metadata?: { name?: string }; data?: Record<string, string> }>;
    };
    nodes = (list.items ?? [])
      .filter((cm) => (cm.metadata?.name ?? '').startsWith(DRIFT_CM_PREFIX))
      .map((cm) => {
        const node = (cm.metadata?.name ?? '').slice(DRIFT_CM_PREFIX.length) || '(unknown)';
        return interpretNodeSnapshot(node, cm.data?.['snapshot']);
      })
      .sort((a, b) => a.node.localeCompare(b.node));
  } catch {
    nodes = [];
  }
  return { nodes, degraded: isDegraded(nodes), runbookUrl: HOST_MIGRATION_RUNBOOK_URL };
}
