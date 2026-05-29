import { useState } from 'react';
import { X, ArrowRight, CheckCircle, XCircle, Loader2, Ban } from 'lucide-react';
import { useMailMigrationStatus, useCancelMailMigration } from '@/hooks/use-mail-migration';
import type { MailMigrationStatusResponse } from '@insula/api-contracts';

// Migration step labels — kept in sync with mailMigrationStatusResponseSchema.state
// in packages/api-contracts/src/mail-placement.ts. Phase 1 streamline (2026-05-15)
// replaced 'rsync' + 'creating-target-pvc' + 'cutover' with 'swapping-pvc' +
// 'scaling-up' — the data path is now snapshot+restore on a stable PVC name.
const STEP_LABELS: Record<string, string> = {
  preflight: 'Preflight checks',
  // 'Mail backup' (offsite restic) — the user-facing vocab. Internal
  // step name 'snapshotting' kept for DB/API stability. Skipped when
  // no mail BackupTarget is configured; visible step jumps preflight
  // → scaling-down in that case.
  snapshotting: 'Taking pre-migration mail backup',
  'scaling-down': 'Scaling Stalwart to 0',
  'swapping-pvc': 'Swapping PVC to target node',
  'scaling-up': 'Scaling Stalwart up (restoring data via rsync FAST PATH)',
  verifying: 'Verifying restore content',
  done: 'Complete',
  failed: 'Failed',
  'rolled-back': 'Rolled back',
};

const STEP_ORDER = [
  'preflight',
  'snapshotting',
  'scaling-down',
  'swapping-pvc',
  'scaling-up',
  'verifying',
  'done',
];

function stepIndex(step: string): number {
  return STEP_ORDER.indexOf(step);
}

interface Props {
  readonly runId: string;
  readonly onClose: () => void;
}

export default function MailMigrationProgressModal({ runId, onClose }: Props) {
  const { data, isLoading, isError } = useMailMigrationStatus(runId);
  const status = data?.data;
  const cancel = useCancelMailMigration();
  const [cancelConfirm, setCancelConfirm] = useState(false);

  const isTerminal = status?.state === 'done' || status?.state === 'failed' || status?.state === 'rolled-back';
  const isCancelInFlight = cancel.isPending;
  const handleCancel = async () => {
    if (!cancelConfirm) {
      setCancelConfirm(true);
      return;
    }
    try {
      await cancel.mutateAsync(runId);
    } catch {
      // surfaced via cancel.isError
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-lg bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 space-y-5">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 rounded-md p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <X size={14} />
        </button>

        <div className="flex items-center gap-3">
          {!isTerminal ? (
            <Loader2 size={20} className="animate-spin text-brand-500" />
          ) : status?.state === 'done' ? (
            <CheckCircle size={20} className="text-green-600" />
          ) : (
            <XCircle size={20} className="text-red-600" />
          )}
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Mail Storage Migration
          </h3>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        )}

        {isError && (
          <p className="text-sm text-red-700 dark:text-red-300">
            Could not fetch migration status.
          </p>
        )}

        {status && (
          <>
            <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 font-mono">
              <span>{status.sourceNode}</span>
              <ArrowRight size={14} className="shrink-0 text-gray-400" />
              <span>{status.targetNode}</span>
            </div>

            <MigrationStepList status={status} />

            {status.progressBytes != null && status.state === 'scaling-up' && (
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Restored: {formatBytes(status.progressBytes)}
              </div>
            )}

            {status.error && (
              <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
                {status.error}
              </div>
            )}

            <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>Run ID: <code className="font-mono">{runId.slice(0, 8)}</code></span>
              <span>
                Started {new Date(status.startedAt).toLocaleTimeString()}
                {status.finishedAt ? ` · Finished ${new Date(status.finishedAt).toLocaleTimeString()}` : ''}
              </span>
            </div>
          </>
        )}

        {!isTerminal && status && (
          <div className="space-y-2">
            {cancel.isError && (
              <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                Cancel failed: {(cancel.error as Error).message}
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancel}
                disabled={isCancelInFlight}
                className={cancelConfirm
                  ? 'inline-flex items-center gap-1.5 rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50'
                  : 'inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50'}
                data-testid="migration-cancel"
              >
                {isCancelInFlight ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />}
                {isCancelInFlight ? 'Cancelling…' : cancelConfirm ? 'Click again to confirm cancel' : 'Cancel migration'}
              </button>
            </div>
            {cancelConfirm && !isCancelInFlight && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                The state machine bails at the next step checkpoint. If it's currently in a long
                K8s wait (e.g. waiting for Stalwart to scale up), cancel takes effect when the wait
                times out (worst case ~10 min). Already-completed steps (PVC swap, scale-down)
                are NOT rolled back — you may need to run a follow-up migration to restore
                placement.
              </p>
            )}
          </div>
        )}

        {isTerminal && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MigrationStepList({ status }: { readonly status: MailMigrationStatusResponse }) {
  const current = status.currentStep ?? status.state;
  const currentIdx = stepIndex(current);
  const isDone = status.state === 'done';
  const isFailed = status.state === 'failed' || status.state === 'rolled-back';

  return (
    <ol className="space-y-1.5">
      {STEP_ORDER.filter(s => s !== 'done').map((step) => {
        const idx = stepIndex(step);
        const isActive = current === step;
        const isPast = isDone || (!isFailed && idx < currentIdx);
        const isCurrent = isActive && !isDone && !isFailed;
        const isFailedStep = isFailed && isActive;

        return (
          <li key={step} className="flex items-center gap-2.5">
            <div className="w-5 h-5 flex items-center justify-center shrink-0">
              {isPast ? (
                <CheckCircle size={16} className="text-green-600" />
              ) : isFailedStep ? (
                <XCircle size={16} className="text-red-500" />
              ) : isCurrent ? (
                <Loader2 size={16} className="animate-spin text-brand-500" />
              ) : (
                <div className="w-3 h-3 rounded-full border-2 border-gray-300 dark:border-gray-600" />
              )}
            </div>
            <span
              className={`text-sm ${
                isCurrent
                  ? 'font-medium text-gray-900 dark:text-gray-100'
                  : isPast
                  ? 'text-gray-500 dark:text-gray-500 line-through'
                  : 'text-gray-400 dark:text-gray-600'
              }`}
            >
              {STEP_LABELS[step] ?? step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(2)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KiB`;
  return `${b} B`;
}
