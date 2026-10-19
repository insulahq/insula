import { Fragment, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  X, AlertTriangle, Loader2, AlertCircle, CheckCircle, Trash2, ShieldAlert,
  ExternalLink, Database as DatabaseIcon, ChevronRight, ChevronDown, Info,
} from 'lucide-react';
import {
  useDrainImpact,
  useDrainNode,
  useDeleteNode,
  useClusterNodes,
} from '@/hooks/use-cluster-nodes';
import { useWorkerUsageSummary, type WorkerUsage } from '@/hooks/use-worker-usage';
import type { ClusterNodeResponse, DrainImpact } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import NodeName from '@/components/nodes/NodeName';
import MailRoleNotice from '@/components/nodes/MailRoleNotice';
import { useNodeLabel } from '@/hooks/use-node-labels';

/**
 * Render "free / total" CPU + RAM + Disk for a worker option in the
 * Re-pin dropdown. Mirrors the formatter used by the tenant-detail
 * Placement card so the operator sees the same shape in both places.
 * Returns "" when usage data isn't loaded yet (option still shows the
 * bare node name).
 */
function formatNodeAvailability(usage: WorkerUsage | undefined): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.cpuMillicoresAllocatable != null && usage.cpuMillicoresUsed != null) {
    const total = usage.cpuMillicoresAllocatable / 1000;
    const free = Math.max(0, (usage.cpuMillicoresAllocatable - usage.cpuMillicoresUsed) / 1000);
    parts.push(`${free.toFixed(1)}/${total.toFixed(0)} CPU`);
  }
  if (usage.memoryBytesAllocatable != null && usage.memoryBytesUsed != null) {
    const total = usage.memoryBytesAllocatable / 1024 ** 3;
    const free = Math.max(0, (usage.memoryBytesAllocatable - usage.memoryBytesUsed) / 1024 ** 3);
    parts.push(`${free.toFixed(1)}/${total.toFixed(0)} GB RAM`);
  }
  if (usage.diskBytesTotal != null && usage.diskBytesFree != null) {
    const total = usage.diskBytesTotal / 1024 ** 3;
    const free = usage.diskBytesFree / 1024 ** 3;
    parts.push(`${free.toFixed(0)}/${total.toFixed(0)} GB disk`);
  }
  return parts.length > 0 ? ` — ${parts.join(' · ')}` : '';
}

interface NodeDrainDeleteModalProps {
  readonly node: ClusterNodeResponse;
  readonly onClose: () => void;
}

/**
 * Two-stage destructive flow for a node:
 *   1. DRAIN TENANTS — never a cordon on a server: system services keep
 *               running AND starting here (mail failover, database
 *               instances, operators). Evicts tenant pods only, and — unless
 *               unticked — keeps new tenants off with "Can host tenant
 *               workloads" off (a NoSchedule taint only tenant pods do not
 *               tolerate; a worker is cordoned). Operators re-pin
 *               affected CLIENTS (not individual workloads or PVCs);
 *               pinning is a tenant-level property and the orchestrator
 *               propagates the chosen target across every Deployment,
 *               StatefulSet, FM sidecar, and Longhorn volume in the
 *               tenant's namespace.
 *   2. DELETE — only enabled once the tenants are drained. Delete is what
 *               moves the system services: it cordons, evicts them
 *               (disruption budgets respected), then removes the node.
 *
 * Design goals:
 *  - One re-pin target per tenant (matches the tenant-detail page,
 *    where pinning is also expressed at the tenant level).
 *  - Each row expandable to show the workloads + PVCs that will be
 *    moved together — informational, not editable.
 *  - The drain asks nothing about volumes: it moves tenants, and their
 *    data follows the re-pin. Volumes that keep their only copy here —
 *    platform volumes, leftovers nothing uses — are listed at the DELETE
 *    step, where deleting the node would delete them.
 *  - A Postgres instance volume whose data other instances hold
 *    (`postgresInstance.coveredBy`) is not a drain risk: in HA each instance
 *    has one Longhorn replica on purpose. It gets its own informational
 *    section instead. Delete moves it to another server first (a primary is
 *    switched over, then the instance re-created from the primary); only an
 *    instance nothing else holds keeps Delete disabled — there is nothing to
 *    re-create it from.
 */
