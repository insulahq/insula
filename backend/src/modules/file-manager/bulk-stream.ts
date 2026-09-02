import type { ServerResponse } from 'node:http';

/**
 * Shared executor for every bulk file-manager operation.
 *
 * ONE request carries a whole selection; progress is streamed back as NDJSON
 * in exactly the frame shapes `/files/archive` and `/files/extract` already
 * emit, so the panel's `streamNdjsonOperation` reader consumes them unchanged.
 *
 * Two invariants this exists to enforce:
 *
 *   1. **A per-path failure never aborts the batch.** The loop that threw on
 *      the first rejection is what left production with a partial move nobody
 *      could see. Every path is attempted; the outcome of each is reported.
 *   2. **The stream always terminates in exactly one `complete` or one
 *      `error` frame.** The client treats a stream that stops without either
 *      as a failure, so a silent return would be reported as "stopped
 *      unexpectedly" rather than success.
 *
 * Execution is deliberately SEQUENTIAL. The file-manager sidecar is a
 * single-threaded Node process with a 128Mi limit; firing a selection at it
 * concurrently is the client-side bug moved one hop closer to the disk. It
 * also makes `done` monotonic, which a progress bar needs.
 */

export interface BulkPathOutcome {
  readonly ok: boolean;
  /** Reason shown next to the path in the panel. Required when `ok` is false. */
  readonly error?: string;
  /** Recycle-bin id, for the delete path only. Ignored elsewhere. */
  readonly trashedId?: string;
}

export type BulkPathRunner = (path: string, index: number) => Promise<BulkPathOutcome>;

export interface BulkRunSummary {
  readonly succeeded: readonly string[];
  readonly failed: ReadonlyArray<{ path: string; error: string }>;
  readonly trashedIds: readonly string[];
}

function writeFrame(res: ServerResponse, frame: Record<string, unknown>): void {
  res.write(`${JSON.stringify(frame)}\n`);
}

/**
 * Run `runOne` over every path, streaming progress, and resolve with the
 * summary that was sent in the `complete` frame.
 *
 * The summary is returned as well as streamed so callers can act on the
 * outcome (note trash activity, sweep the bin) without re-deriving it.
 */
export async function streamBulkPathOperation(
  res: ServerResponse,
  paths: readonly string[],
  runOne: BulkPathRunner,
  options: { readonly extraCompleteFields?: Record<string, unknown> } = {},
): Promise<BulkRunSummary> {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
    // The panel is served through its own nginx; without this a proxy is free
    // to buffer the whole stream and deliver it at the end, which turns a live
    // progress bar into a spinner that jumps to 100%.
    'X-Accel-Buffering': 'no',
  });

  const total = paths.length;
  writeFrame(res, { type: 'start', total });

  const succeeded: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  const trashedIds: string[] = [];

  for (let index = 0; index < total; index += 1) {
    const path = paths[index];
    let outcome: BulkPathOutcome;
    try {
      outcome = await runOne(path, index);
    } catch (err) {
      // Keep going: the whole point is that one bad path does not abort the
      // batch and strand the caller without a report.
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (outcome.ok) {
      succeeded.push(path);
      if (outcome.trashedId) trashedIds.push(outcome.trashedId);
    } else {
      failed.push({ path, error: outcome.error ?? 'Unknown error' });
    }

    const done = index + 1;
    writeFrame(res, {
      type: 'progress',
      done,
      total,
      percent: Math.round((done / total) * 100),
      current: path,
    });
  }

  const summary: BulkRunSummary = { succeeded, failed, trashedIds };
  writeFrame(res, {
    type: 'complete',
    succeeded,
    failed,
    trashedIds,
    ...options.extraCompleteFields,
  });
  res.end();
  return summary;
}

/**
 * Terminate a hijacked bulk stream with a whole-operation failure.
 *
 * Distinct from a per-path failure on purpose: this is the only frame that
 * makes the client throw. Used when the operation could not run at all —
 * the file-manager never came ready, the namespace vanished mid-flight.
 *
 * Safe to call after headers are already sent (the `start` frame goes out
 * before the first path runs), which is why it re-checks `headersSent`
 * instead of assuming it owns the response.
 */
export function failBulkStream(res: ServerResponse, message: string): void {
  try {
    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
      });
    }
    writeFrame(res, { type: 'error', message });
    res.end();
  } catch {
    // The socket is already gone — nothing left to report to.
  }
}

/**
 * Join a destination DIRECTORY with a source path's basename.
 *
 * Bulk move/copy take a directory, not N destinations, so this join happens
 * once on the server instead of at every call site in the panel.
 *
 * Deliberately string-only (no `node:path`): these are POSIX paths inside the
 * tenant volume, and `path.join` on a future non-POSIX host would rewrite the
 * separator. Traversal is NOT this function's job — the sidecar's `safePath`
 * is the authority that confines every path to the volume, and it re-validates
 * whatever we hand it.
 */
export function joinDestination(destDir: string, sourcePath: string): string {
  const basename = sourcePath.split('/').filter(Boolean).pop() ?? '';
  const base = destDir.endsWith('/') ? destDir.slice(0, -1) : destDir;
  return `${base}/${basename}`;
}
