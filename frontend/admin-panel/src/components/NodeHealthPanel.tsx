import { useMemo, useState } from 'react';
import { Loader2, RefreshCw, AlertCircle, AlertTriangle, CheckCircle2, Wrench, Flame } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import { useNodeHealth, useNodeMemoryEvents, useReconcileNodeHealth, useStalePodCounts, type NodeHealthEntry, type NodeHealthSeverity } from '@/hooks/use-node-health';
import NodeRecoveryModal from '@/components/NodeRecoveryModal';
import { memoryEventBadgeClass, memoryEventLabel } from '@/lib/memory-event-label';
import NodeName from '@/components/nodes/NodeName';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import SortableHeader from '@/components/ui/SortableHeader';
import { useSortable, type SortAccessors } from '@/hooks/use-sortable';
import { useNodeLabel } from '@/hooks/use-node-labels';
import OutboundMailPorts from '@/components/nodes/OutboundMailPorts';

const SEVERITY_BADGE: Record<NodeHealthSeverity, 'error' | 'warning' | 'healthy'> = {
  critical: 'error',
  warning: 'warning',
  normal: 'healthy',
};

const SEVERITY_ICON: Record<NodeHealthSeverity, typeof CheckCircle2> = {
  critical: AlertCircle,
  warning: AlertTriangle,
  normal: CheckCircle2,
};

const SEVERITY_LABEL: Record<NodeHealthSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  normal: 'Healthy',
};

/** Worst first — the server's order (node-health scheduler: severity, then name). */
const SEVERITY_RANK: Record<NodeHealthSeverity, number> = { critical: 0, warning: 1, normal: 2 };
const NO_NODES: readonly NodeHealthEntry[] = [];
const TH_CLS = 'font-medium';
const TH_PAD = 'px-3 py-2';

