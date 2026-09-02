import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import BulkProgressModal from '@/components/files/BulkProgressModal';
import { useBulkOperationRunner, type BulkRunState } from '@/hooks/use-bulk-operation';
import type { BulkFileResult } from '@/hooks/use-file-manager';

// WHY THIS EXISTS: on 2026-09-02 a tenant moved ~120 files between folders in
// the panel. The Copy/Move dialog fired one request PER FILE via
// `paths.map()` + `Promise.all` — 62 requests in two seconds — which tripped
// the 100/min API rate limit. `Promise.all` rejected on the first 429 while
// the rest of the requests kept succeeding, so the user was shown "Too many
// requests" for a move that had partly worked, with no way to see which files
// had actually moved. The whole selection now goes out as ONE streamed
// request and reports through this modal.

const baseState: BulkRunState = {
  phase: 'idle', label: '', total: 0, progress: null, result: null, error: null,
};

const result = (over: Partial<BulkFileResult> = {}): BulkFileResult => ({
  succeeded: [], failed: [], ...over,
});

describe('BulkProgressModal', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('renders nothing while idle', () => {
    const { container } = render(<BulkProgressModal state={baseState} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a determinate bar with the running count and current file', () => {
    render(<BulkProgressModal
      state={{
        ...baseState, phase: 'running', label: 'Moving 4 items', total: 4,
        progress: { done: 1, total: 4, percent: 25, current: '/src/a.txt' },
      }}
      onClose={vi.fn()}
    />);

    expect(screen.getByText('Moving 4 items')).toBeInTheDocument();
    expect(screen.getByTestId('bulk-progress-count')).toHaveTextContent('1 of 4 · 25%');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('/src/a.txt')).toBeInTheDocument();
  });

  it('auto-closes when every path succeeded', async () => {
    const onClose = vi.fn();
    render(<BulkProgressModal
      state={{
        ...baseState, phase: 'done', label: 'Moving 2 items', total: 2,
        result: result({ succeeded: ['/a', '/b'] }),
      }}
      onClose={onClose}
    />);

    // Held briefly at 100% first — a modal that vanishes the instant the last
    // file lands reads as a glitch rather than a completion.
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('STAYS OPEN and names every failure on a partial result', async () => {
    const onClose = vi.fn();
    render(<BulkProgressModal
      state={{
        ...baseState, phase: 'done', label: 'Moving 3 items', total: 3,
        result: result({
          succeeded: ['/a', '/b'],
          failed: [{ path: '/c', error: 'Source not found' }],
        }),
      }}
      onClose={onClose}
    />);

    await act(async () => { vi.advanceTimersByTime(5000); });
    // The exact regression: a partial outcome must never close itself, or the
    // user is told nothing about the files that did not move.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('bulk-progress-failures')).toHaveTextContent('2 succeeded, 1 failed');
    expect(screen.getByText('/c — Source not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('shows a whole-operation error without a failure list', async () => {
    const onClose = vi.fn();
    render(<BulkProgressModal
      state={{
        ...baseState, phase: 'failed', label: 'Moving 3 items', total: 3,
        error: 'Too many requests. Please retry after 41 seconds',
      }}
      onClose={onClose}
    />);

    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/Too many requests/)).toBeInTheDocument();
    expect(screen.queryByTestId('bulk-progress-failures')).not.toBeInTheDocument();
  });
});

describe('useBulkOperationRunner', () => {
  it('walks idle → running → done and threads progress frames through', async () => {
    const { result: hook } = renderHook(() => useBulkOperationRunner());
    let emit: ((p: { done: number; total: number; percent: number; current: string }) => void) | null = null;
    let finish: ((r: BulkFileResult) => void) | null = null;

    await act(async () => {
      void hook.current.run({
        label: 'Moving 2 items',
        total: 2,
        start: (onProgress) => {
          emit = onProgress;
          return new Promise<BulkFileResult>((res) => { finish = res; });
        },
      });
    });

    expect(hook.current.state.phase).toBe('running');
    expect(hook.current.state.label).toBe('Moving 2 items');

    await act(async () => { emit!({ done: 1, total: 2, percent: 50, current: '/a' }); });
    expect(hook.current.state.progress).toEqual({ done: 1, total: 2, percent: 50, current: '/a' });

    await act(async () => { finish!(result({ succeeded: ['/a', '/b'] })); });
    expect(hook.current.state.phase).toBe('done');
  });

  it('fires onFullSuccess ONLY when nothing failed', async () => {
    const { result: hook } = renderHook(() => useBulkOperationRunner());
    const onFullSuccess = vi.fn();

    await act(async () => {
      await hook.current.run({
        label: 'Moving 3 items',
        total: 3,
        start: async () => result({
          succeeded: ['/a', '/b'],
          failed: [{ path: '/c', error: 'denied' }],
        }),
        onFullSuccess,
      });
    });

    // Clearing the selection / closing the dialog on a partial result is what
    // hid the failures. `done` is reached, but the success hook is not.
    expect(hook.current.state.phase).toBe('done');
    expect(onFullSuccess).not.toHaveBeenCalled();

    await act(async () => {
      await hook.current.run({
        label: 'Moving 1 item', total: 1,
        start: async () => result({ succeeded: ['/a'] }),
        onFullSuccess,
      });
    });
    expect(onFullSuccess).toHaveBeenCalledTimes(1);
  });

  it('records a rejected request as a whole-operation failure, not a partial', async () => {
    const { result: hook } = renderHook(() => useBulkOperationRunner());
    const onFullSuccess = vi.fn();

    await act(async () => {
      await hook.current.run({
        label: 'Moving 9 items', total: 9,
        start: async () => { throw new Error('Too many requests. Please retry after 41 seconds'); },
        onFullSuccess,
      });
    });

    expect(hook.current.state.phase).toBe('failed');
    expect(hook.current.state.error).toMatch(/Too many requests/);
    expect(hook.current.state.result).toBeNull();
    expect(onFullSuccess).not.toHaveBeenCalled();
  });

  it('reset returns to idle so the modal unmounts', async () => {
    const { result: hook } = renderHook(() => useBulkOperationRunner());
    await act(async () => {
      await hook.current.run({ label: 'x', total: 1, start: async () => result({ succeeded: ['/a'] }) });
    });
    expect(hook.current.state.phase).toBe('done');
    await act(async () => { hook.current.reset(); });
    expect(hook.current.state.phase).toBe('idle');
  });

  it('ignores progress frames that arrive after the run settled', async () => {
    const { result: hook } = renderHook(() => useBulkOperationRunner());
    let emit: ((p: { done: number; total: number; percent: number; current: string }) => void) | null = null;

    await act(async () => {
      await hook.current.run({
        label: 'Moving 1 item', total: 1,
        start: (onProgress) => { emit = onProgress; return Promise.resolve(result({ succeeded: ['/a'] })); },
      });
    });

    const settled = hook.current.state;
    await act(async () => { emit!({ done: 99, total: 1, percent: 9900, current: '/late' }); });
    await waitFor(() => expect(hook.current.state.progress).toBe(settled.progress));
    expect(hook.current.state.phase).toBe('done');
  });
});
