/**
 * PreSwitchConfirmModal — Phase 5 (2026-05-24).
 *
 * Opens when an operator picks a new target in the Routing tab's
 * TargetSwitcher. Renders what will be paused (schedules + WAL),
 * the new target name, and a single Confirm button.
 *
 * On Confirm: calls /switch-with-pause which:
 *   1. Sets backup_schedules.enabled=false for class subsystems
 *   2. (system class only) Calls disableWalArchive on system-db
 *   3. Invokes the existing applyShimAssignmentChange pipeline
 *
 * After the mutation resolves, the modal closes and the operator
 * lands back on the Routing tab with schedules visibly off — they
 * need to manually re-enable schedules + WAL on the new target +
 * trigger a "Backup Now" to seed it. The modal copy reminds them.
 */

import { X, AlertTriangle, Loader2, CheckCircle2 } from 'lucide-react';
import type { BackupShimClass } from '@k8s-hosting/api-contracts';
import {
  useShimSwitchPreview,
  useShimSwitchWithPause,
} from '@/hooks/use-shim-switch-with-pause';

interface Props {
  readonly className: BackupShimClass;
  readonly newTargetId: string | null;
  readonly newTargetLabel: string;
  /** Called on close (any reason — Cancel, Esc, or after Confirm completes). */
  readonly onClose: () => void;
}

export default function PreSwitchConfirmModal({
  className,
  newTargetId,
  newTargetLabel,
  onClose,
}: Props) {
  const preview = useShimSwitchPreview(className, newTargetId);
  const mutate = useShimSwitchWithPause(className);

  const confirm = (): void => {
    void (async () => {
      try {
        await mutate.mutateAsync({ targetId: newTargetId });
        onClose();
      } catch {
        // surfaced via mutate.error below
      }
    })();
  };

  const previewData = preview.data?.data;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pre-switch-confirm-title"
      data-testid="pre-switch-confirm-modal"
    >
      <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        {/* ── Header ──────────────────────────────────────────────── */}
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <h2
            id="pre-switch-confirm-title"
            className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            <AlertTriangle size={16} className="text-amber-500" />
            Confirm target switch
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={mutate.isPending}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-700"
            data-testid="pre-switch-confirm-close"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        {/* ── Body ────────────────────────────────────────────────── */}
        <div className="space-y-3 px-5 py-4 text-sm text-gray-700 dark:text-gray-300">
          <p>
            {newTargetId === null ? (
              <>
                Unbinding <code className="rounded bg-gray-100 px-1 dark:bg-gray-900">
                  {className.toUpperCase()}
                </code>{' '}backups from the current target.
              </>
            ) : (
              <>
                Switching <code className="rounded bg-gray-100 px-1 dark:bg-gray-900">
                  {className.toUpperCase()}
                </code>{' '}backups to{' '}
                <strong className="text-gray-900 dark:text-gray-100">
                  {newTargetLabel}
                </strong>.
              </>
            )}
          </p>

          {preview.isLoading && (
            <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" /> Loading effects…
            </div>
          )}
          {preview.error && (
            <div className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
              Preview failed: {preview.error instanceof Error ? preview.error.message : String(preview.error)}
            </div>
          )}

          {previewData && (
            <div className="space-y-2">
              <p className="font-medium text-gray-900 dark:text-gray-100">
                The following will be paused as part of the switch:
              </p>
              <ul className="space-y-1 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-100">
                {previewData.schedulesToPause.length === 0 && previewData.walToDisable === null && (
                  <li className="italic text-gray-600 dark:text-gray-400">
                    No active schedules or WAL streaming on this class.
                  </li>
                )}
                {previewData.schedulesToPause.map((s) => (
                  <li key={s.subsystem} className="flex items-center gap-2" data-testid={`pre-switch-paused-${s.subsystem}`}>
                    <span className="rounded bg-amber-200/60 px-1.5 py-0.5 font-mono text-[10px] dark:bg-amber-900/60">
                      schedule
                    </span>
                    <span><code>{s.subsystem}</code> {s.cronExpression && <span className="text-amber-800 dark:text-amber-300">({s.cronExpression})</span>}</span>
                  </li>
                ))}
                {previewData.walToDisable && (
                  <li className="flex items-center gap-2" data-testid="pre-switch-paused-wal">
                    <span className="rounded bg-amber-200/60 px-1.5 py-0.5 font-mono text-[10px] dark:bg-amber-900/60">
                      WAL
                    </span>
                    <span>
                      WAL streaming on{' '}
                      <code>{previewData.walToDisable.clusterNamespace}/{previewData.walToDisable.clusterName}</code>
                      {previewData.walToDisable.currentTargetName && (
                        <span className="text-amber-800 dark:text-amber-300">
                          {' '}(current target: {previewData.walToDisable.currentTargetName})
                        </span>
                      )}
                    </span>
                  </li>
                )}
              </ul>

              <p className="text-xs text-gray-600 dark:text-gray-400">
                {newTargetId === null ? (
                  <>After unbind, schedules + WAL streaming stay off. Bind a new target to resume backups.</>
                ) : (
                  <>After the switch you&apos;ll need to: re-enable WAL streaming on the new target, resume schedules, and click <strong>Backup Now</strong> on the Backups tab to seed it.</>
                )}
              </p>
            </div>
          )}

          {mutate.error && (
            <div className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200" data-testid="pre-switch-confirm-error">
              Switch failed: {mutate.error instanceof Error ? mutate.error.message : String(mutate.error)}
            </div>
          )}
        </div>

        {/* ── Footer ──────────────────────────────────────────────── */}
        <footer className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3 dark:border-gray-700 dark:bg-gray-900/50">
          <button
            type="button"
            onClick={onClose}
            disabled={mutate.isPending}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            data-testid="pre-switch-confirm-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            // Confirm blocked until the preview has actually loaded —
            // operator must see what will be paused before they commit.
            disabled={
              mutate.isPending
              || preview.isLoading
              || preview.isFetching
              || !!preview.error
              || !previewData
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            data-testid="pre-switch-confirm-button"
          >
            {mutate.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <CheckCircle2 size={14} />
            )}
            {mutate.isPending ? 'Switching…' : 'Confirm Switch'}
          </button>
        </footer>
      </div>
    </div>
  );
}
