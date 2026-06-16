/**
 * Admin view of a tenant's on-server Longhorn volume snapshots.
 *
 * Mirrors the tenant panel's Snapshots page but is operated by staff
 * against a specific tenantId. Local PVC recovery points (Longhorn CSI),
 * create / restore (in-place revert) / delete. The off-site, file-level
 * restorable backups are the restic tenant bundles on the Backups tab.
 *
 * `variant='compact'` renders a trimmed quick-view (latest few + Take
 * snapshot) for embedding inside the Storage Lifecycle card; `onManageAll`
 * links to the full Snapshots tab.
 */

import { useState } from 'react';
import { Camera, Loader2, Trash2, Plus, X, Info, Clock, RotateCcw, AlertTriangle, CheckCircle, ArrowRight } from 'lucide-react';
import {
  useTenantSnapshots,
  useCreateTenantSnapshot,
  useDeleteTenantSnapshot,
  useRestoreTenantSnapshot,
  useTenantRestoreStatus,
} from '@/hooks/use-tenant-snapshots';
import type { TenantSnapshot } from '@insula/api-contracts';

function formatBytes(bytes: number): string {
  if (!bytes) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expiring…';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `in ${h}h`;
  return `in ${Math.max(1, Math.floor(ms / 60_000))}m`;
}

