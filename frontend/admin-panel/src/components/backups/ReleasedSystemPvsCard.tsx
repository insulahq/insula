/**
 * Superseded Released system-db PVs (R17 item 3).
 *
 * Every Postgres PITR auto-promote leaves the previous system-db PV
 * Released with reclaimPolicy=Retain — a deliberate safety net holding
 * the last pre-restore copy of the platform DB. The Longhorn replica
 * behind it keeps pinning the FULL volume size of scheduling budget,
 * and on a small node a single retained copy is enough to fail the
 * next restore's budget preflight (PITR_INSUFFICIENT_STORAGE_BUDGET).
 *
 * This card surfaces those PVs with a type-to-confirm reclaim action.
 * It renders nothing when the list is empty — most operators never see
 * it. Reclaim deletes the PV AND its Longhorn volume CR (the budget
 * pin lives on the latter).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, HardDrive, Loader2, Trash2, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';

interface ReleasedPv {
  readonly name: string;
  readonly claimName: string;
  readonly size: string;
  readonly createdAt: string | null;
  readonly storageClassName: string | null;
}

interface ListEnvelope { readonly data: { readonly pvs: ReadonlyArray<ReleasedPv> } }
interface ReclaimEnvelope { readonly data: { readonly pvDeleted: boolean; readonly longhornVolumeDeleted: boolean } }

const QUERY_KEY = ['postgres-restore', 'released-pvs'] as const;

function useReleasedSystemPvs() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch<ListEnvelope>('/api/v1/admin/postgres-restore/released-pvs'),
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
}

function useReclaimReleasedPv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, confirmName }: { name: string; confirmName: string }) =>
      apiFetch<ReclaimEnvelope>(`/api/v1/admin/postgres-restore/released-pvs/${name}/reclaim`, {
        method: 'POST',
        body: JSON.stringify({ confirmName }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
}

export default function ReleasedSystemPvsCard() {
  const { data } = useReleasedSystemPvs();
  const pvs = data?.data.pvs ?? [];
  if (pvs.length === 0) return null;

  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-900/10"
      data-testid="released-system-pvs-card"
    >
      <div className="flex items-center gap-2 border-b border-amber-200/70 dark:border-amber-800/70 px-4 py-3">
        <HardDrive size={16} className="text-amber-600 dark:text-amber-400" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Superseded pre-restore database volumes
        </h3>
        <span className="ml-auto rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">
          {pvs.length}
        </span>
      </div>
      <div className="px-4 py-3 space-y-3">
        <p className="text-xs text-gray-600 dark:text-gray-300">
          Each Postgres restore retains the previous database volume as a safety copy.
          Retained copies keep reserving their full size of storage scheduling budget —
          enough of them and the <em>next</em> restore is refused up-front
          (<code className="font-mono">PITR_INSUFFICIENT_STORAGE_BUDGET</code>).
          Reclaim a copy once you have verified the restored database.
        </p>
        <div className="divide-y divide-amber-200/60 dark:divide-amber-800/60">
          {pvs.map((pv) => (
            <ReleasedPvRow key={pv.name} pv={pv} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ReleasedPvRow({ pv }: { readonly pv: ReleasedPv }) {
  const [showConfirm, setShowConfirm] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="font-mono text-xs text-gray-900 dark:text-gray-100">{pv.name}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {pv.size} • claim {pv.claimName}
          {pv.createdAt && <> • created {new Date(pv.createdAt).toLocaleString()}</>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setShowConfirm(true)}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-2.5 py-1 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40"
        data-testid={`released-pv-reclaim-${pv.name}`}
      >
        <Trash2 size={12} /> Reclaim
      </button>
      {showConfirm && <ReclaimModal pv={pv} onClose={() => setShowConfirm(false)} />}
    </div>
  );
}

function ReclaimModal({ pv, onClose }: { readonly pv: ReleasedPv; readonly onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const reclaim = useReclaimReleasedPv();
  const [done, setDone] = useState(false);

  const handleRun = async () => {
    try {
      await reclaim.mutateAsync({ name: pv.name, confirmName: typed });
      setDone(true);
    } catch {
      // surfaced via reclaim.isError
    }
  };

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid={`released-pv-reclaim-modal-${pv.name}`}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-6 py-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <AlertTriangle size={18} className="text-red-500" />
            Reclaim superseded database volume
          </h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
            <X size={18} />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {!done ? (
            <>
              <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-800 dark:text-red-200 flex items-start gap-2">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <div>
                  <strong>This permanently deletes the retained pre-restore copy.</strong>
                  <p className="mt-1 text-xs">
                    {pv.size} of platform-database data from before the restore will be
                    unrecoverable from this volume. Only proceed if the current database
                    has been verified since the restore (logins work, tenants list, recent
                    data present).
                  </p>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                  Type <code className="font-mono text-red-600 dark:text-red-400">{pv.name}</code> to confirm
                </label>
                <input
                  type="text"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm font-mono text-gray-900 dark:text-gray-100"
                  data-testid={`released-pv-confirm-input-${pv.name}`}
                />
              </div>
              {reclaim.isError && (
                <div className="text-xs text-rose-600 dark:text-rose-400">
                  {reclaim.error instanceof Error ? reclaim.error.message : 'Reclaim failed'}
                </div>
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
                  disabled={typed.trim() !== pv.name || reclaim.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  data-testid={`released-pv-reclaim-run-${pv.name}`}
                >
                  {reclaim.isPending && <Loader2 size={14} className="animate-spin" />}
                  Reclaim volume
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2.5 text-sm text-emerald-800 dark:text-emerald-200">
                Volume <span className="font-mono">{pv.name}</span> reclaimed — the storage
                scheduling budget is freed for the next restore.
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
