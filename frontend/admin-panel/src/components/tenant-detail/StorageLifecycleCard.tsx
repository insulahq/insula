import type { ReactNode } from 'react';
import { useState } from 'react';
import OperationProgressModal from '@/components/OperationProgressModal';
import { useStorageOperations, useClearFailedState, useCancelStorageOperation } from '@/hooks/use-storage-lifecycle';
import ErrorPanel from '@/components/ErrorPanel';

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
  const clearFailed = useClearFailedState();
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
      {!activeOp && lifecycleState === 'failed' && recentOp && recentOp.state === 'failed' && (() => {
        // Try to parse lastError as the structured OperatorError envelope.
        let envelope: import('@insula/api-contracts').OperatorError | null = null;
        let plainDetail = '';
        if (recentOp.lastError && recentOp.lastError.trim()) {
          try {
            const parsed = JSON.parse(recentOp.lastError);
            if (parsed && typeof parsed === 'object' && parsed.code && parsed.title) {
              envelope = parsed as import('@insula/api-contracts').OperatorError;
            } else {
              plainDetail = recentOp.lastError;
            }
          } catch {
            plainDetail = recentOp.lastError;
          }
        }
        const showClearButton = lifecycleState === 'failed';
        const clearButton = showClearButton ? (
          <button
            onClick={() => {
              if (confirm("Reset this tenant's storage state back to 'idle'? The failed operation's log is kept for debugging.")) {
                clearFailed.mutate(tenantId);
              }
            }}
            disabled={clearFailed.isPending}
            className="shrink-0 rounded-md border border-red-300 dark:border-red-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50"
            data-testid="lifecycle-clear-failed-button"
          >
            {clearFailed.isPending ? 'Clearing…' : 'Reset to idle'}
          </button>
        ) : null;

        if (envelope) {
          return (
            <div className="mb-3">
              <div className="mb-1 text-xs font-medium text-red-800 dark:text-red-200">
                Last {recentOp.opType} failed
              </div>
              <ErrorPanel
                error={envelope}
                severity="error"
                testId="lifecycle-error-panel"
              />
              {clearButton && <div className="mt-2 flex justify-end">{clearButton}</div>}
            </div>
          );
        }
        return (
          <div className="mb-3 rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium text-red-800 dark:text-red-200">Last {recentOp.opType} failed</div>
                {plainDetail && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{plainDetail}</p>}
              </div>
              {clearButton}
            </div>
          </div>
        );
      })()}

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