function StatusBadge({ status }: { readonly status: string }) {
  const map: Record<string, string> = {
    ready: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700',
    creating: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700',
    error: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700',
    deleting: 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600',
  };
  const c = map[status] ?? map.deleting;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${c}`}>
      {status === 'creating' && <Loader2 size={10} className="animate-spin" />}
      {status}
    </span>
  );
}

interface Props {
  readonly tenantId: string;
  readonly variant?: 'full' | 'compact';
  readonly onManageAll?: () => void;
}

export default function TenantSnapshotsPanel({ tenantId, variant = 'full', onManageAll }: Props) {
  const snapsQ = useTenantSnapshots(tenantId);
  const createSnap = useCreateTenantSnapshot(tenantId);
  const deleteSnap = useDeleteTenantSnapshot(tenantId);
  const restoreSnap = useRestoreTenantSnapshot(tenantId);

  const allSnapshots = snapsQ.data?.data?.snapshots ?? [];
  const expiryHours = snapsQ.data?.data?.expiryHours ?? 48;
  const compact = variant === 'compact';
  const snapshots = compact ? allSnapshots.slice(0, 3) : allSnapshots;

  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TenantSnapshot | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<TenantSnapshot | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreOpId, setRestoreOpId] = useState<string | null>(null);

  const onCreate = () => {
    setCreateError(null);
    createSnap.mutate(label, {
      onSuccess: () => { setCreateOpen(false); setLabel(''); },
      onError: (e) => setCreateError(e instanceof Error ? e.message : 'Failed to create snapshot'),
    });
  };

  const onDelete = () => {
    if (!confirmDelete) return;
    deleteSnap.mutate(confirmDelete.id, { onSuccess: () => setConfirmDelete(null) });
  };

  const onRestore = () => {
    if (!confirmRestore) return;
    setRestoreError(null);
    restoreSnap.mutate(confirmRestore.id, {
      onSuccess: (res) => { setConfirmRestore(null); setRestoreOpId(res.data.operationId); },
      onError: (e) => setRestoreError(e instanceof Error ? e.message : 'Failed to start restore'),
    });
  };

  return (
    <div className="space-y-4" data-testid="tenant-snapshots-panel">
      <div className="flex items-center gap-3">
        {!compact && (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-400">
            <Camera size={20} />
          </div>
        )}
        <div className="flex-1">
          <h2 className={`font-semibold text-gray-900 dark:text-gray-100 ${compact ? 'text-sm flex items-center gap-2' : 'text-xl'}`}>
            {compact && <Camera size={15} className="text-indigo-500" />}
            Snapshots
          </h2>
          {!compact && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              On-server Longhorn recovery points of this tenant's storage. Quick to take and restore in-place — but they live
              on the same server. For off-site, file-level restore use the tenant's Backups (bundles).
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => { setCreateOpen(true); setCreateError(null); setLabel(''); }}
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          data-testid="admin-create-snapshot"
        >
          <Plus className="h-4 w-4" /> Take snapshot
        </button>
      </div>

      {!compact && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-300">
          <Info size={16} className="mt-0.5 flex-shrink-0" />
          <span>
            Snapshots auto-delete after <strong>{expiryHours} hours</strong> and are stored on the same server — they are not
            off-site backups. Restore reverts the live volume in place (Longhorn snapshotRevert).
          </span>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {snapsQ.isLoading && (
          <div className="flex items-center justify-center py-10">
            <div className="h-7 w-7 animate-spin rounded-full border-4 border-gray-200 border-t-indigo-600" />
            <span className="ml-3 text-sm text-gray-500 dark:text-gray-400">Loading snapshots…</span>
          </div>
        )}
        {snapsQ.isError && (
          <div className="px-6 py-10 text-center">
            <p className="text-sm text-red-600">Failed to load snapshots: {(snapsQ.error as Error)?.message ?? 'Unknown error'}</p>
          </div>
        )}
        {!snapsQ.isLoading && !snapsQ.isError && allSnapshots.length === 0 && (
          <div className="px-6 py-10 text-center" data-testid="admin-snapshots-empty">
            <Camera size={36} className="mx-auto text-gray-300 dark:text-gray-600" />
            <p className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100">No snapshots yet</p>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Take a snapshot before a risky change to enable a quick rollback.</p>
          </div>
        )}
        {!snapsQ.isLoading && !snapsQ.isError && snapshots.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50">
                  <th className="px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Label</th>
                  <th className="px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                  <th className="hidden px-5 py-3 font-medium text-gray-500 dark:text-gray-400 sm:table-cell">Size</th>
                  <th className="hidden px-5 py-3 font-medium text-gray-500 dark:text-gray-400 lg:table-cell">Created</th>
                  <th className="px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Expires</th>
                  <th className="px-5 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id} className="border-b border-gray-100 dark:border-gray-700 last:border-0" data-testid={`admin-snapshot-row-${s.id}`}>
                    <td className="px-5 py-3 text-gray-900 dark:text-gray-100">{s.label || <span className="font-mono text-xs text-gray-400">{s.id.slice(0, 12)}</span>}</td>
                    <td className="px-5 py-3">
                      <StatusBadge status={s.status} />
                      {s.status === 'error' && s.lastError && (
                        <p className="mt-1 max-w-xs truncate text-xs text-red-500" title={s.lastError}>{s.lastError}</p>
                      )}
                    </td>
                    <td className="hidden px-5 py-3 text-gray-600 dark:text-gray-400 sm:table-cell">{formatBytes(s.sizeBytes)}</td>
                    <td className="hidden px-5 py-3 text-gray-500 dark:text-gray-400 lg:table-cell">{new Date(s.createdAt).toLocaleString()}</td>
                    <td className="px-5 py-3 text-gray-500 dark:text-gray-400">
                      <span className="inline-flex items-center gap-1"><Clock size={12} /> {expiresIn(s.expiresAt)}</span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        {s.status === 'ready' && (
                          <button
                            type="button"
                            onClick={() => { setConfirmRestore(s); setRestoreError(null); }}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                            data-testid={`admin-restore-snapshot-${s.id}`}
                            title="Revert this tenant's storage to this snapshot (in place)"
                          >
                            <RotateCcw size={12} /> Restore
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(s)}
                          className="inline-flex items-center gap-1 rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-950"
                          data-testid={`admin-delete-snapshot-${s.id}`}
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {compact && (allSnapshots.length > snapshots.length || onManageAll) && (
        <button
          type="button"
          onClick={onManageAll}
          className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
          data-testid="admin-snapshots-manage-all"
        >
          Manage all snapshots ({allSnapshots.length}) <ArrowRight size={14} />
        </button>
      )}

      {createOpen && (
        <Modal title="Take a snapshot" onClose={() => setCreateOpen(false)}>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Captures the current state of this tenant's storage volume. It will auto-delete in {expiryHours} hours.
          </p>
          <label className="mt-4 block text-sm font-medium text-gray-700 dark:text-gray-300" htmlFor="admin-snap-label">
            Label <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <input
            id="admin-snap-label"
            type="text"
            value={label}
            maxLength={200}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. before migration"
            className="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            data-testid="admin-snapshot-label-input"
          />
          {createError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{createError}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setCreateOpen(false)} className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">Cancel</button>
            <button type="button" onClick={onCreate} disabled={createSnap.isPending} className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50" data-testid="admin-confirm-create-snapshot">
              {createSnap.isPending ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />} Take snapshot
            </button>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal title="Delete snapshot?" onClose={() => setConfirmDelete(null)}>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Permanently delete the snapshot{confirmDelete.label ? ` “${confirmDelete.label}”` : ''}? This can't be undone, but
            it won't affect the tenant's live files.
          </p>
          {deleteSnap.error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{(deleteSnap.error as Error).message}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmDelete(null)} className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">Cancel</button>
            <button type="button" onClick={onDelete} disabled={deleteSnap.isPending} className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50" data-testid="admin-confirm-delete-snapshot">
              {deleteSnap.isPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete
            </button>
          </div>
        </Modal>
      )}

      {confirmRestore && (
        <Modal title="Restore this snapshot?" onClose={() => setConfirmRestore(null)}>
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-300">
            <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
            <span>
              This <strong>reverts the tenant's live storage in place</strong> to the snapshot
              {confirmRestore.label ? ` “${confirmRestore.label}”` : ''} taken {new Date(confirmRestore.createdAt).toLocaleString()}.
              Workloads are quiesced briefly during the revert. Anything changed since the snapshot is lost.
            </span>
          </div>
          {restoreError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{restoreError}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmRestore(null)} className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">Cancel</button>
            <button type="button" onClick={onRestore} disabled={restoreSnap.isPending} className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50" data-testid="admin-confirm-restore-snapshot">
              {restoreSnap.isPending ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} Restore
            </button>
          </div>
        </Modal>
      )}

      {restoreOpId && (
        <RestoreProgressModal tenantId={tenantId} operationId={restoreOpId} onClose={() => { setRestoreOpId(null); snapsQ.refetch(); }} />
      )}
    </div>
  );
}

function RestoreProgressModal({ tenantId, operationId, onClose }: { readonly tenantId: string; readonly operationId: string; readonly onClose: () => void }) {
  const statusQ = useTenantRestoreStatus(tenantId, operationId);
  const op = statusQ.data?.data;
  const state = op?.state ?? 'quiescing';
  const done = state === 'idle';
  const failed = state === 'failed';
  const inFlight = !done && !failed;

  return (
    <Modal title="Restoring from snapshot" onClose={inFlight ? () => {} : onClose}>
      <div className="space-y-3">
        {inFlight && (
          <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <Loader2 size={16} className="animate-spin text-indigo-500" />
            <span data-testid="admin-restore-progress-msg">{op?.progressMessage || 'Working…'}</span>
          </div>
        )}
        {inFlight && (
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${op?.progressPct ?? 5}%` }} />
          </div>
        )}
        {done && (
          <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-400" data-testid="admin-restore-done">
            <CheckCircle size={18} /> Restore complete — the tenant's storage is back to the snapshot.
          </div>
        )}
        {failed && (
          <div className="flex items-start gap-2 text-sm text-red-700 dark:text-red-400" data-testid="admin-restore-failed">
            <AlertTriangle size={18} className="mt-0.5 flex-shrink-0" />
            <span>Restore failed: {op?.lastError || 'unknown error'}. The previous volume was left in place.</span>
          </div>
        )}
        <div className="flex justify-end">
          <button type="button" onClick={onClose} disabled={inFlight} className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700" data-testid="admin-restore-close">
            {inFlight ? 'Restoring…' : 'Close'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children }: { readonly title: string; readonly onClose: () => void; readonly children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700"><X size={18} /></button>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