function formatRelative(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))} h ago`;
  return `${Math.floor(ms / (24 * 60 * 60_000))} d ago`;
}

/**
 * Should the row offer "Recover…"?
 *
 * Severity alone is NOT enough. A node reboot leaves Failed pod records behind
 * while producing no evictions and no disk/memory pressure, so the node stays
 * `normal` and this column used to render a bare em-dash — with the recovery
 * modal, and every action in it, unreachable. Production sat on 17 such records
 * accumulated across four reboots with no way to clear them from the UI.
 *
 * NodeRecoveryModal's own `suggestedWhen` had ALREADY been fixed for exactly
 * this case (it keys on stalePods > 0, with a comment saying the pressure
 * heuristic "missed the single most common cause of stale records"). That fix
 * landed one level too deep: the modal suggested the right action, but the
 * button that opens it was still gated on severity. This is the outer half.
 *
 * `undefined` means the count could not be fetched — fall back to severity
 * rather than offering an action whose target set is unknown.
 */
function canRecover(entry: NodeHealthEntry, stalePods: number | undefined): boolean {
  return entry.severity !== 'normal' || (stalePods ?? 0) > 0;
}

/** Required outbound mail ports a fresh check found blocked — what made the node `warning`. */
function blockedMailPorts(entry: NodeHealthEntry): number[] {
  const mail = entry.outboundMail;
  if (!mail || mail.stale) return [];
  return mail.ports.filter((p) => p.required && p.status === 'blocked').map((p) => p.port);
}

function pressureSummary(entry: NodeHealthEntry): string {
  const parts: string[] = [];
  if (!entry.ready) parts.push('NotReady');
  if (entry.pressures.length > 0) parts.push(entry.pressures.map((p) => `${p}-pressure`).join(' + '));
  if (entry.csiDriversMissing.length > 0) parts.push(`CSI missing: ${entry.csiDriversMissing.join(', ')}`);
  if (entry.evictionsLastHour > 0) parts.push(`${entry.evictionsLastHour} evictions/h`);
  if (entry.diskUsedPct !== null) parts.push(`disk ${entry.diskUsedPct.toFixed(0)}%`);
  const blocked = blockedMailPorts(entry);
  if (blocked.length > 0) parts.push(`outbound mail port ${blocked.join('/')} blocked — ask the provider to unblock it`);
  return parts.length === 0 ? 'all clear' : parts.join(' · ');
}

export default function NodeHealthPanel() {
  const { data, isLoading, isError, error } = useNodeHealth();
  // Stale-pod counts gate the Recover button (see canRecover below). The modal
  // already fetches these; TanStack Query dedupes on the shared key, so
  // hoisting the hook here costs no extra request.
  const { data: stalePodCounts } = useStalePodCounts(true);
  const reconcile = useReconcileNodeHealth();
  const [recoveryNode, setRecoveryNode] = useState<NodeHealthEntry | null>(null);
  const nodeLabel = useNodeLabel();
  const nodeSort = useMemo<SortAccessors<NodeHealthEntry>>(() => ({
    name: (n) => nodeLabel(n.name),
    severity: (n) => SEVERITY_RANK[n.severity],
    ready: (n) => (n.ready ? 1 : 0),
    pressures: (n) => (n.pressures.length === 0 ? null : n.pressures.join(', ')),
    // Blocked ports the node needs first; unchecked nodes last.
    outboundMail: (n) => (n.outboundMail ? -blockedMailPorts(n).length : null),
    detail: pressureSummary,
  }), [nodeLabel]);
  const { sortedData: sortedNodes, sortKey, sortDirection, onSort } =
    useSortable(data?.data?.nodes ?? NO_NODES, 'severity', 'asc', nodeSort);
  const header = (label: string, key: string, className = TH_CLS) => (
    <SortableHeader label={label} sortKey={key} currentKey={sortKey} direction={sortDirection} onSort={onSort} padding={TH_PAD} className={className} />
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-gray-600 dark:text-gray-400">
        <Loader2 className="animate-spin" size={16} /> loading node health…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
        Failed to load node health: {(error as Error)?.message ?? 'unknown error'}
      </div>
    );
  }

  const summary = data?.data;
  if (!summary) return null;

  const lastTickLabel = formatRelative(summary.lastTickAt);
  const overallBadge = SEVERITY_BADGE[summary.overallSeverity];
  const OverallIcon = SEVERITY_ICON[summary.overallSeverity];

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <OverallIcon
            size={18}
            className={
              summary.overallSeverity === 'critical' ? 'text-red-600 dark:text-red-400'
              : summary.overallSeverity === 'warning' ? 'text-amber-600 dark:text-amber-400'
              : 'text-green-600 dark:text-green-400'
            }
          />
          <div>
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Overall: <StatusBadge status={overallBadge} label={SEVERITY_LABEL[summary.overallSeverity]} />
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {summary.nodes.length} node(s) · last tick {lastTickLabel}
            </div>
          </div>
        </div>
        <button
          onClick={() => reconcile.mutate()}
          disabled={reconcile.isPending}
          className="inline-flex items-center gap-1.5 rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="node-health-reconcile"
        >
          {reconcile.isPending ? <Loader2 className="animate-spin" size={12} /> : <RefreshCw size={12} />}
          Reconcile now
        </button>
      </div>

      {/* A refused or failed check used to end with the spinner and nothing else. */}
      {reconcile.isError && (
        <ErrorPanel error={extractOperatorError(reconcile.error)} compact testId="node-health-reconcile-error" />
      )}

      {sortedNodes.length === 0 ? (
        <div className="rounded border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">
          No nodes observed yet. The first reconciler tick fires ~90s after platform-api starts.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                {header('Node', 'name')}
                {header('Severity', 'severity')}
                {header('Ready', 'ready')}
                {header('Pressures', 'pressures')}
                {header('CSI drivers', 'csiDriversPresent')}
                {header('Evictions/h', 'evictionsLastHour', `${TH_CLS} text-right`)}
                {header('Mail ports out', 'outboundMail')}
                {header('Detail', 'detail')}
                <th className="px-3 py-2 font-medium text-right">Recover</th>
              </tr>
            </thead>
            <tbody>
              {sortedNodes.map((n) => {
                const Icon = SEVERITY_ICON[n.severity];
                return (
                  <tr key={n.name} className="border-t border-gray-100 dark:border-gray-700/40" data-testid={`node-health-row-${n.name}`}>
                    <td className="px-3 py-2 font-mono text-xs"><NodeName name={n.name} /></td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <Icon
                          size={14}
                          className={
                            n.severity === 'critical' ? 'text-red-600 dark:text-red-400'
                            : n.severity === 'warning' ? 'text-amber-600 dark:text-amber-400'
                            : 'text-green-600 dark:text-green-400'
                          }
                        />
                        <StatusBadge status={SEVERITY_BADGE[n.severity]} label={SEVERITY_LABEL[n.severity]} />
                      </span>
                    </td>
                    <td className="px-3 py-2">{n.ready ? '✓' : <span className="text-red-600 dark:text-red-400">✗</span>}</td>
                    <td className="px-3 py-2 text-xs">
                      {n.pressures.length === 0 ? (
                        <span className="text-gray-400">—</span>
                      ) : (
                        n.pressures.map((p) => (
                          <span
                            key={p}
                            className="mr-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                          >
                            {p}
                          </span>
                        ))
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={n.csiDriversMissing.length > 0 ? 'text-red-600 dark:text-red-400' : ''}>
                        {n.csiDriversPresent}/{n.csiDriversExpected}
                      </span>
                      {n.csiDriversMissing.length > 0 && (
                        <span className="ml-1 text-[10px] text-red-500 dark:text-red-400">missing: {n.csiDriversMissing.join(', ')}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {n.evictionsLastHour > 0 ? (
                        <span className="text-amber-600 dark:text-amber-400">{n.evictionsLastHour}</span>
                      ) : (
                        <span className="text-gray-400">0</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {n.outboundMail ? (
                        <OutboundMailPorts ports={n.outboundMail.ports} stale={n.outboundMail.stale} testId={`node-outbound-${n.name}`} />
                      ) : (
                        <span className="text-gray-400" title="This node's security-probe has not reported an outbound mail check yet." data-testid={`node-outbound-${n.name}-unchecked`}>
                          not checked
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-300">
                      {pressureSummary(n)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canRecover(n, stalePodCounts?.[n.name]) ? (
                        <button
                          type="button"
                          onClick={() => setRecoveryNode(n)}
                          className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                          data-testid={`recovery-open-${n.name}`}
                        >
                          <Wrench size={11} /> Recover…
                        </button>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <MemoryEventsCard />

      <div className="text-xs text-gray-500 dark:text-gray-400">
        Reconciler runs every 5 min. Notifications fire on severity transitions and re-fire every 24 h while a node remains warning/critical.
        Mail ports out: each node dials TCP 25, 465 and 587 on public mail servers every 15 min. A blocked 465/587 means apps on that node
        cannot send mail; a blocked 25 matters only on a mail node. The hosting provider blocks them, not the node. Recovery actions audit-log every run; see{' '}
        <code className="rounded bg-gray-100 px-1 py-0.5 text-[10px] dark:bg-gray-800">docs/operations/NODE_HEALTH_MONITORING.md</code> for the action catalogue.
      </div>

      {recoveryNode && (
        <NodeRecoveryModal entry={recoveryNode} onClose={() => setRecoveryNode(null)} />
      )}
    </div>
  );
}

/**
 * Recent kernel OOM kills, container OOM kills and kubelet evictions (30-day
 * window). The eviction design takes tenant pods first (platform-critical
 * PriorityClass + eviction-hard=memory.available<256Mi), so system-workload
 * rows are highlighted red — they should not be happening.
 */
function MemoryEventsCard() {
  const { data, isLoading, isError } = useNodeMemoryEvents();

  const events = data?.data.events ?? [];

  return (
    <div className="space-y-2" data-testid="memory-events-card">
      <div className="flex items-center gap-2">
        <Flame size={14} className="text-gray-500 dark:text-gray-400" />
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Memory events</span>
        <span className="text-xs text-gray-500 dark:text-gray-400">OOM kills + kubelet evictions, last 30 days</span>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 p-3 text-xs text-gray-500 dark:text-gray-400">
          <Loader2 className="animate-spin" size={12} /> loading memory events…
        </div>
      ) : isError ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
          Failed to load memory events.
        </div>
      ) : events.length === 0 ? (
        <div className="rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300">
          No OOM kills or evictions in the last 30 days — memory headroom is holding.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Node</th>
                <th className="px-3 py-2 font-medium">Workload</th>
                <th className="px-3 py-2 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t border-gray-100 dark:border-gray-700/40" data-testid={`memory-event-row-${e.id}`}>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-600 dark:text-gray-300">{formatRelative(e.occurredAt)}</td>
                  <td className="px-3 py-2">
                    <span className={memoryEventBadgeClass(e)} data-testid={`memory-event-label-${e.id}`}>
                      {memoryEventLabel(e)}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs"><NodeName name={e.nodeName} /></td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {e.podName ? (
                      <>
                        {e.podName}
                        {e.namespace && <span className="text-gray-400 dark:text-gray-500">@{e.namespace}</span>}
                      </>
                    ) : (
                      <span className="text-gray-400">node</span>
                    )}
                  </td>
                  <td className="max-w-md truncate px-3 py-2 text-xs text-gray-600 dark:text-gray-300" title={e.message}>
                    {e.message || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
