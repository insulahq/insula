import { useCallback, useState } from 'react';
import type { StreamProgress } from '@/lib/ndjson-progress';
import type { BulkFileResult } from '@/hooks/use-file-manager';

/**
 * State machine behind <BulkProgressModal>.
 *
 * One place owns the four things every bulk file operation needs to show:
 * what it is doing, how far it has got, whether it finished, and — the part
 * that used to be missing entirely — WHICH paths failed when only some did.
 *
 * The distinction that matters: a rejected promise means the operation could
 * not run (rate limit, file-manager unreachable). A resolved result with a
 * non-empty `failed` means it ran and some paths did not make it. The old code
 * collapsed both into one thrown error, which is how a partial move got
 * reported as "Too many requests" and nothing else.
 */

export type BulkPhase = 'idle' | 'running' | 'done' | 'failed';

export interface BulkRunState {
  readonly phase: BulkPhase;
  /** Human label for the modal header, e.g. "Moving 42 items". */
  readonly label: string;
  readonly total: number;
  readonly progress: StreamProgress | null;
  readonly result: BulkFileResult | null;
  /** Set only when the operation as a whole failed. */
  readonly error: string | null;
}

const IDLE: BulkRunState = {
  phase: 'idle', label: '', total: 0, progress: null, result: null, error: null,
};

export interface BulkRunRequest {
  readonly label: string;
  readonly total: number;
  /** Starts the streamed request; receives the progress callback to pass on. */
  readonly start: (onProgress: (p: StreamProgress) => void) => Promise<BulkFileResult>;
  /**
   * Runs ONLY on a clean sweep (every path succeeded). Closing the dialog and
   * clearing the selection on a partial result would hide the failures the
   * user still has to act on.
   */
  readonly onFullSuccess?: (result: BulkFileResult) => void;
}

export function useBulkOperationRunner() {
  const [state, setState] = useState<BulkRunState>(IDLE);

  const reset = useCallback(() => setState(IDLE), []);

  const run = useCallback(async ({ label, total, start, onFullSuccess }: BulkRunRequest) => {
    setState({ phase: 'running', label, total, progress: null, result: null, error: null });
    try {
      const result = await start((progress) => {
        // Functional update: progress frames arrive faster than React commits,
        // and closing over a stale `state` would drop frames.
        setState(prev => (prev.phase === 'running' ? { ...prev, progress } : prev));
      });
      setState(prev => ({ ...prev, phase: 'done', result }));
      if (result.failed.length === 0) onFullSuccess?.(result);
    } catch (err) {
      setState(prev => ({
        ...prev,
        phase: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  return { state, run, reset };
}
