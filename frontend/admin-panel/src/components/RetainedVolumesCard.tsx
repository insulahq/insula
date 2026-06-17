/**
 * Restore a tenant PVC FROM a retained Longhorn volume.
 *
 * After a destructive shrink (or archive) the OLD Longhorn volume survives
 * detached + Released — the `longhorn-tenant` StorageClass is
 * `reclaimPolicy: Retain`. If a manual snapshot was taken before the
 * destructive op, the admin can roll the tenant back onto that retained
 * volume at the chosen snapshot. The currently-bound volume is kept as a
 * fallback (it is NOT deleted), so the restore is reversible.
 *
 * Renders nothing when the tenant has no retained volumes — most tenants
 * never see this card. Mirrors ReleasedSystemPvsCard (list + type-to-confirm)
 * and the snapshot-restore → OperationProgressModal flow. See
 * docs/roadmap/RETAINED_VOLUME_RESTORE.md.
 */
import { useState } from 'react';
import { AlertTriangle, Clock, History, Loader2, RotateCcw, X } from 'lucide-react';
import type { RetainedVolume } from '@insula/api-contracts';
import { useRetainedVolumes, useRestoreRetained } from '@/hooks/use-storage-lifecycle';
import { extractOperatorError } from '@/lib/extract-operator-error';
import ErrorPanel from '@/components/ErrorPanel';
import OperationProgressModal from '@/components/OperationProgressModal';

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 0 : 1)} GiB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}

export default function RetainedVolumesCard({ tenantId }: { readonly tenantId: string }) {
  const { data } = useRetainedVolumes(tenantId);
  const volumes = data?.data ?? [];
  if (volumes.length === 0) return null;

  return (
    <div
      className="rounded-xl border border-amber-200 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-900/10 p-5 shadow-sm"
      data-testid="retained-volumes-card"
    >
      <div className="flex items-center gap-2">
        <History size={16} className="text-amber-600 dark:text-amber-400" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Restore from a retained volume
        </h3>
        <span className="ml-auto rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
          {volumes.length}
        </span>
      </div>
      <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
        A previous destructive shrink/archive left these older volumes behind (detached,
        snapshots intact). Roll the tenant back onto one at a chosen snapshot — the volume
        in use now is kept as a fallback, so this is reversible. The tenant is briefly
        taken offline during the restore.
      </p>
      <div className="mt-3 divide-y divide-amber-200/60 dark:divide-amber-800/60">
        {volumes.map((vol) => (
          <RetainedVolumeRow key={vol.pvName} tenantId={tenantId} vol={vol} />
        ))}
      </div>
    </div>
  );
}

function RetainedVolumeRow({ tenantId, vol }: { readonly tenantId: string; readonly vol: RetainedVolume }) {
  // Snapshots arrive newest-first; default to the most recent.
  const [snapshotName, setSnapshotName] = useState(vol.snapshots[0]?.name ?? '');
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="font-mono text-xs text-gray-900 dark:text-gray-100">{vol.pvName}</div>
        <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          {fmtBytes(vol.sizeBytes)} • {vol.snapshots.length} snapshot{vol.snapshots.length === 1 ? '' : 's'}
          {vol.releasedAt && <> • released {new Date(vol.releasedAt).toLocaleString()}</>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <select
          value={snapshotName}
          onChange={(e) => setSnapshotName(e.target.value)}
          className="max-w-[16rem] rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-gray-900 dark:text-gray-100"
          data-testid={`retained-snapshot-select-${vol.pvName}`}
        >
          {vol.snapshots.map((s) => (
            <option key={s.name} value={s.name}>
              {s.createdAt ? new Date(s.createdAt).toLocaleString() : s.name}
              {s.sizeBytes ? ` (${fmtBytes(s.sizeBytes)})` : ''}
              {s.readyToUse ? '' : ' — not ready'}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setShowConfirm(true)}
          disabled={!snapshotName}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-2.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
          data-testid={`retained-restore-${vol.pvName}`}
        >
          <RotateCcw size={12} /> Restore…
        </button>
      </div>
      {showConfirm && (
        <RestoreRetainedModal
          tenantId={tenantId}
          vol={vol}
          snapshotName={snapshotName}
          onClose={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}

function RestoreRetainedModal({
  tenantId,
  vol,
  snapshotName,
  onClose,
}: {
  readonly tenantId: string;
  readonly vol: RetainedVolume;
  readonly snapshotName: string;
  readonly onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [opId, setOpId] = useState<string | null>(null);
  const restore = useRestoreRetained();
  const snap = vol.snapshots.find((s) => s.name === snapshotName);

  const handleRun = async () => {
    try {
      const res = await restore.mutateAsync({ tenantId, pvName: vol.pvName, snapshotName });
      setOpId(res.data.operationId);
    } catch {
      // surfaced via restore.isError → ErrorPanel below
    }
  };

  // Once the op has started, hand off to the shared progress modal.
  if (opId) {
    return (
      <OperationProgressModal
        operationId={opId}
        title="Restoring from retained volume"
        onClose={onClose}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid={`retained-restore-modal-${vol.pvName}`}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-6 py-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <AlertTriangle size={18} className="text-amber-500" />
            Restore from a retained volume
          </h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
            <X size={18} />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200 flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <strong>This swaps the tenant onto an older volume.</strong>
              <p className="mt-1 text-xs">
                The tenant is taken offline, repointed to <span className="font-mono">{vol.pvName}</span>
                {' '}reverted to the snapshot below, then brought back up. The volume currently in
                use is <strong>kept as a fallback</strong> (not deleted) — you can reclaim it later
                once the restore is verified. Any data written since that snapshot is not on this volume.
              </p>
            </div>
          </div>
          <dl className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs text-gray-700 dark:text-gray-300 space-y-1">
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500 dark:text-gray-400">Volume</dt>
              <dd className="font-mono truncate">{vol.pvName}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500 dark:text-gray-400">Snapshot</dt>
              <dd className="flex items-center gap-1 font-mono truncate">
                <Clock size={11} className="shrink-0" />
                {snap?.createdAt ? new Date(snap.createdAt).toLocaleString() : snapshotName}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-gray-500 dark:text-gray-400">Size</dt>
              <dd>{fmtBytes(vol.sizeBytes)}</dd>
            </div>
          </dl>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              Type <code className="font-mono text-amber-600 dark:text-amber-400">{vol.pvName}</code> to confirm
            </label>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
              data-testid={`retained-confirm-input-${vol.pvName}`}
            />
          </div>
          {restore.isError && (
            <ErrorPanel error={extractOperatorError(restore.error)} severity="error" compact testId="retained-restore-error" />
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRun}
              disabled={typed.trim() !== vol.pvName || !snapshotName || restore.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              data-testid={`retained-restore-run-${vol.pvName}`}
            >
              {restore.isPending && <Loader2 size={14} className="animate-spin" />}
              Restore tenant
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
