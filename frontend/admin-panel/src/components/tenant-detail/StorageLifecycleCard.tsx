import type { ReactNode } from 'react';
import { useState } from 'react';
import OperationProgressModal from '@/components/OperationProgressModal';
import { useStorageOperations, useCancelStorageOperation } from '@/hooks/use-storage-lifecycle';
import { FailedStorageOperation } from './FailedStorageOperation';

export function StorageLifecycleCard({ tenantId, tenant, children }: {
  readonly tenantId: string;
  readonly tenant: { status?: string; storageLifecycleState?: string; storageLimitOverride?: string | null };
  /** The volume table, rendered under the heading. */
  readonly children?: ReactNode;
}) {
  // Storage operations. Lifecycle transitions (suspend / resume / archive /
  // restore) start from the header's Actions menu, grow and shrink from Plan
  // & limits — they all hit the same orchestrators, so no buttons for them
  // live here.
  //
  // What stays here:
  //   • the tenant's volumes (passed in as children)
  //   • Active / recent op progress (live readout while a lifecycle
  //     transition started elsewhere is running)
  //   • Reset-to-idle (recovery valve when an op left state=failed)
  const opsQuery = useStorageOperations(tenantId);
  const cancelOp = useCancelStorageOperation();

  const ops = opsQuery.data?.data ?? [];
  const activeOp = ops.find((o) => o.state !== 'idle' && o.state !== 'failed' && !o.completedAt);
  const recentOp = ops[0];
  const lifecycleState = tenant.storageLifecycleState ?? 'idle';

  const [trackedOpId, setTrackedOpId] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  const surfaceError = (err: unknown) => {
    setOpError(err instanceof Error ? err.message : String(err));
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Volumes and storage operations</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Where each volume is attached and replicated, and the storage
            operation running now. Suspend, archive and restore start from the
            header&rsquo;s Actions menu; grow and shrink from Plan &amp; limits.
          </p>
        </div>
        <div className="text-right text-xs">
          <div className="text-gray-500 dark:text-gray-400">Lifecycle state</div>
          <div className={`mt-0.5 rounded px-2 py-0.5 font-mono ${lifecycleState === 'idle' ? 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200'}`}>
            {lifecycleState}
          </div>
        </div>
      </div>

      {children}

      {activeOp && (
        <div className="mb-3 rounded-md bg-amber-50 dark:bg-amber-900/20 p-3 text-sm">
          <div className="flex items-center justify-between text-amber-900 dark:text-amber-100">
            <span className="font-medium">{activeOp.opType}: {activeOp.state}</span>
            <span className="text-xs">{activeOp.progressPct}%</span>
          </div>
          {activeOp.progressMessage && <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">{activeOp.progressMessage}</p>}
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-amber-200 dark:bg-amber-900/40">
            <div className="h-full bg-amber-600 transition-all" style={{ width: `${activeOp.progressPct}%` }} />
          </div>
          <div className="mt-3 flex items-center justify-between">
            <p className="text-[11px] text-amber-700 dark:text-amber-200">
              Stuck? Cancel deletes the underlying Job(s) and resets the tenant to idle.
            </p>
            <button
              type="button"
              onClick={async () => {
                if (!confirm('Force-cancel this storage operation?\n\n' +
                  'This will delete the underlying K8s Job(s) and reset the tenant storage state to idle. ' +
                  'For an fsck-repair currently writing to disk, e2fsck checkpoints between inode passes — ' +
                  'cancel between passes is safe; cancel mid-write may leave the filesystem partially repaired.\n\n' +
                  'Continue?')) return;
                try {
                  const result = await cancelOp.mutateAsync(tenantId);
                  setOpError(null);
                  alert(`Cancelled. Previous state: ${result.previousState}; deleted ${result.deletedJobs} Job(s).`);
                } catch (err) {
                  surfaceError(err);
                }
              }}
              disabled={cancelOp.isPending}
              className="rounded-md border border-amber-400 dark:border-amber-700 bg-white dark:bg-gray-800 px-3 py-1 text-xs font-medium text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
              data-testid="storage-cancel-op"
            >
              {cancelOp.isPending ? 'Cancelling…' : 'Cancel operation'}
            </button>
          </div>
        </div>
      )}

      {/* Show the failed-op banner only while the tenant is actually STUCK
          (lifecycleState='failed'). A failed op that rolled back cleanly
          leaves the tenant 'idle' and operational — the operator already saw
          the error when they triggered it, so a persistent, un-dismissable
          banner just nags. Gating on lifecycleState also makes "Reset to idle"
          below clear this banner (resetting the state hides it). */}
      {!activeOp && lifecycleState === 'failed' && recentOp && recentOp.state === 'failed' && (
        <FailedStorageOperation tenantId={tenantId} op={recentOp} />
      )}

      {/* Inline error banner — shown when the snapshot op rejects synchronously. */}
      {opError && (
        <div
          role="alert"
          className="mt-3 rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200 flex items-start gap-2"
          data-testid="lifecycle-error-banner"
        >
          <span className="flex-1 whitespace-pre-wrap">{opError}</span>
          <button
            onClick={() => setOpError(null)}
            className="shrink-0 text-red-400 hover:text-red-600 dark:hover:text-red-300"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Shared progress modal — opens for the manual snapshot started here. */}
      <OperationProgressModal
        operationId={trackedOpId}
        onClose={() => setTrackedOpId(null)}
      />
    </div>
  );
}
