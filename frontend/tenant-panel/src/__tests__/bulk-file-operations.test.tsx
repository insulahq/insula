import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MAX_BULK_PATHS } from '@insula/api-contracts';
import BulkProgressModal from '@/components/files/BulkProgressModal';
import { useBulkOperationRunner, type BulkRunState } from '@/hooks/use-bulk-operation';
import type { BulkFileResult } from '@/hooks/use-file-manager';

const mockStream = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ndjson-progress', () => ({ streamNdjsonOperation: mockStream }));
vi.mock('@/hooks/use-tenant-context', () => ({ useTenantContext: () => ({ tenantId: 't1' }) }));

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

// ─── WAF-imposed chunking ────────────────────────────────────────────────────
//
// The cap is not ours: ModSecurity's JSON body processor turns every array
// element into its own ARGS entry, and rule 200007 refuses a request once the
// argument count reaches 1000. Measured on a live cluster (2026-09-02): a
// 900-path body passes, a 1000-path body is refused at the edge as a bare
// nginx 400 that never reaches the API and carries no error envelope. So a
// large selection has to go out as several bounded requests.

describe('bulk requests are chunked under the WAF argument ceiling', () => {
  function wrapper({ children }: { children: React.ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    mockStream.mockReset();
    mockStream.mockImplementation(async (_url: string, body: { paths: string[] }, opts?: {
      onProgress?: (p: { done: number; total: number; percent: number; current: string }) => void;
    }) => {
      body.paths.forEach((p, i) => opts?.onProgress?.({
        done: i + 1, total: body.paths.length,
        percent: Math.round(((i + 1) / body.paths.length) * 100), current: p,
      }));
      return { succeeded: body.paths, failed: [], trashedIds: [] };
    });
  });

  it('stays strictly below the 1000-ARG ceiling', () => {
    // paths + the sibling body fields must not reach 1000 entries.
    expect(MAX_BULK_PATHS).toBeLessThan(1000);
  });

  it('splits a large selection into consecutive bounded requests', async () => {
    const { useBulkMoveFiles } = await import('@/hooks/use-file-manager');
    const { result } = renderHook(() => useBulkMoveFiles(), { wrapper });
    const paths = Array.from({ length: MAX_BULK_PATHS * 2 + 7 }, (_, i) => `/src/f${i}.txt`);

    let out: BulkFileResult | undefined;
    await act(async () => { out = await result.current.mutateAsync({ paths, destDir: '/dest' }); });

    expect(mockStream).toHaveBeenCalledTimes(3);
    const sizes = mockStream.mock.calls.map(c => (c[1] as { paths: string[] }).paths.length);
    expect(sizes).toEqual([MAX_BULK_PATHS, MAX_BULK_PATHS, 7]);
    expect(mockStream.mock.calls.every(c => (c[1] as { destDir: string }).destDir === '/dest')).toBe(true);
    expect(out!.succeeded).toEqual(paths);
  });

  it('reports ONE continuous progress count across chunks', async () => {
    const { useBulkMoveFiles } = await import('@/hooks/use-file-manager');
    const { result } = renderHook(() => useBulkMoveFiles(), { wrapper });
    const paths = Array.from({ length: MAX_BULK_PATHS + 3 }, (_, i) => `/src/f${i}.txt`);
    // `total` is `number | null` on StreamProgress — archive/extract cannot
    // always know their member count. A bulk op always can, which is what the
    // assertion below pins.
    const seen: Array<{ done: number; total: number | null }> = [];

    await act(async () => {
      await result.current.mutateAsync({ paths, destDir: '/dest', onProgress: p => seen.push({ done: p.done, total: p.total }) });
    });

    // The bar must not restart at zero on the second request.
    expect(seen).toHaveLength(paths.length);
    expect(seen.map(s => s.done)).toEqual(Array.from({ length: paths.length }, (_, i) => i + 1));
    expect(new Set(seen.map(s => s.total))).toEqual(new Set([paths.length]));
  });

  it('merges failures from every chunk instead of keeping only the last', async () => {
    mockStream.mockImplementation(async (_url: string, body: { paths: string[] }) => ({
      succeeded: body.paths.slice(1),
      failed: [{ path: body.paths[0], error: 'denied' }],
      trashedIds: [],
    }));
    const { useBulkDeleteFiles } = await import('@/hooks/use-file-manager');
    const { result } = renderHook(() => useBulkDeleteFiles(), { wrapper });
    const paths = Array.from({ length: MAX_BULK_PATHS + 1 }, (_, i) => `/f${i}`);

    let out: BulkFileResult | undefined;
    await act(async () => { out = await result.current.mutateAsync({ paths }); });

    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(out!.failed).toHaveLength(2);
    expect(out!.succeeded).toHaveLength(paths.length - 2);
  });

  it('sends a single request when the selection fits', async () => {
    const { useBulkChmod } = await import('@/hooks/use-file-manager');
    const { result } = renderHook(() => useBulkChmod(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ paths: ['/a', '/b'], mode: '750' }); });
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect((mockStream.mock.calls[0][1] as { mode: string }).mode).toBe('750');
  });
});
