import { useState } from 'react';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import { useStorageOperations, useTenantStoragePlacement, useFsckCheck, useFsckRepair } from '@/hooks/use-storage-lifecycle';
import { useTableSearch } from '@/hooks/use-table-search';
import { Pin } from 'lucide-react';
import NodeName from '@/components/nodes/NodeName';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${units[i]}`;
}

/**
 * The tenant's volumes: where each is attached (the ACTIVE node, where the
 * pods read it) against the nodes holding its replicas — with the PINNED node
 * marked among them, so a volume served from a node other than its pinned one
 * reads as such at a glance.
 *
 * Sortable + searchable — same UX as the admin Installed Applications table.
 */
function NodeBadge({ name, kind }: { readonly name: string; readonly kind: 'active' | 'pinned' | 'plain' }) {
  if (kind === 'active') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-700 px-2 py-0.5 text-[11px] font-semibold text-white dark:bg-green-600" title="Active: attached here, the pods read it from this node">
        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" /><NodeName name={name} />
      </span>
    );
  }
  if (kind === 'pinned') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-brand-500 px-2 py-0.5 text-[11px] font-semibold text-brand-700 dark:border-brand-400 dark:text-brand-300" title="Pinned: the tenant's primary node">
        <Pin size={10} aria-hidden="true" /><NodeName name={name} />
      </span>
    );
  }
  return <span className="inline-flex rounded-full border border-gray-300 px-2 py-0.5 text-[11px] text-gray-700 dark:border-gray-600 dark:text-gray-300"><NodeName name={name} /></span>;
}

export function PvcPlacementSection({ tenantId, pinnedNode = null, activeNodes = [] }: {
  readonly tenantId: string;
  /** The tenant's primary (pinned) node, marked among the replica nodes. */
  readonly pinnedNode?: string | null;
  /** Where the tenant's volume is attached now. */
  readonly activeNodes?: readonly string[];
}) {
  const { data, isLoading, error } = useTenantStoragePlacement(tenantId);
  const opsQuery = useStorageOperations(tenantId);
  const fsckCheck = useFsckCheck();
  const fsckRepair = useFsckRepair();
  const [confirmRepair, setConfirmRepair] = useState<{ pvcName: string } | null>(null);
  const [reportOpId, setReportOpId] = useState<string | null>(null);

  const pvcs = data?.data.pvcs ?? [];
  const search = useTableSearch(pvcs, ['pvcName', 'volumeName', 'state', 'robustness', 'fsType']);
  const { sortedData, sortKey, sortDirection, onSort } = useSortable(search.filteredData, 'pvcName');

  // Latest fsck op (any state) — drives the Report modal contents.
  const fsckOps = (opsQuery.data?.data ?? []).filter((o) => o.opType === 'fsck');
  const reportOp = reportOpId ? fsckOps.find((o) => o.id === reportOpId) ?? null : null;

  // In-flight fsck for this tenant — disables Check/Repair buttons
  // while a quiesce-and-fsck cycle is running.
  const fsckInFlight = fsckOps.find((o) => !o.completedAt && o.state !== 'idle' && o.state !== 'failed');

  if (isLoading) {
    return (
      <div className="mb-3 rounded-md border border-gray-200 dark:border-gray-700 p-3 text-xs text-gray-500 dark:text-gray-400">
        Loading PVC placement…
      </div>
    );
  }
  if (error || pvcs.length === 0) {
    return (
      <div className="mb-3 rounded-md border border-gray-200 dark:border-gray-700 p-3 text-xs text-gray-500 dark:text-gray-400">
        No PVCs found for this tenant (yet).
      </div>
    );
  }
  return (
    <div className="mb-3 rounded-md border border-gray-200 dark:border-gray-700 p-3" data-testid="pvc-placement-section">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300">Persistent volumes ({pvcs.length})</h3>
        <input
          type="search"
          value={search.query}
          onChange={(e) => search.setQuery(e.target.value)}
          placeholder="Search…"
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-0.5 text-xs"
          data-testid="pvc-placement-search"
        />
      </div>
      <table className="w-full text-xs">
        <thead className="text-left text-gray-500 dark:text-gray-400">
          <tr>
            <SortableHeader label="PVC" sortKey="pvcName" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-3 !py-2 !text-left" />
            <SortableHeader label="Volume" sortKey="volumeName" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-3 !py-2 !text-left" />
            <SortableHeader label="FS" sortKey="fsType" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-3 !py-2 !text-left" />
            <SortableHeader label="Requested" sortKey="sizeBytes" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-3 !py-2 !text-left" />
            <SortableHeader label="Used" sortKey="usedBytes" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-3 !py-2 !text-left" />
            <SortableHeader label="State" sortKey="state" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-3 !py-2 !text-left" />
            <SortableHeader label="Robustness" sortKey="robustness" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-3 !py-2 !text-left" />
            <th className="px-3 py-2 text-left font-medium">Attached to</th>
            <th className="px-3 py-2 text-left font-medium">Replicas</th>
            <th className="px-3 py-2 text-left font-medium">Replica node(s)</th>
            <th className="px-3 py-2 text-left font-medium">Filesystem</th>
          </tr>
        </thead>
        <tbody>
          {sortedData.map((p) => {
            const replicasOk = p.replicasHealthy >= p.replicasExpected;
            const fsLabel = (p.fsType ?? '—').toLowerCase();
            return (
              <tr key={p.volumeName} className="border-t border-gray-100 dark:border-gray-700">
                <td className="px-3 py-2 font-mono">{p.pvcName}</td>
                <td className="px-3 py-2 font-mono text-gray-500 dark:text-gray-400">{p.volumeName.slice(0, 12)}…</td>
                <td className="px-3 py-2">
                  <span className={fsLabel === 'xfs'
                    ? 'rounded bg-blue-100 px-1 py-0.5 text-[10px] text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                    : fsLabel === 'ext4' || fsLabel === 'ext3'
                      ? 'rounded bg-purple-100 px-1 py-0.5 text-[10px] text-purple-800 dark:bg-purple-900/40 dark:text-purple-300'
                      : 'rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-700 dark:bg-gray-800 dark:text-gray-300'}
                  >
                    {fsLabel}
                  </span>
                </td>
                <td className="px-3 py-2">{p.sizeBytes > 0 ? formatBytes(p.sizeBytes) : '—'}</td>
                <td className="px-3 py-2">
                  {p.usedBytes > 0 ? formatBytes(p.usedBytes) : '0 B'}
                  {p.allocatedBytes > 0 && (
                    <span className="ml-1 text-gray-500 dark:text-gray-400">({formatBytes(p.allocatedBytes)})</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {(() => {
                    // Longhorn reports state="detached" any time no Pod
                    // consumes the PVC. For a healthy idle volume that's
                    // the expected resting state — nothing's wrong, the
                    // tenant just has zero replicas running. Surface
                    // that distinct from a problematic detach by
                    // checking robustness:
                    //   - state=attached → "attached" (live)
                    //   - state=detached + healthy/unknown + replicas
                    //     all available → "idle" (normal, gray)
                    //   - state=detached + degraded/faulted → "detached"
                    //     (alarming, kept literal)
                    //   - everything else (creating, deleting, etc.) →
                    //     literal Longhorn state
                    const state = p.state ?? null;
                    if (state === 'attached') {
                      return <span className="rounded bg-green-100 px-1 py-0.5 text-[10px] text-green-800 dark:bg-green-900/40 dark:text-green-300">attached</span>;
                    }
                    if (state === 'detached') {
                      const isProblem = p.robustness === 'degraded' || p.robustness === 'faulted';
                      if (isProblem) {
                        return <span className="rounded bg-red-100 px-1 py-0.5 text-[10px] text-red-800 dark:bg-red-900/40 dark:text-red-300" title="Longhorn state: detached">detached</span>;
                      }
                      return <span className="rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-700 dark:bg-gray-700 dark:text-gray-300" title="Longhorn state: detached. No Pod consumes the PVC right now — normal when file-manager and tenant workloads are idle.">idle</span>;
                    }
                    return <span className="text-gray-700 dark:text-gray-300">{state ?? '—'}</span>;
                  })()}
                </td>
                <td className="px-3 py-2">
                  <span className={p.robustness === 'healthy'
                    ? 'rounded bg-green-100 px-1 py-0.5 text-[10px] text-green-800 dark:bg-green-900/40 dark:text-green-300'
                    : p.robustness === 'degraded' ? 'rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                    : 'rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-700 dark:bg-gray-800 dark:text-gray-300'}>
                    {p.robustness ?? '—'}
                  </span>
                </td>
                <td className="px-3 py-2" data-testid={`pvc-attached-${p.pvcName}`}>
                  {p.state === 'attached' && activeNodes.length > 0
                    ? <span className="flex flex-wrap gap-1">{activeNodes.map((n) => <NodeBadge key={n} name={n} kind="active" />)}</span>
                    : <span className="text-gray-400">—</span>}
                </td>
                <td className="px-3 py-2">
                  <span className={replicasOk
                    ? 'rounded bg-green-100 px-1 py-0.5 text-[10px] text-green-800 dark:bg-green-900/40 dark:text-green-300'
                    : 'rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'}
                  >
                    {p.replicasHealthy}/{p.replicasExpected}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono">
                  {p.replicaNodes.length === 0
                    ? <span className="text-gray-400">—</span>
                    : <span className="flex flex-wrap gap-1">{p.replicaNodes.map((n) => <NodeBadge key={n} name={n} kind={n === pinnedNode ? 'pinned' : 'plain'} />)}</span>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    <button
                      type="button"
                      disabled={Boolean(fsckInFlight) || fsckCheck.isPending}
                      onClick={() => {
                        fsckCheck.mutate(tenantId, {
                          onSuccess: (resp) => setReportOpId(resp.data.operationId),
                        });
                      }}
                      className="rounded border border-gray-300 dark:border-gray-600 px-1.5 py-0.5 text-[10px] hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                      data-testid={`fsck-check-${p.pvcName}`}
                      title="Run xfs_repair -n / e2fsck -n on this volume (quiesces tenant)"
                    >
                      Check
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(fsckInFlight) || fsckRepair.isPending}
                      onClick={() => setConfirmRepair({ pvcName: p.pvcName })}
                      className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 text-[10px] text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
                      data-testid={`fsck-repair-${p.pvcName}`}
                      title="Run fsck in REPAIR mode (writes to disk; quiesces tenant)"
                    >
                      Repair
                    </button>
                  </div>
                  {p.engineConditions.length > 0 && (
                    <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                      {p.engineConditions.map((c) => c.type).join(', ')}
                    </div>
                  )}
                  {p.lastBackupAt && (
                    <div className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400" title={p.lastBackupAt}>
                      backup: {new Date(p.lastBackupAt).toISOString().slice(0, 10)}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {search.query && search.filteredData.length === 0 && (
        <p className="mt-2 text-xs text-gray-500 italic">No PVCs match &quot;{search.query}&quot;.</p>
      )}
      <p className="mt-2 text-[10px] text-gray-500 dark:text-gray-400 italic">
        Used = filesystem-level user-file bytes from kubelet stats. Parenthetical = Longhorn block-level allocation including filesystem metadata + sparse blocks (~230 MiB on an empty 10 GiB ext4 volume; ~40 MiB on XFS).
        Replicas = healthy/desired. Check/Repair quiesce the tenant for the duration of the run.
      </p>

      {fsckCheck.error instanceof Error && (
        <div className="mt-2 rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
          <strong>Failed to start filesystem check:</strong> {fsckCheck.error.message}
        </div>
      )}
      {fsckRepair.error instanceof Error && (
        <div className="mt-2 rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
          <strong>Failed to start filesystem repair:</strong> {fsckRepair.error.message}
        </div>
      )}

      {confirmRepair && (
        <FsckRepairConfirmModal
          pvcName={confirmRepair.pvcName}
          isPending={fsckRepair.isPending}
          onCancel={() => setConfirmRepair(null)}
          onConfirm={() => {
            fsckRepair.mutate(tenantId, {
              onSuccess: (resp) => {
                setReportOpId(resp.data.operationId);
                setConfirmRepair(null);
              },
            });
          }}
        />
      )}

      {reportOp && (
        <FsckReportModal
          op={reportOp}
          onClose={() => setReportOpId(null)}
        />
      )}
    </div>
  );
}

function FsckRepairConfirmModal({
  pvcName, isPending, onCancel, onConfirm,
}: {
  readonly pvcName: string;
  readonly isPending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-white dark:bg-gray-900 p-5 shadow-xl">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          Repair filesystem on {pvcName}?
        </h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          This will:
        </p>
        <ul className="mt-1 list-disc pl-5 text-sm text-gray-600 dark:text-gray-300">
          <li>Scale all tenant workloads to 0 (downtime)</li>
          <li>Run xfs_repair / e2fsck -y against the raw block device</li>
          <li>Restore workloads after completion</li>
        </ul>
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          On a badly damaged filesystem the repair may move corrupted files into <code>lost+found</code>. Take a snapshot first if the data is critical.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            data-testid="fsck-repair-confirm"
          >
            {isPending ? 'Starting…' : 'Repair filesystem'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FsckReportModal({
  op, onClose,
}: {
  readonly op: { id: string; state: string; progressPct: number; progressMessage: string | null; lastError: string | null; completedAt: string | null };
  readonly onClose: () => void;
}) {
  const inFlight = !op.completedAt && op.state !== 'idle' && op.state !== 'failed';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-3xl rounded-lg bg-white dark:bg-gray-900 p-5 shadow-xl">
        <div className="flex items-start justify-between">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Filesystem check report
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            ✕
          </button>
        </div>
        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          op {op.id.slice(0, 8)} — state: <span className="font-mono">{op.state}</span>
          {op.completedAt ? ` (completed ${new Date(op.completedAt).toLocaleString()})` : ''}
        </div>
        {inFlight && (
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${op.progressPct}%` }} />
          </div>
        )}
        {op.lastError ? (
          <div className="mt-3">
            <div className="text-xs font-semibold text-red-700 dark:text-red-400">Errors found:</div>
            <pre className="mt-1 max-h-96 overflow-auto rounded bg-gray-50 dark:bg-gray-800 p-2 text-[11px] font-mono whitespace-pre-wrap text-red-800 dark:text-red-300">
              {op.lastError}
            </pre>
          </div>
        ) : op.progressMessage ? (
          <div className="mt-3">
            <div className="text-xs font-semibold text-green-700 dark:text-green-400">Report:</div>
            <pre className="mt-1 max-h-96 overflow-auto rounded bg-gray-50 dark:bg-gray-800 p-2 text-[11px] font-mono whitespace-pre-wrap text-gray-800 dark:text-gray-200">
              {op.progressMessage}
            </pre>
          </div>
        ) : (
          <p className="mt-3 text-xs text-gray-500">Waiting for output…</p>
        )}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
