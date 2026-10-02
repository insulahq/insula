/**
 * Snapshot restore progress — the step-by-step view.
 *
 * Polls the tenant-scoped GET …/snapshots/restore-status/:operationId (via
 * useRestoreStatus) and renders the server's step timeline: every step of the
 * in-place revert with its state, how long each finished step took, and a
 * running clock on the current one. A failure renders the server's
 * OperatorError through <ErrorPanel>, which says what happened to the files
 * and whether the site was started again.
 *
 * The server shapes the view for the tenant (no node names, no raw engine
 * errors); this component renders what it is given. The admin panel has the
 * same component over the same endpoint, where the operator view adds each
 * step's diagnostic detail.
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Loader2, MinusCircle, RotateCcw, X, XCircle } from 'lucide-react';
import type { OperatorError, SnapshotRestoreStatus, SnapshotRestoreStep } from '@insula/api-contracts';
import { useRestoreStatus } from '@/hooks/use-snapshots';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

interface Props {
  readonly operationId: string;
  readonly onClose: () => void;
}

/** "850ms" / "12s" / "3m 05s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function StepIcon({ state }: { readonly state: SnapshotRestoreStep['state'] }) {
  if (state === 'succeeded') return <CheckCircle2 size={16} className="text-green-600 dark:text-green-400" aria-hidden />;
  if (state === 'failed') return <XCircle size={16} className="text-red-600 dark:text-red-400" aria-hidden />;
  if (state === 'running') return <Loader2 size={16} className="animate-spin text-indigo-600 dark:text-indigo-400" aria-hidden />;
  if (state === 'skipped') return <MinusCircle size={16} className="text-gray-300 dark:text-gray-600" aria-hidden />;
  return <Circle size={16} className="text-gray-300 dark:text-gray-600" aria-hidden />;
}

const STATE_TEXT: Record<SnapshotRestoreStep['state'], string> = {
  pending: 'text-gray-400 dark:text-gray-500',
  running: 'font-medium text-indigo-700 dark:text-indigo-300',
  succeeded: 'text-gray-900 dark:text-gray-100',
  failed: 'font-medium text-red-700 dark:text-red-300',
  skipped: 'text-gray-400 line-through dark:text-gray-500',
};

function StepTimeline({ steps, now }: { readonly steps: ReadonlyArray<SnapshotRestoreStep>; readonly now: number }) {
  return (
    <ol className="space-y-1" data-testid="restore-step-timeline">
      {steps.map((step) => (
        <li
          key={step.key}
          className="flex items-start gap-2 rounded-md px-2 py-1 text-sm"
          data-testid={`restore-step-${step.key}`}
          data-state={step.state}
        >
          <span className="mt-0.5 flex-shrink-0"><StepIcon state={step.state} /></span>
          <span className="min-w-0 flex-1">
            <span className={STATE_TEXT[step.state]}>{step.label}</span>
            {step.detail && (
              <span className="ml-2 break-all font-mono text-[11px] text-gray-500 dark:text-gray-400">{step.detail}</span>
            )}
          </span>
          <span className="flex-shrink-0 font-mono text-xs tabular-nums text-gray-500 dark:text-gray-400">
            {step.elapsedMs !== null && formatDuration(step.elapsedMs)}
            {step.state === 'running' && step.startedAt && formatDuration(now - Date.parse(step.startedAt))}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Safety net only — the server always sends `error` with a failed outcome. */
function fallbackError(op: SnapshotRestoreStatus): OperatorError {
  return {
    code: 'SNAPSHOT_RESTORE_FAILED',
    title: 'Restore failed',
    detail: op.lastError ?? 'The restore did not complete.',
    remediation: ['Try the restore again. If it keeps failing, contact support and quote the operation ID.'],
    retryable: false,
    diagnostics: { operationId: op.operationId },
  };
}

export default function SnapshotRestoreProgressModal({ operationId, onClose }: Props) {
  const statusQ = useRestoreStatus(operationId);
  const op = statusQ.data?.data;
  // Until the first status arrives the restore is assumed running — unless
  // loading it failed, in which case the modal must stay closable.
  const outcome = op?.outcome ?? (statusQ.isError ? null : 'running');
  const running = outcome === 'running';

  // A 1s tick drives the running step's clock between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const steps = op?.steps ?? [];
  const runIndex = steps.findIndex((s) => s.state === 'running');
  const mainSteps = steps.filter((s) => s.key !== 'recover').length;
  const pct = Math.min(100, Math.max(0, op?.progressPct ?? 0));
  const totalMs = op ? (op.completedAt ? Date.parse(op.completedAt) : now) - Date.parse(op.startedAt) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="restore-progress-title">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-xl dark:bg-gray-800" data-testid="restore-progress-modal">
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-3 dark:border-gray-700">
          <div className="min-w-0">
            <h2 id="restore-progress-title" className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
              <RotateCcw size={18} className="text-indigo-500 dark:text-indigo-400" /> Restoring from snapshot
            </h2>
            {op?.snapshotLabel && (
              <p className="truncate text-sm text-gray-500 dark:text-gray-400">“{op.snapshotLabel}”</p>
            )}
          </div>
          <button
            type="button"
            onClick={running ? undefined : onClose}
            disabled={running}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-40 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {statusQ.isError && !op && (
            <ErrorPanel error={extractOperatorError(statusQ.error)} compact testId="restore-status-load-error" />
          )}

          <div>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="text-gray-700 dark:text-gray-300" data-testid="restore-progress-msg">
                {outcome === 'succeeded' && 'Restore complete'}
                {outcome === 'failed' && 'Restore failed'}
                {running && (runIndex < 0
                  ? op?.progressMessage || 'Starting the restore…'
                  : steps[runIndex]!.key === 'recover'
                    ? `Restore failed — ${steps[runIndex]!.label.toLowerCase()}`
                    : `Step ${runIndex + 1} of ${mainSteps} — ${steps[runIndex]!.label}`)}
              </span>
              <span className="font-mono text-xs tabular-nums text-gray-500 dark:text-gray-400">{pct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className={`h-full rounded-full transition-all ${outcome === 'failed' ? 'bg-red-500 dark:bg-red-400' : outcome === 'succeeded' ? 'bg-green-500 dark:bg-green-400' : 'bg-indigo-500 dark:bg-indigo-400'}`}
                style={{ width: `${pct}%` }}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
          </div>

          {steps.length > 0 && <StepTimeline steps={steps} now={now} />}

          {outcome === 'succeeded' && (
            <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm font-medium text-green-800 dark:border-green-800/60 dark:bg-green-900/20 dark:text-green-300" data-testid="restore-done">
              <CheckCircle2 size={16} className="flex-shrink-0" /> Restore complete — your files are back to the snapshot.
            </div>
          )}

          {outcome === 'failed' && op && (
            <ErrorPanel error={op.error ?? fallbackError(op)} testId="restore-failed" />
          )}

          <div className="flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
            <span>
              {totalMs !== null && totalMs >= 0 && <>{running ? 'Running for' : 'Took'} {formatDuration(totalMs)}</>}
              {op && (
                <span className="ml-2 select-all font-mono text-[10px]" title="Operation ID — quote it to support" data-testid="restore-operation-id">
                  {op.operationId}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={onClose}
              disabled={running}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              data-testid="restore-close"
            >
              {running ? 'Restoring…' : 'Close'}
            </button>
          </div>
          {running && (
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Your site is offline while the restore runs. It is safe to leave this page — the restore continues on the server.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
