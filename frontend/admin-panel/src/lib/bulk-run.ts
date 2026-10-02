import { OPERATOR_ERROR_CODES, type BulkIdResult, type OperatorError } from '@insula/api-contracts';
import { ApiError } from '@/lib/api-client';

/**
 * Shared model for the admin panel's sequential bulk actions: one request per
 * selected row, awaited in order, each row reporting its own outcome.
 */

export type BulkItemStatus = 'queued' | 'running' | 'succeeded' | 'skipped' | 'failed' | 'cancelled';

/** A selected row as the progress modal shows it. */
export interface BulkRunItem {
  readonly id: string;
  /** Primary name: domain name, cron job name, tenant name. */
  readonly label: string;
  /** Secondary context, e.g. the owning tenant. */
  readonly sublabel?: string;
}

/** What one request concluded. `lines` lists sub-item problems (per hostname, per check). */
export interface BulkItemOutcome {
  readonly status: 'succeeded' | 'skipped' | 'failed';
  readonly detail?: string;
  readonly lines?: readonly string[];
}

export interface BulkRunRow {
  readonly item: BulkRunItem;
  readonly status: BulkItemStatus;
  readonly detail?: string;
  readonly lines?: readonly string[];
}

export type BulkRunPhase = 'running' | 'cancelling' | 'done' | 'cancelled';

export interface BulkRunCounts {
  readonly total: number;
  readonly queued: number;
  readonly running: number;
  readonly succeeded: number;
  readonly skipped: number;
  readonly failed: number;
  /** Rows a cancel left unrun. */
  readonly cancelled: number;
  /** Rows with a final outcome: succeeded + skipped + failed. */
  readonly processed: number;
}

export function countRows(rows: readonly BulkRunRow[]): BulkRunCounts {
  const by = (s: BulkItemStatus) => rows.filter((r) => r.status === s).length;
  const succeeded = by('succeeded');
  const skipped = by('skipped');
  const failed = by('failed');
  return {
    total: rows.length,
    queued: by('queued'),
    running: by('running'),
    succeeded,
    skipped,
    failed,
    cancelled: by('cancelled'),
    processed: succeeded + skipped + failed,
  };
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** "N succeeded, M skipped, K failed" — plus the unrun count after a cancel. */
export function summaryText(counts: BulkRunCounts): string {
  const base = `${counts.succeeded} succeeded, ${counts.skipped} skipped, ${counts.failed} failed`;
  return counts.cancelled > 0 ? `${base}, ${counts.cancelled} not run (cancelled)` : base;
}

/** A thrown request error as a failed row, keeping the API's error code visible. */
export function outcomeFromError(err: unknown): BulkItemOutcome {
  if (err instanceof ApiError) {
    const code = err.code && err.code !== 'UNKNOWN' ? ` (${err.code})` : '';
    return { status: 'failed', detail: `${err.message || `HTTP ${err.status}`}${code}` };
  }
  return { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
}

/**
 * Read one id's outcome out of a `/admin/<resource>/bulk` response. An id in
 * neither list is a failure: the summary must never count a write the API did
 * not confirm.
 */
export function outcomeFromIdResult(result: BulkIdResult, id: string, successDetail: string): BulkItemOutcome {
  const failure = result.failed.find((f) => f.id === id);
  if (failure) return { status: 'failed', detail: failure.error };
  if (result.succeeded.includes(id)) return { status: 'succeeded', detail: successDetail };
  return { status: 'failed', detail: 'The API returned no result for this item.' };
}

/** The final report for a run with at least one failed row. */
export function partialFailureError(
  title: string,
  noun: string,
  rows: readonly BulkRunRow[],
): OperatorError {
  const counts = countRows(rows);
  const failures = rows
    .filter((r) => r.status === 'failed')
    .map((r) => `${r.item.label}: ${r.detail ?? 'failed'}`);
  return {
    code: OPERATOR_ERROR_CODES.BULK_PARTIAL_FAILURE,
    title: `${title}: ${counts.failed} of ${plural(counts.total, noun)} failed`,
    detail: `${summaryText(counts)}. The failed ${noun}s stay selected after you close this dialog, so a retry touches only those.`,
    remediation: [
      `Read the reason on each failed row, fix the cause, then use "Retry failed" — only the failed ${noun}s run again.`,
      `A failure that repeats on retry is not transient: open the ${noun} itself to see the full error.`,
    ],
    retryable: true,
    diagnostics: { failures },
  };
}
