import { useCallback, useEffect, useRef, useState } from 'react';
import {
  outcomeFromError,
  type BulkItemOutcome,
  type BulkRunItem,
  type BulkRunPhase,
  type BulkRunRow,
} from '@/lib/bulk-run';

export interface BulkRunConfig<T extends BulkRunItem> {
  /** Action name, e.g. "Refresh route DNS". */
  readonly title: string;
  /** Singular noun for one item, e.g. "domain". */
  readonly noun: string;
  readonly items: readonly T[];
  /** Performs ONE item. A throw is reported as that item failing. */
  readonly runItem: (item: T) => Promise<BulkItemOutcome>;
  /** Called once after every pass (first run and each retry) — invalidate queries here, not per item. */
  readonly onSettled?: () => void;
  /** Called on close with the ids that still need action: failed, plus any a cancel left unrun. */
  readonly onClose?: (remainingIds: readonly string[]) => void;
}

export interface BulkRunState {
  readonly title: string;
  readonly noun: string;
  readonly phase: BulkRunPhase;
  readonly rows: readonly BulkRunRow[];
}

export interface BulkRunController {
  readonly state: BulkRunState | null;
  readonly start: <T extends BulkRunItem>(config: BulkRunConfig<T>) => void;
  /** Stops before the next item; the one in flight still finishes. */
  readonly cancel: () => void;
  /** Runs the failed rows again, in order. */
  readonly retryFailed: () => void;
  /** Closes the modal. Ignored while a pass is still running. */
  readonly close: () => void;
}

interface ActiveRun {
  readonly runItem: (id: string) => Promise<BulkItemOutcome>;
  readonly onSettled?: () => void;
  readonly onClose?: (remainingIds: readonly string[]) => void;
}

/**
 * Drives a bulk action ONE REQUEST AT A TIME.
 *
 * Not `Promise.all(items.map(...))`: that fires every write at once at
 * rate-limited endpoints and settles on the first rejection while the rest
 * keep running, so the operator never learns which rows actually changed.
 * Each item is awaited before the next is issued, its outcome is recorded on
 * its own row, and a cancel takes effect between items.
 */
export function useBulkRun(): BulkRunController {
  const [state, setState] = useState<BulkRunState | null>(null);
  const activeRef = useRef<ActiveRun | null>(null);
  const runningRef = useRef(false);
  const cancelRef = useRef(false);

  // Leaving the page stops the loop after the in-flight request rather than
  // issuing writes nobody is watching.
  useEffect(() => () => {
    cancelRef.current = true;
  }, []);

  const patchRow = useCallback((id: string, patch: Omit<BulkRunRow, 'item'>) => {
    setState((s) => s && {
      ...s,
      rows: s.rows.map((r) => (r.item.id === id ? { item: r.item, ...patch } : r)),
    });
  }, []);

  const runPass = useCallback(async (ids: readonly string[]) => {
    const active = activeRef.current;
    if (!active || runningRef.current) return;
    runningRef.current = true;
    cancelRef.current = false;
    const pass = new Set(ids);
    setState((s) => s && {
      ...s,
      phase: 'running',
      rows: s.rows.map((r) => (pass.has(r.item.id) ? { item: r.item, status: 'queued' } : r)),
    });

    let stoppedEarly = false;
    for (const id of ids) {
      if (cancelRef.current) {
        stoppedEarly = true;
        break;
      }
      patchRow(id, { status: 'running' });
      let outcome: BulkItemOutcome;
      try {
        outcome = await active.runItem(id);
      } catch (err) {
        outcome = outcomeFromError(err);
      }
      patchRow(id, { status: outcome.status, detail: outcome.detail, lines: outcome.lines });
    }

    setState((s) => s && {
      ...s,
      phase: stoppedEarly ? 'cancelled' : 'done',
      rows: s.rows.map((r) => (r.status === 'queued' ? { item: r.item, status: 'cancelled' } : r)),
    });
    runningRef.current = false;
    active.onSettled?.();
  }, [patchRow]);

  const start = useCallback(<T extends BulkRunItem>(config: BulkRunConfig<T>) => {
    if (runningRef.current) return;
    const byId = new Map(config.items.map((item) => [item.id, item]));
    activeRef.current = {
      runItem: (id) => {
        const item = byId.get(id);
        return item
          ? config.runItem(item)
          : Promise.resolve({ status: 'failed', detail: 'Item is no longer part of this run.' });
      },
      onSettled: config.onSettled,
      onClose: config.onClose,
    };
    setState({
      title: config.title,
      noun: config.noun,
      phase: 'running',
      rows: config.items.map((item) => ({ item: { id: item.id, label: item.label, sublabel: item.sublabel }, status: 'queued' })),
    });
    void runPass(config.items.map((item) => item.id));
  }, [runPass]);

  const cancel = useCallback(() => {
    if (!runningRef.current) return;
    cancelRef.current = true;
    setState((s) => s && { ...s, phase: 'cancelling' });
  }, []);

  const retryFailed = useCallback(() => {
    if (runningRef.current || !state) return;
    const failed = state.rows.filter((r) => r.status === 'failed').map((r) => r.item.id);
    if (failed.length > 0) void runPass(failed);
  }, [state, runPass]);

  const close = useCallback(() => {
    if (runningRef.current || !state) return;
    const remaining = state.rows
      .filter((r) => r.status === 'failed' || r.status === 'cancelled')
      .map((r) => r.item.id);
    const onClose = activeRef.current?.onClose;
    activeRef.current = null;
    setState(null);
    onClose?.(remaining);
  }, [state]);

  return { state, start, cancel, retryFailed, close };
}
