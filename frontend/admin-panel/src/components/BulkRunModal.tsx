import { useEffect } from 'react';
import { X, Loader2, CheckCircle2, XCircle, MinusCircle, Clock, Ban, RotateCw } from 'lucide-react';
import clsx from 'clsx';
import ErrorPanel from '@/components/ErrorPanel';
import type { BulkRunController } from '@/hooks/use-bulk-run';
import {
  countRows,
  partialFailureError,
  plural,
  summaryText,
  type BulkItemStatus,
  type BulkRunRow,
} from '@/lib/bulk-run';

/**
 * Progress + report for a bulk action on the admin Tenants pages.
 *
 * Every selected row is shown with its own status while the items run one at
 * a time ({@link useBulkRun}), and keeps its result afterwards: what
 * succeeded, what was skipped and why, what failed and why. Close stays
 * disabled until the run finishes or a cancel lands, so nobody walks away
 * from a half-applied batch thinking it is done.
 */

const STATUS_STYLE: Record<BulkItemStatus, { label: string; cls: string; Icon: typeof Clock; spin?: boolean }> = {
  queued: { label: 'Queued', cls: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300', Icon: Clock },
  running: { label: 'Running', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300', Icon: Loader2, spin: true },
  succeeded: { label: 'Succeeded', cls: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300', Icon: CheckCircle2 },
  skipped: { label: 'Skipped', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300', Icon: MinusCircle },
  failed: { label: 'Failed', cls: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300', Icon: XCircle },
  cancelled: { label: 'Not run', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400', Icon: Ban },
};

interface BulkRunModalProps {
  readonly controller: BulkRunController;
}

export default function BulkRunModal({ controller }: BulkRunModalProps) {
  const { state, cancel, retryFailed, close } = controller;
  const finished = state?.phase === 'done' || state?.phase === 'cancelled';

  useEffect(() => {
    if (!finished) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finished, close]);

  if (!state) return null;

  const counts = countRows(state.rows);
  const pct = counts.total === 0 ? 100 : Math.round((counts.processed / counts.total) * 100);
  const runningRow = state.rows.find((r) => r.status === 'running');

  const phaseText =
    state.phase === 'running'
      ? `Processing ${Math.min(counts.processed + 1, counts.total)} of ${counts.total}${runningRow ? ` — ${runningRow.item.label}` : ''}`
      : state.phase === 'cancelling'
        ? `Cancelling — waiting for ${runningRow ? runningRow.item.label : `the current ${state.noun}`} to finish`
        : state.phase === 'cancelled'
          ? `Cancelled — ${plural(counts.cancelled, state.noun)} not run`
          : 'Finished';

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4 dark:bg-black/70"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-run-title"
      data-testid="bulk-run-modal"
      onClick={(e) => { if (finished && e.target === e.currentTarget) close(); }}
    >
      <div className="flex max-h-[calc(100vh-4rem)] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl dark:bg-gray-800">
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-3 dark:border-gray-700">
          <div className="min-w-0">
            <h3 id="bulk-run-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {state.title} — {plural(counts.total, state.noun)}
            </h3>
            <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400" data-testid="bulk-run-phase">
              {phaseText}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={!finished}
            aria-label="Close"
            title={finished ? 'Close' : 'Available once the run finishes or is cancelled'}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-500 dark:hover:bg-gray-700"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-2 border-b border-gray-100 px-5 py-3 dark:border-gray-700">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"
            role="progressbar"
            aria-label={`${state.title} progress`}
            aria-valuemin={0}
            aria-valuemax={counts.total}
            aria-valuenow={counts.processed}
            data-testid="bulk-run-progress"
          >
            <div
              className={clsx(
                'h-full rounded-full transition-all duration-300',
                counts.failed > 0 ? 'bg-red-500 dark:bg-red-400' : 'bg-brand-500 dark:bg-brand-400',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" data-testid="bulk-run-counts">
            <span className="font-medium text-gray-700 dark:text-gray-200">{counts.processed}/{counts.total} processed</span>
            <span className="text-green-700 dark:text-green-300">{counts.succeeded} succeeded</span>
            <span className="text-amber-700 dark:text-amber-300">{counts.skipped} skipped</span>
            <span className="text-red-700 dark:text-red-300">{counts.failed} failed</span>
            {counts.queued > 0 && <span className="text-gray-500 dark:text-gray-400">{counts.queued} queued</span>}
            {counts.cancelled > 0 && <span className="text-gray-500 dark:text-gray-400">{counts.cancelled} not run</span>}
          </div>
        </div>

        {finished && <FinalReport title={state.title} noun={state.noun} rows={state.rows} />}

        <ul className="min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto dark:divide-gray-700" data-testid="bulk-run-rows">
          {state.rows.map((row) => <RunRow key={row.item.id} row={row} />)}
        </ul>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3 dark:border-gray-700">
          {!finished && (
            <button
              type="button"
              onClick={cancel}
              disabled={state.phase === 'cancelling'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              data-testid="bulk-run-cancel"
            >
              {state.phase === 'cancelling' && <Loader2 size={14} className="animate-spin" />}
              {state.phase === 'cancelling' ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          {finished && counts.failed > 0 && (
            <button
              type="button"
              onClick={retryFailed}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50"
              data-testid="bulk-run-retry-failed"
            >
              <RotateCw size={14} />
              Retry failed ({counts.failed})
            </button>
          )}
          <button
            type="button"
            onClick={close}
            disabled={!finished}
            title={finished ? undefined : 'Available once the run finishes or is cancelled'}
            className="rounded-lg bg-brand-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-600 dark:hover:bg-brand-500"
            data-testid="bulk-run-close"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function FinalReport({ title, noun, rows }: { readonly title: string; readonly noun: string; readonly rows: readonly BulkRunRow[] }) {
  const counts = countRows(rows);
  return (
    <div className="space-y-2 border-b border-gray-100 px-5 py-3 dark:border-gray-700" data-testid="bulk-run-report">
      <p
        className={clsx(
          'flex items-center gap-2 text-sm font-medium',
          counts.failed > 0
            ? 'text-red-700 dark:text-red-300'
            : counts.cancelled > 0
              ? 'text-amber-700 dark:text-amber-300'
              : 'text-green-700 dark:text-green-300',
        )}
        data-testid="bulk-run-summary"
      >
        {counts.failed > 0 ? <XCircle size={16} /> : counts.cancelled > 0 ? <Ban size={16} /> : <CheckCircle2 size={16} />}
        {summaryText(counts)}
      </p>
      {counts.failed > 0 && (
        <ErrorPanel error={partialFailureError(title, noun, rows)} severity="error" compact testId="bulk-run-error" />
      )}
    </div>
  );
}

function RunRow({ row }: { readonly row: BulkRunRow }) {
  const style = STATUS_STYLE[row.status];
  const { Icon } = style;
  return (
    <li className="px-5 py-2.5" data-testid={`bulk-run-row-${row.item.id}`} data-status={row.status}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{row.item.label}</div>
          {row.item.sublabel && (
            <div className="truncate text-xs text-gray-500 dark:text-gray-400">{row.item.sublabel}</div>
          )}
        </div>
        <span
          className={clsx('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', style.cls)}
          data-testid={`bulk-run-status-${row.item.id}`}
        >
          <Icon size={12} className={style.spin ? 'animate-spin' : undefined} />
          {style.label}
        </span>
      </div>
      {row.detail && (
        <p
          className={clsx(
            'mt-1 text-xs',
            row.status === 'failed' ? 'text-red-700 dark:text-red-300' : 'text-gray-600 dark:text-gray-300',
          )}
          data-testid={`bulk-run-detail-${row.item.id}`}
        >
          {row.detail}
        </p>
      )}
      {row.lines && row.lines.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-red-700 dark:text-red-300">
          {row.lines.map((line, i) => <li key={i} className="break-words">{line}</li>)}
        </ul>
      )}
    </li>
  );
}
