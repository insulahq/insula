import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/hooks/use-tenant-context', () => ({ useTenantContext: () => ({ tenantId: 't1' }) }));

const { useUploadFiles } = await import('@/hooks/use-file-manager');

// Drives the real upload hook with a scripted XMLHttpRequest and a scripted
// clock, so the speed the modal shows is checked against the events that
// produced it — single-stream and chunked, through done, error and cancel.

const MB = 1024 * 1024;

class FakeXhr {
  static sent: FakeXhr[] = [];
  readonly upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  statusText = '';
  responseText = '';
  url = '';
  open(_method: string, url: string): void { this.url = url; }
  setRequestHeader(): void { /* headers are not under test */ }
  send(): void { FakeXhr.sent.push(this); }
  abort(): void { this.onabort?.(); }
  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  finish(status: number, responseText = ''): void {
    this.status = status;
    this.responseText = responseText;
    this.onload?.();
  }
}

let clock = 0;
const realXhr = globalThis.XMLHttpRequest;

beforeEach(() => {
  FakeXhr.sent = [];
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  // Only the interval is faked: the clock above is the one the hook reads.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
});

afterEach(() => {
  globalThis.XMLHttpRequest = realXhr;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useUploadFiles(), { wrapper });
}

function fileOf(bytes: number, name = 'site.zip'): File {
  return new File([new Uint8Array(bytes)], name);
}

describe('useUploadFiles — single-stream speed', () => {
  it('reports no speed at first, the moving speed once measurable, and the timing when done', () => {
    const { result } = setup();
    act(() => result.current.uploadFiles([fileOf(4 * MB)], '/'));
    expect(result.current.uploads[0]).toMatchObject({ status: 'uploading', startedAt: 0, speed: null });

    const xhr = FakeXhr.sent[0];
    clock = 500;
    act(() => xhr.progress(MB, 4 * MB));
    // Half a second in is too early to call a speed.
    expect(result.current.uploads[0].speed).toBeNull();

    clock = 2_000;
    act(() => xhr.progress(2 * MB, 4 * MB));
    expect(result.current.uploads[0].speed).toBeCloseTo(MB, 0);
    expect(result.current.uploads[0].percent).toBe(50);

    clock = 4_000;
    act(() => xhr.finish(200));
    expect(result.current.uploads[0]).toMatchObject({
      status: 'done', loaded: 4 * MB, percent: 100, startedAt: 0, finishedAt: 4_000, speed: null,
    });
  });

  it('decays the live speed to zero when the link stalls', () => {
    const { result } = setup();
    act(() => result.current.uploadFiles([fileOf(4 * MB)], '/'));
    const xhr = FakeXhr.sent[0];
    clock = 2_000;
    act(() => xhr.progress(2 * MB, 4 * MB));
    expect(result.current.uploads[0].speed).toBeCloseTo(MB, 0);

    // No progress events for four seconds. Without the heartbeat the
    // reading would still say 1 MB/s.
    clock = 6_000;
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(result.current.uploads[0].speed).toBe(0);
    expect(result.current.uploads[0].status).toBe('uploading');
  });

  it('drops the speed when the server rejects the upload', () => {
    const { result } = setup();
    act(() => result.current.uploadFiles([fileOf(4 * MB)], '/'));
    const xhr = FakeXhr.sent[0];
    clock = 2_000;
    act(() => xhr.progress(2 * MB, 4 * MB));
    act(() => xhr.finish(507, JSON.stringify({ error: { message: 'Disk quota exceeded' } })));
    expect(result.current.uploads[0]).toMatchObject({ status: 'error', error: 'Disk quota exceeded', speed: null });
    expect(result.current.uploads[0].finishedAt).toBeUndefined();
  });

  it('drops the speed on a network error', () => {
    const { result } = setup();
    act(() => result.current.uploadFiles([fileOf(4 * MB)], '/'));
    const xhr = FakeXhr.sent[0];
    clock = 2_000;
    act(() => xhr.progress(2 * MB, 4 * MB));
    act(() => xhr.onerror?.());
    expect(result.current.uploads[0]).toMatchObject({ status: 'error', speed: null });
  });

  it('drops the speed when the user cancels', () => {
    const { result } = setup();
    act(() => result.current.uploadFiles([fileOf(4 * MB)], '/'));
    clock = 2_000;
    act(() => FakeXhr.sent[0].progress(2 * MB, 4 * MB));
    expect(result.current.uploads[0].speed).not.toBeNull();
    act(() => result.current.uploads[0].abort?.());
    expect(result.current.uploads[0]).toMatchObject({ status: 'cancelled', speed: null });
  });

  it('stops the heartbeat once nothing is uploading', () => {
    const { result } = setup();
    act(() => result.current.uploadFiles([fileOf(MB)], '/'));
    expect(vi.getTimerCount()).toBe(1);
    clock = 1_000;
    act(() => FakeXhr.sent[0].finish(200));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('useUploadFiles — chunked speed', () => {
  // 9 MiB is over the 8 MiB threshold: three chunks (4 + 4 + 1 MiB), all in flight at once.
  const SIZE = 9 * MB;

  it('measures the combined speed of parallel chunks and times the whole file', async () => {
    const { result } = setup();
    act(() => result.current.uploadFiles([fileOf(SIZE, 'big.bin')], '/'));
    expect(FakeXhr.sent).toHaveLength(3);
    expect(result.current.uploads[0].chunks).toHaveLength(3);

    clock = 2_000;
    act(() => {
      FakeXhr.sent[0].progress(MB, 4 * MB);
      FakeXhr.sent[1].progress(MB, 4 * MB);
      FakeXhr.sent[2].progress(MB, MB);
    });
    // 3 MiB across three flows in two seconds.
    expect(result.current.uploads[0].speed).toBeCloseTo(1.5 * MB, 0);
    expect(result.current.uploads[0].loaded).toBe(3 * MB);

    clock = 6_000;
    await act(async () => {
      FakeXhr.sent[0].finish(200);
      FakeXhr.sent[1].finish(200);
      FakeXhr.sent[2].finish(200);
    });
    expect(result.current.uploads[0]).toMatchObject({
      status: 'done', loaded: SIZE, startedAt: 0, finishedAt: 6_000, speed: null,
    });
  });

  it('drops the speed when a chunk fails', async () => {
    const { result } = setup();
    act(() => result.current.uploadFiles([fileOf(SIZE, 'big.bin')], '/'));
    clock = 2_000;
    act(() => FakeXhr.sent[0].progress(2 * MB, 4 * MB));
    expect(result.current.uploads[0].speed).not.toBeNull();
    await act(async () => { FakeXhr.sent[1].finish(500); });
    expect(result.current.uploads[0]).toMatchObject({ status: 'error', speed: null });
  });

  it('drops the speed when the user cancels a chunked upload', () => {
    const { result } = setup();
    act(() => result.current.uploadFiles([fileOf(SIZE, 'big.bin')], '/'));
    clock = 2_000;
    act(() => FakeXhr.sent[0].progress(2 * MB, 4 * MB));
    act(() => result.current.uploads[0].abort?.());
    expect(result.current.uploads[0]).toMatchObject({ status: 'cancelled', speed: null });
  });
});
