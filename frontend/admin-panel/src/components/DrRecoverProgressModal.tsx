/**
 * Tenant recovery from an off-site bundle — the step-by-step progress view.
 *
 * Opened by Disaster Recovery → Recover Tenant the moment a recovery starts,
 * and re-opened from the task-center chip, which registers it under the
 * `dr-recover` modal key (the `dr.recover` task). Everything it shows comes
 * from that task row — the step timeline, the restore cart whose items are
 * the per-item progress, the terminal result or the `OperatorError` — so
 * closing it never loses the run: the recovery continues on the server and
 * the chip brings this view back.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, LifeBuoy, X } from 'lucide-react';
import {
  drRecoverTaskDetailsSchema,
  type DrRecoverTaskDetails,
  type OperatorError,
  type TaskStatus,
} from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import RecoverStepTimeline, { formatDuration } from '@/components/dr-recover/RecoverStepTimeline';
import RestoreItemsTable from '@/components/dr-recover/RestoreItemsTable';
import RecoverResultSummary from '@/components/dr-recover/RecoverResultSummary';
import { useTaskRow } from '@/hooks/use-task-row';

interface Props {
  readonly taskId: string;
  readonly onClose: () => void;
  /** Supplied by the chip when it re-opens the modal. */
  readonly taskStatus?: TaskStatus;
  readonly taskDetails?: Record<string, unknown> | null;
}

/**
 * A live run refreshes its row at least every 30 s (heartbeat). Silence this
 * long means the process running it is gone — say so instead of spinning.
 */
const SILENT_AFTER_MS = 3 * 60_000;

function parseDetails(raw: Record<string, unknown> | null): DrRecoverTaskDetails | null {
  if (!raw) return null;
  const parsed = drRecoverTaskDetailsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Safety net only — the server records an OperatorError with every failure. */
function fallbackError(message: string | null | undefined): OperatorError {
  return {
    code: 'DR_RECOVER_FAILED',
    title: 'Recovery failed',
    detail: message ?? 'The recovery did not complete.',
    remediation: ['Check the step that failed above, fix the cause, then start the recovery again.'],
    retryable: false,
  };
}

export default function DrRecoverProgressModal({ taskId, onClose, taskStatus, taskDetails }: Props) {
  const { task, status, details: rawDetails, running, serverNow } = useTaskRow(taskId, { taskStatus, taskDetails });
  const details = parseDetails(rawDetails);
  const failed = status === 'failed' || status === 'cancelled';
  const succeeded = status === 'succeeded';

  // A 1s tick drives the running step's clock between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pct = Math.min(100, Math.max(0, succeeded ? 100 : task?.progressPct ?? 0));
  const startedAt = task ? Date.parse(task.startedAt) : NaN;
  const endedAt = task?.finishedAt ? Date.parse(task.finishedAt) : now;
  const tookMs = Number.isNaN(startedAt) ? null : endedAt - startedAt;
  const name = details?.tenantName ?? details?.tenantId ?? null;
  // Server clock against server timestamps — a skewed browser clock must not
  // make a healthy run look silent.
  const silentMs = running && task && serverNow !== null ? serverNow - Date.parse(task.updatedAt) : 0;
  const gaps = details?.result?.residualGaps.length ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dr-recover-progress-title"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800"
        data-testid="dr-recover-progress-modal"
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-3 dark:border-gray-700">
          <div className="min-w-0">
            <h2 id="dr-recover-progress-title" className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
              <LifeBuoy size={18} className="text-brand-600 dark:text-brand-400" /> Recovering tenant from bundle
            </h2>
            {name && <p className="truncate text-sm text-gray-500 dark:text-gray-400" data-testid="dr-recover-progress-tenant">{name}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="text-gray-700 dark:text-gray-300" data-testid="dr-recover-progress-msg">
                {succeeded && 'Recovery complete'}
                {failed && 'Recovery failed'}
                {running && (task?.progressText ?? 'Starting the recovery…')}
              </span>
              <span className="font-mono text-xs tabular-nums text-gray-500 dark:text-gray-400">{pct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className={`h-full rounded-full transition-all ${failed ? 'bg-red-500 dark:bg-red-400' : succeeded ? 'bg-green-500 dark:bg-green-400' : 'bg-brand-500 dark:bg-brand-400'}`}
                style={{ width: `${pct}%` }}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
          </div>

          {silentMs > SILENT_AFTER_MS && (
            <p
              className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
              data-testid="dr-recover-silent"
            >
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              No progress reported for {formatDuration(silentMs)} — the platform-api process running this recovery may
              have restarted. If it stays silent, check the tenant and start the recovery again; the stopped run is
              then marked failed.
            </p>
          )}

          {details
            ? <RecoverStepTimeline steps={details.steps} now={now} />
            : <p className="text-sm text-gray-500 dark:text-gray-400">Starting the recovery…</p>}

          {succeeded && (
            <div
              className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm font-medium text-green-800 dark:border-green-800/60 dark:bg-green-900/20 dark:text-green-300"
              data-testid="dr-recover-done"
            >
              <CheckCircle2 size={16} className="flex-shrink-0" />
              {gaps > 0
                ? `Recovered — ${gaps} manual step${gaps === 1 ? '' : 's'} left, listed below.`
                : 'Recovered — the tenant is restored from its bundle.'}
            </div>
          )}

          {failed && (
            <ErrorPanel error={details?.error ?? fallbackError(task?.errorMessage)} testId="dr-recover-failed" />
          )}

          {details?.cartId && <RestoreItemsTable cartId={details.cartId} />}

          {details?.result && <RecoverResultSummary result={details.result} />}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-100 px-5 py-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          <span>{tookMs !== null && tookMs >= 0 && <>{running ? 'Running for' : 'Took'} {formatDuration(tookMs)}</>}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            data-testid="dr-recover-close"
          >
            {running ? 'Run in background' : 'Close'}
          </button>
        </div>
        {running && (
          <p className="px-5 pb-3 text-xs text-gray-400 dark:text-gray-500">
            The recovery continues on the server if you close this — the task center reopens it.
          </p>
        )}
      </div>
    </div>
  );
}