export default function NodeDrainDeleteModal({ node, onClose }: NodeDrainDeleteModalProps) {
  const [deleteLastCopies, setDeleteLastCopies] = useState(false);
  const [blockNewTenants, setBlockNewTenants] = useState(true);
  const impactQuery = useDrainImpact(node.name, true);
  const nodesQuery = useClusterNodes();
  const usageQuery = useWorkerUsageSummary();
  const drain = useDrainNode(node.name);
  const del = useDeleteNode(node.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nodeLabel = useNodeLabel();

  // tenantPlacement keyed by tenantId. Values: "" (auto, default),
  // "<targetNode>" (re-pin), or "stay" (refuse to move).
  const [tenantPlacement, setTenantPlacement] = useState<Record<string, string>>({});
  // Per-tenant expand state for the workloads/PVCs detail.
  const [expandedTenants, setExpandedTenants] = useState<Record<string, boolean>>({});

  const impact: DrainImpact | undefined = impactQuery.data?.data;
  // Delete is only safe when the node has no remaining tenant
  // attachment of any kind. Three concurrent conditions:
  //   - alreadyCordoned (k8s scheduler will refuse new pods)
  //   - no non-system pods left to evict (the live workloads are gone)
  //   - no pinnedTenants left (no Deployment/StatefulSet/Volume in
  //     any tenant namespace still references this node, even at rest
  //     — a stopped tenant pod or an unattached PVC would otherwise
  //     keep the node bound to the tenant and a delete would orphan
  //     them).
  const drained = impact !== undefined
    && impact.tenantsDrained
    && impact.nonSystemPods.length === 0
    && impact.pinnedTenants.length === 0;
  const isCovered = (r: DrainImpact['longhornReplicas'][number]): boolean =>
    (r.postgresInstance?.coveredBy.length ?? 0) > 0;
  // Same rule as the backend's Delete guard (NODE_DELETE_HOLDS_LAST_COPY):
  // every volume whose only copy is here, except database instances (their
  // own guard below). The drain does not care — Delete would delete them.
  const lastCopies = impact?.longhornReplicas.filter(
    (r) => r.isLastReplica && !r.postgresInstance,
  ) ?? [];
  // Postgres instances whose data other instances hold — shown, not blocking.
  const coveredDbInstances = impact?.longhornReplicas.filter(
    (r) => r.isLastReplica && isCovered(r),
  ) ?? [];
  // A Postgres instance whose only copy is here and that nothing else holds:
  // Delete has nothing to re-create it from (NODE_DELETE_HOLDS_DATABASE).
  const stuckDbInstances = [...new Set((impact?.longhornReplicas ?? [])
    .filter((r) => r.isLastReplica && r.postgresInstance && !isCovered(r))
    .map((r) => `${r.namespace ?? ''}/${r.postgresInstance?.instance ?? ''}`))];

  // Build target options once, joining the cluster-nodes list with
  // worker-usage so each <option> shows live capacity in the same
  // format the tenant-detail Placement card uses.
  const usageByName = useMemo(() => {
    return new Map((usageQuery.data?.data ?? []).map((u) => [u.name, u]));
  }, [usageQuery.data]);
  const targetNodeOptions = useMemo(() => {
    const list = nodesQuery.data?.data ?? [];
    return list
      .filter((n) => n.name !== node.name && n.canHostTenantWorkloads)
      .map((n) => ({ name: n.name, usage: usageByName.get(n.name) }));
  }, [nodesQuery.data, node.name, usageByName]);

  // Default per tenant, as the backend's: keep its pin when that is another
  // node this tenant could be re-pinned to (a re-run keeps what an earlier
  // run picked), else Auto.
  const defaultPlacementFor = (c: DrainImpact['pinnedTenants'][number]): string =>
    c.currentNodeName && c.currentNodeName !== node.name && targetNodeOptions.some((n) => n.name === c.currentNodeName)
      ? c.currentNodeName
      : '';

  // Block "Apply re-pin & drain" only when the operator has EXPLICITLY
  // set a tenant to "stay" — that's a refusal-to-move signal and
  // letting the drain proceed would evict pods but leave their
  // nodeSelector pointing at this node.
  const stayPinnedTenants = (impact?.pinnedTenants ?? []).filter(
    (c) => tenantPlacement[c.tenantId] === 'stay',
  );
  const anyStayPinned = stayPinnedTenants.length > 0;

  const handleDrain = async (): Promise<void> => {
    try {
      // Auto-fill: any pinned tenant without an explicit placement
      // gets "" (auto). Backend defaults the same — this is just a
      // defence-in-depth so an older backend that hasn't rolled the
      // server-side default still gets a complete map.
      const finalTenantPlacement = { ...tenantPlacement };
      for (const c of impact?.pinnedTenants ?? []) {
        if (!(c.tenantId in finalTenantPlacement)) finalTenantPlacement[c.tenantId] = defaultPlacementFor(c);
      }
      await drain.mutateAsync({
        tenantPlacement: finalTenantPlacement,
        blockNewTenants,
      });
      // Refetch impact so the modal flips to "drained → ready to delete".
      await impactQuery.refetch();
    } catch {
      // surfaced via drain.error below
    }
  };

  const toggleExpand = (tenantId: string) => {
    setExpandedTenants((prev) => ({ ...prev, [tenantId]: !prev[tenantId] }));
  };

  const handleDelete = async (): Promise<void> => {
    try {
      await del.mutateAsync({ forceLastReplica: deleteLastCopies });
      onClose();
    } catch { /* surfaced below */ }
  };

  const drainErr = drain.error as { message?: string } | null;
  const delErr = del.error as { message?: string } | null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="node-drain-modal-title"
      data-testid={`drain-node-${node.name}-modal`}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-4xl rounded-xl bg-white shadow-xl dark:bg-gray-800 max-h-[calc(100vh-4rem)] overflow-y-auto"
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <h2 id="node-drain-modal-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Drain &amp; remove node — <span className="font-mono"><NodeName name={node.name} /></span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm">
          {impactQuery.isLoading && (
            <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" /> Computing impact…
            </div>
          )}

          {impactQuery.error && (
            <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={12} /> {(impactQuery.error as Error).message}
            </p>
          )}

          {impact && (
            <>
              <ImpactSection
                title="Drain tenants"
                tone="good"
                content={node.role === 'server'
                  ? 'Moves this node’s tenants off. The node stays in service for the platform: system services keep running here and can still start here — mail failing over, a database instance rebuilt, an operator replica. Delete Node is what moves them.'
                  : 'Moves this worker’s tenants off. A worker runs no system services, only DaemonSets, which keep running.'}
              >
                {impact.blocksNewTenants ? (
                  <p className="mt-2 text-xs text-gray-600 dark:text-gray-400" data-testid="drain-already-blocks-tenants">
                    New tenants are already kept off this node.
                  </p>
                ) : (
                  <label className="mt-2 flex items-start gap-2 text-xs text-gray-800 dark:text-gray-200">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-700"
                      checked={blockNewTenants}
                      onChange={(e) => setBlockNewTenants(e.target.checked)}
                      data-testid="drain-block-new-tenants"
                    />
                    <span>
                      <span className="font-medium">Stop new tenants landing on this node</span>
                      <span className="block text-gray-600 dark:text-gray-400">
                        {node.role === 'server'
                          ? 'Switches off “Can host tenant workloads” — a NoSchedule taint that only tenant pods do not tolerate. System services are not affected. Switch it back on in the node’s Edit form.'
                          : 'Cordons this worker. Uncordon it in the node’s Edit form.'}
                      </span>
                    </span>
                  </label>
                )}
              </ImpactSection>

              {/* ─── Pinned tenants — one re-pin target per tenant ─── */}
              {impact.pinnedTenants.length > 0 && (
                <ImpactSection
                  title={`Pinned tenants (${impact.pinnedTenants.length})`}
                  tone={impact.pinnedTenants.some((c) => c.pvcs.some((p) => p.isLastReplica)) ? 'danger' : 'warn'}
                  content="These tenants have one or more workloads or volumes on this node. Pinning is a tenant-level property — pick one target per tenant; drain will patch every Deployment, StatefulSet, and Longhorn volume in the tenant's namespace consistently. Click a row to see what will be moved."
                >
                  <table className="mt-3 w-full text-xs">
                    <thead className="text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="w-6"></th>
                        <th className="text-left py-1 pr-2">Tenant</th>
                        <th className="text-left py-1 pr-2">Tier</th>
                        <th className="text-left py-1 pr-2">Current pin</th>
                        <th className="text-right py-1 pr-2">Workloads</th>
                        <th className="text-right py-1 pr-2">PVCs</th>
                        <th className="text-left py-1">Re-pin to</th>
                      </tr>
                    </thead>
                    <tbody>
                      {impact.pinnedTenants.map((c) => {
                        const isExpanded = expandedTenants[c.tenantId] === true;
                        const value = tenantPlacement[c.tenantId] ?? defaultPlacementFor(c);
                        const hasLastReplica = c.pvcs.some((p) => p.isLastReplica);
                        // Runs nothing and its only copy is here: nothing will move the
                        // data unless the drain attaches the volume on a new node.
                        const stoppedHere = c.pvcs.some((p) => p.detached && p.isLastReplica);
                        const rowBorder = hasLastReplica
                          ? 'border-t border-red-200/60 dark:border-red-700/40'
                          : 'border-t border-amber-200/60 dark:border-amber-700/40';
                        return (
                          <Fragment key={c.tenantId}>
                            <tr className={rowBorder}>
                              <td className="py-1.5 pl-1">
                                <button
                                  type="button"
                                  onClick={() => toggleExpand(c.tenantId)}
                                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                                  aria-label={isExpanded ? 'Collapse details' : 'Expand details'}
                                  data-testid={`expand-tenant-${c.tenantId}`}
                                >
                                  {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                </button>
                              </td>
                              <td className="py-1.5 pr-2">
                                <Link
                                  to={`/tenants/${c.tenantId}`}
                                  className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400"
                                  data-testid={`pinned-tenant-link-${c.tenantId}`}
                                >
                                  {c.tenantName}
                                  <ExternalLink size={10} />
                                </Link>
                                {stoppedHere && (
                                  <span
                                    className="ml-1.5 rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                                    title="Nothing is running, so its data does not follow a pod. The drain attaches its volume on the new node to move the data there."
                                    data-testid={`tenant-stopped-${c.tenantId}`}
                                  >
                                    not running
                                  </span>
                                )}
                              </td>
                              <td className="py-1.5 pr-2">
                                <span className={c.storageTier === 'ha'
                                  ? 'rounded bg-blue-100 px-1 py-0.5 text-[10px] text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                                  : 'rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-700 dark:bg-gray-800 dark:text-gray-300'}>
                                  {c.storageTier}
                                </span>
                              </td>
                              <td className="py-1.5 pr-2 font-mono text-gray-600 dark:text-gray-400">
                                {c.currentNodeName ? <NodeName name={c.currentNodeName} /> : <span className="italic text-gray-400">—</span>}
                              </td>
                              <td className="py-1.5 pr-2 text-right tabular-nums">{c.workloads.length}</td>
                              <td className="py-1.5 pr-2 text-right tabular-nums">
                                {c.pvcs.length}
                                {hasLastReplica && (
                                  <span className="ml-1 rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-800 dark:bg-red-900/40 dark:text-red-300">LAST</span>
                                )}
                              </td>
                              <td className="py-1.5">
                                <select
                                  className="rounded border border-amber-300 bg-white px-2 py-0.5 text-xs dark:bg-gray-800 dark:border-amber-700"
                                  value={value}
                                  onChange={(e) => setTenantPlacement((prev) => ({ ...prev, [c.tenantId]: e.target.value }))}
                                  data-testid={`tenant-placement-${c.tenantId}`}
                                >
                                  <option value="stay">Stay (refuse to move)</option>
                                  <option value="">{stoppedHere ? 'Auto (node with the most free space)' : 'Auto (clear pin)'}</option>
                                  {targetNodeOptions.map((n) => (
                                    <option key={n.name} value={n.name}>
                                      {nodeLabel(n.name)}{formatNodeAvailability(n.usage)}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="bg-amber-50/50 dark:bg-amber-900/10">
                                <td></td>
                                <td colSpan={6} className="py-2 pr-2">
                                  <div className="space-y-2">
                                    {c.workloads.length > 0 && (
                                      <div>
                                        <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Workloads</div>
                                        <ul className="mt-0.5 space-y-0.5 font-mono text-[11px] text-gray-700 dark:text-gray-300">
                                          {c.workloads.map((w) => (
                                            <li key={`${w.kind}/${w.name}`}>
                                              {w.kind}/{w.name}
                                              <span className="ml-2 text-gray-500">replicas={w.replicas} · pin={w.pinKind}</span>
                                            </li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                    {c.pvcs.length > 0 && (
                                      <div>
                                        <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Volumes</div>
                                        <ul className="mt-0.5 space-y-0.5 font-mono text-[11px] text-gray-700 dark:text-gray-300">
                                          {c.pvcs.map((p) => {
                                            const sizeGiB = (p.sizeBytes / (1024 ** 3)).toFixed(0);
                                            return (
                                              <li key={p.volumeName} className="flex items-center gap-1">
                                                <DatabaseIcon size={10} className="text-gray-400" />
                                                {p.pvcName || p.volumeName}
                                                <span className="ml-2 text-gray-500">{sizeGiB} GiB · replicas={p.replicaCount}</span>
                                                {p.isLastReplica && (
                                                  <span className="ml-1 rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-800 dark:bg-red-900/40 dark:text-red-300">LAST</span>
                                                )}
                                              </li>
                                            );
                                          })}
                                        </ul>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </ImpactSection>
              )}

              {/* ─── Non-system pods (live) ─── */}
              <ImpactSection
                title={`Non-system pods (${impact.nonSystemPods.length})`}
                tone={impact.nonSystemPods.length === 0 ? 'good' : 'warn'}
                content={
                  impact.nonSystemPods.length === 0
                    ? 'No tenant or non-system workload remaining on this node — safe to delete.'
                    : 'These pods will be evicted. Pods owned by Deployments/StatefulSets will be recreated by their controllers.'
                }
              >
                {impact.nonSystemPods.length > 0 && (
                  <table className="mt-2 w-full text-xs">
                    <thead className="text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="text-left py-1 pr-2">Tenant</th>
                        <th className="text-left py-1 pr-2">Pod</th>
                        <th className="text-left py-1 pr-2">Owner</th>
                        <th className="text-left py-1">Flags</th>
                      </tr>
                    </thead>
                    <tbody>
                      {impact.nonSystemPods.map((p) => (
                        <tr key={`${p.namespace}/${p.name}`} className="border-t border-gray-200/60 dark:border-gray-700/40">
                          <td className="py-1.5 pr-2">
                            {p.tenantId ? (
                              <Link
                                to={`/tenants/${p.tenantId}`}
                                className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400"
                              >
                                {p.tenantName ?? p.tenantId.slice(0, 8)}
                                <ExternalLink size={10} />
                              </Link>
                            ) : (
                              <span className="text-gray-400 italic">{p.namespace}</span>
                            )}
                          </td>
                          <td className="py-1.5 pr-2 font-mono">{p.name}</td>
                          <td className="py-1.5 pr-2 text-gray-500">
                            {p.workloadKind && p.workloadName ? `${p.workloadKind}/${p.workloadName}` : '—'}
                          </td>
                          <td className="py-1.5">
                            {p.pinnedToThisNode && (
                              <span className="rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">pinned</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </ImpactSection>

              {/* ─── Database instances (covered — info only) ─── */}
              {coveredDbInstances.length > 0 && (
                <ImpactSection
                  title={`Database instances on this node (${coveredDbInstances.length})`}
                  tone={coveredDbInstances.some((r) => r.postgresInstance?.primary) ? 'warn' : 'good'}
                  content="Each Postgres instance keeps its one copy on its own node; the other instances hold the same data, so these do not block the drain. Draining leaves them running here; Delete moves them to another server first."
                >
                  <ul className="mt-2 space-y-1.5 text-xs" data-testid="covered-db-instances">
                    {coveredDbInstances.map((r) => r.postgresInstance && (
                      <li key={r.replicaName} className="text-gray-700 dark:text-gray-300">
                        <span className="font-mono">{r.namespace}/{r.postgresInstance.instance}</span>
                        {r.postgresInstance.primary ? (
                          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                            primary
                          </span>
                        ) : (
                          <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                            replica
                          </span>
                        )}
                        <span className="ml-2 text-gray-500 dark:text-gray-400">
                          {r.postgresInstance.primary
                            ? `streaming to ${r.postgresInstance.coveredBy.join(', ')}`
                            : `data also on ${r.postgresInstance.coveredBy.join(', ')} (primary)`}
                        </span>
                        <div className="mt-0.5 text-gray-500 dark:text-gray-400">
                          {r.postgresInstance.primary
                            ? 'If this node goes down, Postgres fails over to a streaming instance — writes pause briefly.'
                            : 'If this node goes down, this instance catches up once the node is back.'}
                        </div>
                      </li>
                    ))}
                  </ul>
                </ImpactSection>
              )}

              {/* ─── Mail: draining tenants leaves it be; DELETING the node does not ─── */}
              <MailRoleNotice mailRole={impact.mailRole} nodeName={node.name} context="delete" />

              {/* ─── System pods (info only) ─── */}
              <details className="rounded-lg border border-gray-200 dark:border-gray-700">
                <summary className="cursor-pointer px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
                  System pods the drain leaves running — Delete moves them ({impact.systemPods.length})
                </summary>
                <ul className="space-y-1 px-3 py-2 text-xs">
                  {impact.systemPods.map((p) => (
                    <li key={`${p.namespace}/${p.name}`} className="font-mono text-gray-700 dark:text-gray-300">
                      {p.namespace}/{p.name} <span className="text-gray-400">— {p.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}

          {drainErr && (
            <ErrorPanel
              error={extractOperatorError(drain.error)}
              severity="error"
              compact
              testId="drain-error-panel"
            />
          )}
          {drain.isSuccess && (drain.data?.data.failed.length ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
              <div className="flex items-center gap-1 font-semibold">
                <AlertTriangle size={12} /> {drain.data?.data.failed.length} pod(s) failed to evict (likely PDB).
              </div>
              <ul className="mt-1 space-y-0.5 font-mono">
                {drain.data?.data.failed.map((f) => (
                  <li key={`${f.namespace}/${f.name}`}>{f.namespace}/{f.name}: {f.error}</li>
                ))}
              </ul>
            </div>
          )}
          {drain.isSuccess && (
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Re-pinned: {drain.data?.data.rePinnedTenants ?? 0} tenant(s)
              {' '}({drain.data?.data.rePinnedWorkloads ?? 0} workload(s), {drain.data?.data.rePinnedPvcs ?? 0} PVC(s)).
              {(drain.data?.data.relocatingVolumes ?? 0) > 0 && (
                <span data-testid="drain-relocating">
                  {' '}Moving the data of {drain.data?.data.relocatingVolumes} volume(s) of tenants that are not running
                  {Object.keys(drain.data?.data.pickedTargets ?? {}).length > 0 && (
                    <>
                      {' '}(Auto placed {Object.entries(drain.data?.data.pickedTargets ?? {}).map(([id, n]) =>
                        `${impact?.pinnedTenants.find((c) => c.tenantId === id)?.tenantName ?? id} on ${nodeLabel(n)}`).join(', ')})
                    </>
                  )}
                  {' '}— Delete unlocks once the copies have left this node.
                </span>
              )}
            </p>
          )}
          {drain.isSuccess && (drain.data?.data.relocationProblems.length ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100" data-testid="drain-relocation-problems">
              <div className="flex items-center gap-1 font-semibold">
                <AlertTriangle size={12} /> The data of a tenant that is not running did not start moving — it is still only on this node:
              </div>
              <ul className="mt-1 space-y-0.5 font-mono">
                {drain.data?.data.relocationProblems.map((p) => (
                  <li key={p.volumeName}>{p.tenantName} · {p.volumeName} — {p.reason}</li>
                ))}
              </ul>
            </div>
          )}
          {delErr && (
            <ErrorPanel
              error={extractOperatorError(del.error)}
              severity="error"
              compact
              testId="delete-error-panel"
            />
          )}

          {!drained && anyStayPinned && (
            <div className="rounded-lg border border-amber-400 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-600 dark:bg-amber-900/40 dark:text-amber-100" data-testid="drain-blocked-stay-pinned">
              <div className="flex items-center gap-1 font-semibold">
                <AlertTriangle size={12} /> Drain blocked — {stayPinnedTenants.length} tenant(s) still set to &quot;Stay&quot;.
              </div>
              <p className="mt-1">Pick &quot;Auto&quot; or a specific target node for each pinned tenant. Leaving a tenant on &quot;Stay&quot; would evict its pods but their nodeSelectors would still point at this node — the replacement pods come straight back.</p>
            </div>
          )}

          {drained && stuckDbInstances.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100" data-testid="delete-blocked-database">
              <div className="flex items-center gap-1 font-semibold">
                <AlertTriangle size={12} /> Drained — but Delete is disabled: this node holds the only copy of database instance {stuckDbInstances.join(', ')}, and no other instance holds its data.
              </div>
              <p className="mt-1">
                Delete moves a database instance by re-creating it on another server from one that holds the same
                data — here there is none. A single-instance database needs high availability turned on first, so
                another server holds a copy; a primary not streaming to a standby right now needs that standby back.
                Draining tenants does not touch it — the instance keeps running here.
              </p>
            </div>
          )}

          {drained && stuckDbInstances.length === 0 && coveredDbInstances.length > 0 && (
            <div className="rounded-lg border border-blue-300 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-100" data-testid="delete-moves-database">
              <div className="flex items-center gap-1 font-semibold">
                <Info size={12} /> Delete moves {coveredDbInstances.length === 1 ? 'this database instance' : 'these database instances'} to another server first:
              </div>
              <ul className="mt-1.5 space-y-0.5">
                {coveredDbInstances.map((r) => r.postgresInstance && (
                  <li key={r.replicaName}>
                    <span className="font-mono">{r.namespace}/{r.postgresInstance.instance}</span>
                    {' — '}
                    {r.postgresInstance.primary
                      ? `the primary: switched over to ${r.postgresInstance.coveredBy[0]} first (writes pause briefly), then re-created on another server from it`
                      : `re-created on another server from the primary (${r.postgresInstance.coveredBy[0]})`}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5">
                Delete waits until every instance of the database is ready before it starts. Its copy here is deleted
                once it is a replica — until the new instance is ready the database has one copy fewer — and Delete
                waits for that (a minute or two on a small database) before it moves anything else and removes the
                node. The platform may answer slowly while the database switches over.
              </p>
            </div>
          )}

          {drained && lastCopies.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100" data-testid="delete-last-copies">
              <div className="flex items-center gap-1 font-semibold">
                <AlertTriangle size={12} /> {lastCopies.length} volume(s) keep their only copy on this node — deleting the node deletes them.
              </div>
              <ul className="mt-1.5 space-y-0.5">
                {lastCopies.map((r) => (
                  <li key={r.replicaName} className="font-mono">
                    {r.namespace && r.pvcName ? `${r.namespace}/${r.pvcName}` : r.volumeName}
                    <span className="ml-1 font-sans text-amber-800 dark:text-amber-200">
                      {!r.inUse ? '— leftover, not in use' : !r.attached ? '— not mounted' : `— ${r.ownerLabel}`}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5">
                Draining tenants never touches them. Delete leftovers on{' '}
                <Link to="/cluster/storage" className="underline">Cluster → Storage</Link> (Orphaned volumes), or confirm:
              </p>
              <label className="mt-1.5 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={deleteLastCopies}
                  onChange={(e) => setDeleteLastCopies(e.target.checked)}
                  data-testid="delete-last-copies-checkbox"
                />
                <span>Delete them with the node.</span>
              </label>
            </div>
          )}

          {drained && !confirmDelete && stuckDbInstances.length === 0 && (
            <div className="rounded-lg border border-green-300 bg-green-50 p-3 text-xs text-green-800 dark:border-green-700 dark:bg-green-900/30 dark:text-green-200">
              <div className="flex items-center gap-1 font-semibold">
                <CheckCircle size={12} /> Tenants drained — no tenant pods, no pinned tenants. System services still run here; Delete Node moves them to other servers, then removes the node.
              </div>
            </div>
          )}

          {/* Drained but tenants still here — explain to the
              operator exactly which condition is still holding Delete
              back, so they don't have to count rows in the tables. */}
          {!drained && impact?.tenantsDrained && (impact.nonSystemPods.length > 0 || impact.pinnedTenants.length > 0) && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100" data-testid="drain-incomplete-banner">
              <div className="flex items-center gap-1 font-semibold">
                <AlertTriangle size={12} /> Tenant drain not yet complete — Delete is disabled.
              </div>
              <ul className="mt-1 list-disc pl-4 space-y-0.5">
                {impact.nonSystemPods.length > 0 && (
                  <li>{impact.nonSystemPods.length} tenant pod(s) still on the node.</li>
                )}
                {impact.pinnedTenants.length > 0 && (
                  <li>{impact.pinnedTenants.length} tenant(s) still have workloads or PVC replicas attached. Re-pin them above and click <strong>Drain tenants</strong> again, or wait for their data to finish moving (Longhorn copies it to the new node, then drops the copy here).</li>
                )}
              </ul>
            </div>
          )}

          {drained && confirmDelete && (
            <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" />
              <div>
                Delete will cordon the node,{coveredDbInstances.length > 0 ? ' move its database instances to other servers,' : ''}{' '}
                move its system services to other servers (disruption budgets respected — if one
                refuses, Delete stops with the node cordoned and nothing removed), then run{' '}
                <span className="font-mono">kubectl delete node {node.name}</span> and remove the row from the inventory.
                The host itself stays running. Click <strong>Confirm Delete</strong> below.
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Close
          </button>
          <div className="flex items-center gap-2">
            {!drained && (
              <button
                type="button"
                onClick={handleDrain}
                disabled={
                  drain.isPending
                  || !impact
                  || anyStayPinned
                }
                title={anyStayPinned
                  ? `${stayPinnedTenants.length} tenant(s) still set to "Stay" — pick Auto or a target node first`
                  : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                data-testid={`drain-node-${node.name}-button`}
              >
                {drain.isPending ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
                Drain tenants
              </button>
            )}
            {drained && !confirmDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={stuckDbInstances.length > 0 || (lastCopies.length > 0 && !deleteLastCopies)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                data-testid={`delete-node-${node.name}-button`}
              >
                <Trash2 size={14} /> Delete Node
              </button>
            )}
            {drained && confirmDelete && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={del.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
                data-testid={`confirm-delete-node-${node.name}-button`}
              >
                {del.isPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {del.isPending ? (coveredDbInstances.length > 0 ? 'Deleting — database instance moves first…' : 'Deleting…') : 'Confirm Delete'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface ImpactSectionProps {
  readonly title: string;
  readonly tone: 'good' | 'warn' | 'danger';
  readonly content: string;
  readonly children?: React.ReactNode;
}

function ImpactSection({ title, tone, content, children }: ImpactSectionProps) {
  const toneClass =
    tone === 'good' ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-900/20' :
    tone === 'warn' ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20' :
                      'border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-900/20';
  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <h3 className="mb-1 text-xs font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      <p className="text-xs text-gray-700 dark:text-gray-300">{content}</p>
      {children}
    </div>
  );
}
