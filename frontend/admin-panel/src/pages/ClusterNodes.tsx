import { useState } from 'react';
import {
  Server, Loader2, AlertCircle, Edit, ShieldAlert, HardDrive, Cpu, AlertTriangle, MemoryStick, Boxes,
  Trash2, ChevronRight, ChevronDown, CheckCircle2, Activity, Terminal as TerminalIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { useClusterNodes, useDeleteNode, useNodeUsage } from '@/hooks/use-cluster-nodes';
import { CACHE_BAND, triadFigures, type TriadFigures } from '@/lib/resource-triad';
import { useNodeSubsystemHealth, type NodeSubsystemReport, type NodeSubsystemStatus } from '@/hooks/use-cluster-health';
import { useNodeHealth, type NodeHealthEntry } from '@/hooks/use-node-health';
import { useHostMigrationStatus } from '@/hooks/use-host-migrations';
import { useAuth } from '@/hooks/use-auth';
import type { AdminNode, ClusterNodeResponse, NodeIngressMode, HostMigrationNodeStatus } from '@insula/api-contracts';
import { nodeChecksForUpdatesHourly } from '@insula/api-contracts';
import NodeEditModal from '@/components/NodeEditModal';
import NodeDrainDeleteModal from '@/components/NodeDrainDeleteModal';
import NodeStorageCard from '@/components/NodeStorageCard';
import { useTerminalSessions } from '@/stores/terminal-sessions';
import FailbackReviewPanel from '@/components/outage/FailbackReviewPanel';

// Saturation thresholds shared by the per-node compact summary, the cluster
// health bar, and the in-card UsageBar. Mirrors UsageBar's scale so the
// header dot, the aggregate-bar pressure pill, and the in-detail bar all
// agree on what counts as amber vs. red.
const PRESSURE_AMBER = 75;
const PRESSURE_RED = 90;

interface NodeTriads {
  readonly cpu: TriadFigures | null;
  readonly memory: TriadFigures | null;
  readonly disk: TriadFigures | null;
}

/**
 * A node's CPU, memory and disk as in use / committed / free / total.
 *
 * From the usage reader (the dashboard's) when it answered for this node;
 * otherwise CPU and memory fall back to the node inventory's committed and
 * total, with in use unknown, and disk is not measured.
 */
function nodeTriads(node: ClusterNodeResponse, usage: AdminNode | undefined): NodeTriads {
  if (usage) {
    return {
      cpu: triadFigures(usage.cpu.inUse, usage.cpu.committed, usage.cpu.total),
      memory: triadFigures(usage.memory.inUse, usage.memory.committed, usage.memory.total, usage.memory.cache ?? null),
      disk: usage.disk ? triadFigures(usage.disk.inUse, usage.disk.committed, usage.disk.total) : null,
    };
  }
  const gib = (b: number) => b / 1024 ** 3;
  return {
    cpu: node.cpuMillicores != null && node.cpuMillicores > 0
      ? triadFigures(null, (node.cpuRequestsMillicores ?? 0) / 1000, node.cpuMillicores / 1000)
      : null,
    memory: node.memoryBytes != null && node.memoryBytes > 0
      ? triadFigures(null, gib(node.memoryRequestsBytes ?? 0), gib(node.memoryBytes))
      : null,
    disk: null,
  };
}

/** The share of the total committed, as the summary and the pressure chips read it. */
function committedPct(t: TriadFigures | null): number | null {
  return t ? Math.round(t.committedPct) : null;
}

function pctTone(pct: number | null): 'green' | 'amber' | 'red' | 'gray' {
  if (pct == null) return 'gray';
  if (pct >= PRESSURE_RED) return 'red';
  if (pct >= PRESSURE_AMBER) return 'amber';
  return 'green';
}

function isSubsystemUnhealthy(s: NodeSubsystemReport | undefined): boolean {
  if (!s) return false;
  return s.calico !== 'healthy' || s.longhornCsi !== 'healthy' || !s.csiDriverRegistered;
}

function staleness(lastSeenAt: string): { label: string; tone: 'fresh' | 'stale' | 'dead' } {
  const diff = Date.now() - new Date(lastSeenAt).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return { label: 'just now', tone: 'fresh' };
  if (mins < 5) return { label: `${mins}m ago`, tone: 'fresh' };
  if (mins < 30) return { label: `${mins}m ago`, tone: 'stale' };
  if (mins < 60 * 24) return { label: `${Math.floor(mins / 60)}h ago`, tone: 'dead' };
  return { label: `${Math.floor(mins / 60 / 24)}d ago`, tone: 'dead' };
}

function readyCondition(node: ClusterNodeResponse): 'Ready' | 'NotReady' | 'Unknown' {
  if (!node.statusConditions) return 'Unknown';
  const ready = node.statusConditions.find((c) => c.type === 'Ready');
  if (!ready) return 'Unknown';
  return ready.status === 'True' ? 'Ready' : 'NotReady';
}

interface ClusterNodesProps {
  /** When true, omit the page-level <h1> header so the panel can be embedded inside a tabbed layout (e.g. NodesAndStorage). */
  readonly embedded?: boolean;
}

export default function ClusterNodes({ embedded = false }: ClusterNodesProps = {}) {
  const { data, isLoading, error } = useClusterNodes();
  const { data: usageData, isError: usageFailed } = useNodeUsage();
  const usageByName = new Map<string, AdminNode>((usageData?.data ?? []).map((n) => [n.name, n]));
  const { data: subsystemData } = useNodeSubsystemHealth();
  const { data: nodeHealthData } = useNodeHealth();
  const nodes = (data?.data ?? []) as readonly ClusterNodeResponse[];
  const subsystemByName = new Map<string, NodeSubsystemReport>(
    (subsystemData?.data.nodes ?? []).map((s) => [s.nodeName, s]),
  );
  const nodeHealthByName = new Map<string, NodeHealthEntry>(
    (nodeHealthData?.data.nodes ?? []).map((n) => [n.name, n]),
  );
  // The node's insula CLI version (ADR-064): which release's host changes it can
  // apply. The status comes from the super_admin upgrade API — other roles see
  // the page without it.
  const { user } = useAuth();
  const { data: hostMigrationData } = useHostMigrationStatus(user?.role === 'super_admin');
  const cliByName = new Map<string, HostMigrationNodeStatus>(
    (hostMigrationData?.data.nodes ?? []).map((n) => [n.node, n]),
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-brand-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="cluster-nodes-page">
      {!embedded && (
        <div className="flex items-center gap-3">
          <Server size={28} className="text-brand-500" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Cluster Nodes</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Every node in the k3s cluster, with platform-managed role + host-tenant-workloads state.
              Labels on the k8s node are authoritative; edits here write the label first then refresh.
            </p>
          </div>
        </div>
      )}

      {/*
        Failback review sits above the node list because it is about a node
        that has just come back: the operator arrives here to confirm the node
        is healthy, and this is the thing the healthy node does not tell them.
        It renders nothing when no tenant is displaced.
      */}
      <FailbackReviewPanel />

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 dark:border-red-700 dark:bg-red-900/30">
          <p className="flex items-center gap-2 text-sm text-red-800 dark:text-red-200">
            <AlertCircle size={16} /> Failed to load nodes: {(error as Error).message}
          </p>
        </div>
      )}

      {nodes.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-12 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
          No nodes observed yet. The backend reconciler ticks every 60 seconds; check back shortly.
        </div>
      ) : (
        <>
          <ClusterHealthBar nodes={nodes} subsystemByName={subsystemByName} usageByName={usageByName} />
          {/* Without the live reader the cards fall back to the node inventory:
              committed and total are still right, in use and disk are not
              known. Said here, so the gap is not read as an idle node. */}
          {usageFailed && (
            <p
              className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
              data-testid="node-usage-unavailable"
            >
              Live usage could not be read, so in-use figures and disks are not shown. Committed and totals
              come from the node inventory, updated every minute.
            </p>
          )}
          <div className="space-y-3">
            {nodes.map((node) => (
              <NodeCard key={node.name} node={node} usage={usageByName.get(node.name)} subsystem={subsystemByName.get(node.name)} health={nodeHealthByName.get(node.name)} cli={cliByName.get(node.name)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Cluster-wide compact health bar ─────────────────────────────────────────
//
// Aggregates per-node pressure + subsystem state into a single scannable row
// shown above the node list. When everything is healthy: a single green
// "All systems healthy" chip. Otherwise: only the issue chips render — zero
// counts hide so the bar stays compact on healthy clusters.
function ClusterHealthBar({
  nodes,
  subsystemByName,
  usageByName,
}: {
  readonly nodes: readonly ClusterNodeResponse[];
  readonly subsystemByName: Map<string, NodeSubsystemReport>;
  readonly usageByName: Map<string, AdminNode>;
}) {
  let readyCount = 0;
  let notReadyCount = 0;
  let cordonedCount = 0;
  let drainedCount = 0;
  let cpuAmberCount = 0;
  let cpuRedCount = 0;
  let memAmberCount = 0;
  let memRedCount = 0;
  let subsystemBadCount = 0;

  for (const node of nodes) {
    const ready = readyCondition(node);
    if (ready === 'Ready') readyCount++;
    else notReadyCount++;
    if (node.cordoned && !node.drained) cordonedCount++;
    if (node.drained) drainedCount++;

    const triads = nodeTriads(node, usageByName.get(node.name));
    const cpuTone = pctTone(committedPct(triads.cpu));
    if (cpuTone === 'red') cpuRedCount++;
    else if (cpuTone === 'amber') cpuAmberCount++;

    const memTone = pctTone(committedPct(triads.memory));
    if (memTone === 'red') memRedCount++;
    else if (memTone === 'amber') memAmberCount++;

    if (isSubsystemUnhealthy(subsystemByName.get(node.name))) subsystemBadCount++;
  }

  const cpuTotal = cpuAmberCount + cpuRedCount;
  const memTotal = memAmberCount + memRedCount;
  const allHealthy =
    notReadyCount === 0 &&
    cordonedCount === 0 &&
    drainedCount === 0 &&
    cpuTotal === 0 &&
    memTotal === 0 &&
    subsystemBadCount === 0;

  return (
    <div
      data-testid="cluster-health-bar"
      role="status"
      aria-live="polite"
      className={clsx(
        'flex flex-wrap items-center gap-2 rounded-xl border px-4 py-2.5 text-xs',
        allHealthy
          ? 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20'
          : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800',
      )}
    >
      <Activity size={14} className="text-gray-500 dark:text-gray-400 shrink-0" />
      <span className="font-medium text-gray-700 dark:text-gray-200">
        {nodes.length} node{nodes.length !== 1 ? 's' : ''}
      </span>

      {allHealthy ? (
        <HealthChip tone="green" testId="health-all-ok">
          <CheckCircle2 size={12} /> All systems healthy
        </HealthChip>
      ) : (
        <>
          <HealthChip tone={notReadyCount > 0 ? 'red' : 'green'} testId="health-ready">
            {readyCount}/{nodes.length} Ready
          </HealthChip>
          {cpuTotal > 0 && (
            <HealthChip tone={cpuRedCount > 0 ? 'red' : 'amber'} testId="health-cpu">
              <Cpu size={12} /> CPU mostly committed: {cpuTotal} node{cpuTotal !== 1 ? 's' : ''}
              {cpuRedCount > 0 && ` (${cpuRedCount} ≥${PRESSURE_RED}%)`}
            </HealthChip>
          )}
          {memTotal > 0 && (
            <HealthChip tone={memRedCount > 0 ? 'red' : 'amber'} testId="health-memory">
              <MemoryStick size={12} /> Memory mostly committed: {memTotal} node{memTotal !== 1 ? 's' : ''}
              {memRedCount > 0 && ` (${memRedCount} ≥${PRESSURE_RED}%)`}
            </HealthChip>
          )}
          {subsystemBadCount > 0 && (
            <HealthChip tone="red" testId="health-subsystem">
              <ShieldAlert size={12} /> Worker subsystem issues: {subsystemBadCount}
            </HealthChip>
          )}
          {cordonedCount > 0 && (
            <HealthChip tone="amber" testId="health-cordoned">
              Cordoned: {cordonedCount}
            </HealthChip>
          )}
          {drainedCount > 0 && (
            <HealthChip tone="gray" testId="health-drained">
              Drained: {drainedCount}
            </HealthChip>
          )}
        </>
      )}
    </div>
  );
}

function HealthChip({
  tone,
  children,
  testId,
}: {
  readonly tone: 'green' | 'amber' | 'red' | 'gray';
  readonly children: React.ReactNode;
  readonly testId?: string;
}) {
  const cls = clsx(
    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium',
    tone === 'green' && 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    tone === 'amber' && 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    tone === 'red' && 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    tone === 'gray' && 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  );
  return <span className={cls} data-testid={testId}>{children}</span>;
}

function NodeCard({ node, usage, subsystem, health, cli }: {
  readonly node: ClusterNodeResponse;
  readonly usage?: AdminNode;
  readonly subsystem?: NodeSubsystemReport;
  readonly health?: NodeHealthEntry;
  readonly cli?: HostMigrationNodeStatus;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [drainOpen, setDrainOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Terminal lifecycle lives in the App-level store so sessions survive
  // navigation away from this page. The store handles step-up + WS +
  // xterm; this page just hands off the node name.
  const openTerminal = useTerminalSessions((s) => s.openFresh);
  // openingFor is the node currently inside an open-flow (covers both
  // the step-up phase and the slow Pod-provisioning phase). The
  // Terminal button shows a spinner + is disabled when its node is
  // the one being opened — prevents double-clicks and gives feedback
  // during the 5-30s window between click and modal-render.
  const openingFor = useTerminalSessions((s) => s.openingFor);
  const opening = openingFor === node.name;
  const deleteNodeMutation = useDeleteNode(node.name);
  const ready = readyCondition(node);
  const stale = staleness(node.lastSeenAt);
  // Surface alias when present, but always keep the k8s identity visible.
  const headerName = node.displayName?.trim() ? node.displayName : node.name;
  // A confirm names the node as the operator knows it, and as kubectl does.
  const confirmName = headerName !== node.name ? `"${headerName}" (${node.name})` : `"${node.name}"`;

  const triads = nodeTriads(node, usage);
  const subsystemBad = isSubsystemUnhealthy(subsystem);

  const handleDelete = () => {
    if (!confirm(`Delete node ${confirmName} from the cluster? The host itself stays running — kubectl delete + DB row removal only.`)) return;
    setDeleteError(null);
    deleteNodeMutation.mutate(undefined, {
      onError: (err) => setDeleteError(err instanceof Error ? err.message : 'Delete failed'),
    });
  };

  // Orphans have no live k8s node — drain/edit would hit NODE_NOT_FOUND
  // on the K8s readNode() call. Skip straight to the inventory cleanup,
  // which the backend already handles idempotently (404 from k8s is
  // treated as "already gone" and only the DB row is removed).
  const handleRemoveOrphan = () => {
    if (!confirm(`Remove orphan node ${confirmName} from the platform inventory? This DB row has no matching Kubernetes node — only the row will be deleted.`)) return;
    setDeleteError(null);
    deleteNodeMutation.mutate(undefined, {
      onError: (err) => setDeleteError(err instanceof Error ? err.message : 'Remove failed'),
    });
  };

  // The header row toggles expansion on click. The action buttons in the
  // header stop click propagation so the row click doesn't both open the
  // edit/drain/delete dialog AND toggle the card expansion. Keyboard
  // activation of those inner buttons fires a synthetic `click` event on
  // the button itself, which never bubbles up to the row's onClick — so no
  // onKeyDown guard is needed on the action wrapper.
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const toggle = () => setExpanded((v) => !v);
  // The chevron is a real <button> for keyboard / screen-reader users —
  // it carries aria-expanded + aria-controls and stops click propagation
  // (the row already has its own click handler). Mouse users can click
  // anywhere on the row to expand; the row itself is NOT given role=button
  // because it contains real <button> children (Edit / Drain / Delete /
  // chevron) — nested interactive elements under role=button is an ARIA
  // authoring violation.

  return (
    <div
      className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800"
      data-testid={`node-card-${node.name}`}
    >
      <div
        onClick={toggle}
        className={clsx(
          'flex items-center justify-between gap-3 px-5 py-4 cursor-pointer select-none',
          'hover:bg-gray-50 dark:hover:bg-gray-700/40',
          expanded && 'border-b border-gray-100 dark:border-gray-700',
          'rounded-xl',
        )}
        data-testid={`node-card-header-${node.name}`}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            type="button"
            onClick={(e) => { stop(e); toggle(); }}
            aria-expanded={expanded}
            aria-controls={`node-body-${node.name}`}
            aria-label={expanded ? `Collapse ${headerName}` : `Expand ${headerName}`}
            className="rounded p-0.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            data-testid={`node-card-toggle-${node.name}`}
          >
            {expanded
              ? <ChevronDown size={16} aria-hidden="true" />
              : <ChevronRight size={16} aria-hidden="true" />}
          </button>
          <Server size={20} className="text-gray-500 dark:text-gray-400 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{headerName}</h2>
              {node.displayName && node.displayName !== node.name && (
                <span className="font-mono text-xs text-gray-500 dark:text-gray-400" title="kubernetes node name">
                  ({node.name})
                </span>
              )}
              <RolePill role={node.role} />
              {health && health.severity !== 'normal' && (
                <span
                  className={clsx(
                    'rounded-full px-2 py-0.5 text-xs font-medium',
                    health.severity === 'critical'
                      ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                      : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
                  )}
                  title={
                    [
                      health.pressures.length > 0 ? `${health.pressures.join(' + ')}-pressure` : null,
                      health.csiDriversMissing.length > 0 ? `CSI missing: ${health.csiDriversMissing.join(', ')}` : null,
                      health.evictionsLastHour > 0 ? `${health.evictionsLastHour} pod evictions/h` : null,
                      !health.ready ? 'NotReady' : null,
                    ].filter(Boolean).join(' · ') || `severity=${health.severity}`
                  }
                  data-testid={`node-health-badge-${node.name}`}
                >
                  {health.severity === 'critical' ? '⚠ critical' : '! warning'}
                </span>
              )}
              {node.canHostTenantWorkloads ? (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300">
                  hosts tenants
                </span>
              ) : (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                  system only
                </span>
              )}
              {node.cordoned && !node.drained && (
                <span
                  className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300"
                  title="Node is cordoned (spec.unschedulable=true) — no new pods will schedule here"
                  data-testid={`node-cordoned-tag-${node.name}`}
                >
                  Cordoned
                </span>
              )}
              {node.drained && (
                <span
                  className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/40 dark:text-purple-300"
                  title="Tenants drained — no tenant workloads left. System services still run here; Delete Node moves them, then removes the node."
                  data-testid={`node-drained-tag-${node.name}`}
                >
                  Tenants drained
                </span>
              )}
              {!node.existsInKubernetes && (
                <span
                  className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-900/40 dark:text-rose-300"
                  title="This inventory row has no matching Kubernetes node — the node was removed from k3s out-of-band. Use 'Remove orphan' to clean up the row."
                  data-testid={`node-orphan-tag-${node.name}`}
                >
                  Orphaned
                </span>
              )}
              <IngressModePill mode={node.ingressMode} serving={ready === 'Ready'} />
              <ReadyPill ready={ready} />
              {subsystemBad && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300"
                  title="One or more worker subsystems are degraded — expand for details."
                  data-testid={`node-subsystem-tag-${node.name}`}
                >
                  <ShieldAlert size={10} /> subsystem
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {node.publicIp ?? 'no public IP'}
              {/* Dual-stack nodes carry a global IPv6 ExternalIP too. Show it:
                  it is the value an operator needs for `ingress_default_ipv6`
                  (which drives every apex AAAA), and before this there was no
                  way to read it short of SSH-ing to the node. Single-stack
                  clusters render nothing extra. */}
              {node.publicIpv6 && (
                <>
                  {' · '}
                  <span data-testid={`node-public-ipv6-${node.name}`} title="Global IPv6 (ExternalIP)">
                    {node.publicIpv6}
                  </span>
                </>
              )}
              {' · '}k3s {node.k3sVersion ?? '—'} · kubelet {node.kubeletVersion ?? '—'}
              {cli && (
                <span data-testid={`node-cli-version-${node.name}`}>
                  {' · '}insula {cli.cliVersion ?? 'not reported'}
                  {cli.cliBehind === true && (
                    <span
                      className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-700 dark:bg-gray-700 dark:text-gray-200"
                      title={`This node's CLI is older than the release the cluster runs. It updates during the next upgrade, or on its own ${
                        nodeChecksForUpdatesHourly(cli.cliVersion) ? 'hourly check' : 'daily check (a CLI from before 2026.10.7) — up to a day'}.`}
                    >
                      update pending
                    </span>
                  )}
                </span>
              )}
              {/* Unpinned, k3s takes the node's name from the hostname at its next
                  start — a hostname reset at boot then registers the machine as a
                  NEW node beside this one (seen on production). The upgrade's
                  host change pins it; this shows a node it has not reached. */}
              {cli?.nodeNamePin && cli.nodeNamePin.state !== 'pinned' && (
                <span
                  data-testid={`node-name-pin-${node.name}`}
                  className={`ml-1 rounded px-1.5 py-0.5 text-[11px] ${
                    cli.nodeNamePin.state === 'mismatch'
                      ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200'
                      : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
                  }`}
                  title={cli.nodeNamePin.state === 'mismatch'
                    ? (cli.nodeNamePin.pinnedAs === null
                      ? `k3s's config sets node-name in a form that cannot be read here. The node is registered as '${cli.nodeNamePin.registeredAs}'; write it as 'node-name: ${cli.nodeNamePin.registeredAs}' in /etc/rancher/k3s/config.yaml.d/10-node-name.yaml on the host.`
                      : `k3s's config names this node '${cli.nodeNamePin.pinnedAs}', but it is registered as '${cli.nodeNamePin.registeredAs}'. Its next k3s start would register it under the configured name — a new node. Check /etc/rancher/k3s/config.yaml and config.yaml.d on the host.`)
                    : `This node's name is not pinned in k3s's config, so k3s takes it from the hostname at its next start. If the hostname changes (a provider's cloud-init at reboot), the machine registers as a new node beside this one. The upgrade's host change pins it; until then, avoid renaming the host.`}
                >
                  {cli.nodeNamePin.state === 'mismatch' ? 'name mismatch' : 'name not pinned'}
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Compact resource summary — visible without expanding. Three dots
            with values; same colour scale as UsageBar so the operator can
            scan a list of cards without opening each. */}
        {/* A NotReady node's kubelet has stopped posting, so these numbers are
            frozen at whatever it last reported. Rendering them as live —
            "CPU 47% · Mem 36% · 38 pods · just now" next to a NotReady pill —
            is how the 2026-09-11 drill's Cluster Nodes page contradicted
            itself. Show the last-known values as explicitly stale instead. */}
        <div className="hidden md:flex items-center gap-3 text-xs text-gray-600 dark:text-gray-300 shrink-0" data-testid={`node-summary-${node.name}`}>
          {ready === 'Ready' ? (
            <>
              <span className="text-gray-400 dark:text-gray-500">committed</span>
              <SummaryDot label="CPU" pct={committedPct(triads.cpu)} />
              <SummaryDot label="Mem" pct={committedPct(triads.memory)} />
              <SummaryDot label="Disk" pct={committedPct(triads.disk)} />
              <span className="tabular-nums" title="Pods on this node">
                {usage?.pods ?? node.scheduledPods ?? '—'} pods
              </span>
            </>
          ) : (
            <span
              className="italic text-gray-400 dark:text-gray-500"
              data-testid={`node-metrics-stale-${node.name}`}
              title="The kubelet on this node has stopped reporting, so CPU, memory and pod counts are frozen at their last known values."
            >
              metrics unavailable — kubelet not reporting
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0" onClick={stop}>
          <span
            className={clsx(
              'text-xs whitespace-nowrap',
              stale.tone === 'fresh' && 'text-green-600 dark:text-green-400',
              stale.tone === 'stale' && 'text-amber-600 dark:text-amber-400',
              stale.tone === 'dead' && 'text-red-600 dark:text-red-400',
            )}
            title={`last seen: ${new Date(node.lastSeenAt).toLocaleString()}`}
          >
            {stale.label}
          </span>
          {node.existsInKubernetes ? (
            <>
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                data-testid={`edit-node-${node.name}-button`}
              >
                <Edit size={14} /> Edit
              </button>
              {ready === 'Ready' && (
                <button
                  type="button"
                  onClick={() => void openTerminal(node.name)}
                  disabled={opening}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-800 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-70 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200 dark:hover:bg-red-900/50"
                  data-testid={`terminal-node-${node.name}-button`}
                  title="Open a root shell on this node (audited)"
                >
                  {opening
                    ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    : <TerminalIcon size={14} />}
                  {opening ? 'Opening…' : 'Terminal'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setDrainOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50"
                data-testid={`drain-node-${node.name}-open-button`}
                title="Move this node's tenants off (system services stay); once drained, delete the node"
              >
                <AlertTriangle size={14} /> Drain Tenants
              </button>
              {node.drained && (
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleteNodeMutation.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm text-red-800 hover:bg-red-100 disabled:opacity-50 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200 dark:hover:bg-red-900/50"
                  data-testid={`delete-node-${node.name}-button`}
                  title="Remove the drained node from the cluster (kubectl delete node + DB row)"
                >
                  <Trash2 size={14} /> {deleteNodeMutation.isPending ? 'Deleting…' : 'Delete'}
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={handleRemoveOrphan}
              disabled={deleteNodeMutation.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm text-rose-800 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200 dark:hover:bg-rose-900/50"
              data-testid={`remove-orphan-node-${node.name}-button`}
              title="The Kubernetes node is gone; only the inventory row remains. Click to delete the row."
            >
              <Trash2 size={14} /> {deleteNodeMutation.isPending ? 'Removing…' : 'Remove orphan'}
            </button>
          )}
        </div>
      </div>

      {deleteError && (
        <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-xs text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200" data-testid={`delete-node-error-${node.name}`}>
          {deleteError}
        </div>
      )}

      {expanded && (
        <div id={`node-body-${node.name}`} data-testid={`node-card-body-${node.name}`}>
          {subsystem && <SubsystemHealthRow subsystem={subsystem} />}
          <NodeDetails node={node} triads={triads} pods={usage?.pods ?? node.scheduledPods ?? null} />
          <NodeStorageCard nodeName={node.name} />
        </div>
      )}

      {editOpen && <NodeEditModal node={node} onClose={() => setEditOpen(false)} />}
      {drainOpen && <NodeDrainDeleteModal node={node} onClose={() => setDrainOpen(false)} />}
      {/* Terminal modal is mounted at App-level via NodeTerminalHost so
          sessions survive route navigation. Click handler above calls
          openTerminal(node.name) on the store. */}
    </div>
  );
}

function SummaryDot({ label, pct }: { readonly label: string; readonly pct: number | null }) {
  const tone = pctTone(pct);
  const dotClass = clsx(
    'inline-block h-2 w-2 rounded-full',
    tone === 'green' && 'bg-green-500',
    tone === 'amber' && 'bg-amber-500',
    tone === 'red' && 'bg-red-500',
    tone === 'gray' && 'bg-gray-300 dark:bg-gray-600',
  );
  return (
    <span className="inline-flex items-center gap-1 tabular-nums" title={`${label}: ${pct == null ? 'not measured' : `${pct}% of the node's total is committed`}`}>
      <span className={dotClass} />
      {label} {pct == null ? '—' : `${pct}%`}
    </span>
  );
}

function IngressModePill({ mode, serving = true }: { readonly mode: NodeIngressMode; readonly serving?: boolean }) {
  const styles = {
    all: { className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300', label: 'ingress: all' },
    local: { className: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300', label: 'ingress: local' },
    none: { className: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300', label: 'ingress: none' },
  } as const;
  const s = styles[mode];
  // The pill states CONFIGURATION, but on an offline node it reads as a
  // capability claim — the drill's dead node advertised "ingress: all" while
  // every request to its address timed out. The platform does not own DNS, so
  // its records stay published until an operator removes them; the least we
  // can do is stop the UI implying the node is still serving.
  if (!serving && mode !== 'none') {
    return (
      <span
        className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-600 line-through decoration-red-500/70 dark:bg-gray-700 dark:text-gray-300"
        title="This node is configured for ingress but is offline: traffic sent to its address will fail. The platform does not manage DNS — withdraw its records manually if the outage will be long."
      >
        {s.label}
      </span>
    );
  }
  return <span className={clsx('rounded-full px-2 py-0.5 text-xs font-medium', s.className)}>{s.label}</span>;
}

function SubsystemHealthRow({ subsystem }: { readonly subsystem: NodeSubsystemReport }) {
  const allHealthy = subsystem.calico === 'healthy' && subsystem.longhornCsi === 'healthy' && subsystem.csiDriverRegistered;
  if (allHealthy) return null;

  // Which subsystem is actually broken decides what the operator is told. CSI
  // owns PVC attach; Calico owns pod networking and NetworkPolicy.
  const cniBroken = subsystem.calico !== 'healthy';
  const csiBroken = subsystem.longhornCsi !== 'healthy' || !subsystem.csiDriverRegistered;

  const stateClass = (s: NodeSubsystemStatus): string => clsx(
    'rounded-full px-2 py-0.5 text-xs font-medium',
    s === 'healthy' && 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    s === 'degraded' && 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    s === 'missing' && 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  );

  return (
    <div className="border-y border-amber-200 bg-amber-50 px-5 py-3 text-xs dark:border-amber-800 dark:bg-amber-900/20" data-testid={`node-subsystem-${subsystem.nodeName}`}>
      <div className="flex items-center gap-2 mb-1">
        <ShieldAlert size={14} className="text-amber-700 dark:text-amber-400" />
        <span className="font-semibold text-amber-900 dark:text-amber-200">Worker subsystem issues</span>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-amber-900 dark:text-amber-200">
        <span className="inline-flex items-center gap-1.5">
          Calico CNI: <span className={stateClass(subsystem.calico)}>{subsystem.calico}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          Longhorn CSI: <span className={stateClass(subsystem.longhornCsi)}>{subsystem.longhornCsi}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          CSI driver registered: {subsystem.csiDriverRegistered ? '✓' : '✗'}
        </span>
      </div>
      {(subsystem.calicoMessage || subsystem.longhornCsiMessage) && (
        <ul className="mt-2 space-y-0.5 font-mono text-amber-900 dark:text-amber-300">
          {subsystem.calicoMessage && <li>calico: {subsystem.calicoMessage}</li>}
          {subsystem.longhornCsiMessage && <li>longhorn-csi: {subsystem.longhornCsiMessage}</li>}
        </ul>
      )}
      {/* Consequence and remedy both used to be a single unconditional line:
          "pods will fail to attach PVCs — drain + re-bootstrap". It was wrong
          twice over. PVC attach is a CSI concern, so it was misleading whenever
          the fault was Calico (networking); and drain + re-bootstrap is a
          multi-minute outage for every workload on the node, offered as the
          FIRST move for conditions that are usually a one-line fix. Reported by
          an operator whose "CNI error" turned out to be a missing package. */}
      <div className="mt-2 space-y-1 text-amber-800 dark:text-amber-300">
        <p>
          {cniBroken && csiBroken
            ? 'Networking and storage on this node are both degraded: pods here may be unreachable and may fail to attach PVCs.'
            : cniBroken
              ? 'Pod networking on this node is degraded. NetworkPolicy may not be programmed while calico-node is not Ready, so tenant isolation is affected — treat this as urgent.'
              : 'Tenant pods pinned to this node will fail to attach PVCs.'}
        </p>
        {cniBroken && (
          <p>
            Most often this is a missing <code className="font-mono">iptables</code> package on the
            host — check <code className="font-mono">command -v iptables</code> first.
          </p>
        )}
        <p>
          Work through the{' '}
          <a
            // The PUBLISHED manual, not a GitHub blob: docs/operations/ is a
            // repo-internal runbook tree that is not part of the documentation
            // site, and the host has no repo clone to read it from either.
            href="https://insulahq.github.io/operator/troubleshooting/#worker-subsystem"
            target="_blank"
            rel="noreferrer"
            className="underline font-medium hover:text-amber-900 dark:hover:text-amber-200"
            data-testid="subsystem-troubleshooting-link"
          >
            node subsystem troubleshooting steps
          </a>{' '}
          in order — cheapest first. Drain + re-bootstrap is the last resort, not the first move.
        </p>
      </div>
    </div>
  );
}

function RolePill({ role }: { readonly role: 'server' | 'worker' }) {
  return role === 'server' ? (
    <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-800 dark:bg-brand-900/40 dark:text-brand-300">
      server
    </span>
  ) : (
    <span className="rounded-full bg-accent-100 px-2 py-0.5 text-xs font-medium text-accent-800 dark:bg-accent-900/40 dark:text-accent-300">
      worker
    </span>
  );
}

function ReadyPill({ ready }: { readonly ready: 'Ready' | 'NotReady' | 'Unknown' }) {
  const styles = {
    Ready: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    NotReady: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    Unknown: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  } as const;
  return <span className={clsx('rounded-full px-2 py-0.5 text-xs font-medium', styles[ready])}>{ready}</span>;
}

const BAR_TONE = (pct: number): { used: string; committed: string } => (
  pct >= PRESSURE_RED ? { used: 'bg-red-500', committed: 'bg-red-300 dark:bg-red-800' }
    : pct >= PRESSURE_AMBER ? { used: 'bg-amber-500', committed: 'bg-amber-300 dark:bg-amber-800' }
      : { used: 'bg-green-500', committed: 'bg-green-300 dark:bg-green-800' }
);

/**
 * One resource as in use / committed / free of total, with a two-band bar:
 * in use solid, committed beyond it lighter, free as the bare track. Memory
 * adds its cache as a third band at the start of free — part of free, which
 * the text says too.
 */
function TriadRow({ label, icon, figures, format, testId }: {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly figures: TriadFigures | null;
  readonly format: (n: number) => string;
  readonly testId: string;
}) {
  if (!figures) {
    return (
      <div className="flex items-center gap-2" data-testid={testId}>
        <span className="text-gray-400">{icon}</span>
        <div className="flex-1 text-xs text-gray-500 dark:text-gray-400">{label}: not measured</div>
      </div>
    );
  }
  const tone = BAR_TONE(Math.max(figures.inUsePct, figures.committedPct));
  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <span className="text-gray-400">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-gray-500 dark:text-gray-400">
          <span className="font-medium text-gray-700 dark:text-gray-200">{label}</span>
          <span className="tabular-nums">
            In use <b className="font-semibold text-gray-900 dark:text-gray-100">{figures.inUse === null ? '—' : format(figures.inUse)}</b>
            {' · '}Committed <b className="font-semibold text-gray-900 dark:text-gray-100">{format(figures.committed)}</b>
            {' · '}Free <b className="font-semibold text-gray-900 dark:text-gray-100">{format(figures.free)}</b>
            {figures.cacheInFree !== null && (
              <span title={`Cache: ${format(figures.cache ?? 0)} — mostly file cache, which the kernel hands back when memory runs short. `
                + 'It also holds shared memory (database buffers, memory-backed volumes), which it cannot.'}>
                {' '}(cache {format(figures.cacheInFree)})
              </span>
            )}
            {' '}of {format(figures.total)}
          </span>
        </div>
        <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          <div className={clsx('h-full', tone.used)} style={{ width: `${figures.inUsePct.toFixed(1)}%` }} />
          <div className={clsx('h-full', tone.committed)} style={{ width: `${Math.max(0, figures.committedPct - figures.inUsePct).toFixed(1)}%` }} />
          {figures.cache !== null && (
            <div data-band="cache" className={clsx('h-full', CACHE_BAND)} style={{ width: `${figures.cachePct.toFixed(1)}%` }} />
          )}
        </div>
      </div>
    </div>
  );
}

const cores = (n: number): string => `${n.toFixed(2)} cores`;
const gib = (n: number): string => `${n.toFixed(1)} GiB`;
// The disk triad arrives in GB (the dashboard's unit, like the cluster Storage
// tile); shown here in GiB, the unit of the Longhorn disk rows beneath it, so
// one disk does not read as two sizes on one card.
const gibFromGb = (n: number): string => `${((n * 1e9) / 1024 ** 3).toFixed(1)} GiB`;

function NodeDetails({ node, triads, pods }: {
  readonly node: ClusterNodeResponse;
  readonly triads: NodeTriads;
  readonly pods: number | null;
}) {
  return (
    <div className="space-y-4 px-5 py-4 text-sm">
      <div className="space-y-3" data-testid={`node-resources-${node.name}`}>
        <TriadRow label="CPU" icon={<Cpu size={16} />} figures={triads.cpu} format={cores} testId={`node-cpu-${node.name}`} />
        <TriadRow label="Memory" icon={<MemoryStick size={16} />} figures={triads.memory} format={gib} testId={`node-memory-${node.name}`} />
        <TriadRow label="Disk" icon={<HardDrive size={16} />} figures={triads.disk} format={gibFromGb} testId={`node-disk-${node.name}`} />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Committed is what pods have requested (CPU, memory) and what volumes placed here have been sized to (disk) —
          held for them even while idle. Free is neither in use nor committed.
          {triads.memory?.cache != null && (
            <> Memory in use is what processes hold. The cache is mostly file cache, which the kernel hands back
              when memory runs short, so it is drawn inside free; it also holds shared memory, which it cannot.</>
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Boxes size={16} className="text-gray-400" />
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Pods</div>
          <div className="font-medium text-gray-900 dark:text-gray-100">{pods ?? '—'}</div>
        </div>
      </div>
      {node.notes && (
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Operator notes</div>
          <p className="whitespace-pre-wrap text-gray-700 dark:text-gray-200">{node.notes}</p>
        </div>
      )}
      {node.taints && node.taints.length > 0 && (
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400">Taints</div>
          <ul className="mt-1 space-y-0.5 text-xs">
            {node.taints.map((t) => (
              // (key, effect) is unique within a valid taint set;
              // using both as the React key avoids the index-based
              // collision when two taints share the same key but
              // different effects.
              <li key={`${t.key}:${t.effect}`} className="font-mono text-gray-700 dark:text-gray-300">
                {t.key}
                {t.value ? `=${t.value}` : ''}:{t.effect}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

