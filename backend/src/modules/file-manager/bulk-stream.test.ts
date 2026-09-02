import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { streamBulkPathOperation, failBulkStream, joinDestination } from './bulk-stream.js';

/**
 * Minimal ServerResponse stand-in that records the NDJSON it was handed.
 *
 * The frames are the contract with the panel's `streamNdjsonOperation`
 * reader, so the tests assert on parsed frames rather than on the runner's
 * return value alone — a summary that is correct but never reaches the wire
 * is exactly the failure mode this endpoint is meant to remove.
 */
function fakeRes() {
  const chunks: string[] = [];
  const res = {
    headersSent: false,
    statusCode: 200,
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
      return this;
    },
    write(chunk: string) { chunks.push(chunk); return true; },
    end: vi.fn(),
  };
  return {
    res: res as unknown as ServerResponse,
    frames: () => chunks.join('').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)),
    raw: res,
  };
}

describe('streamBulkPathOperation', () => {
  it('emits start, one progress frame per path, then complete', async () => {
    const { res, frames, raw } = fakeRes();

    const summary = await streamBulkPathOperation(res, ['/a', '/b', '/c'], async () => ({ ok: true }));

    const f = frames();
    expect(f[0]).toEqual({ type: 'start', total: 3 });
    expect(f.slice(1, 4)).toEqual([
      { type: 'progress', done: 1, total: 3, percent: 33, current: '/a' },
      { type: 'progress', done: 2, total: 3, percent: 67, current: '/b' },
      { type: 'progress', done: 3, total: 3, percent: 100, current: '/c' },
    ]);
    expect(f[4]).toMatchObject({ type: 'complete', succeeded: ['/a', '/b', '/c'], failed: [] });
    expect(summary.succeeded).toEqual(['/a', '/b', '/c']);
    expect(raw.end).toHaveBeenCalled();
    expect(raw.headers['Content-Type']).toBe('application/x-ndjson');
  });

  it('keeps going after a per-path failure and reports it in complete', async () => {
    const { res, frames } = fakeRes();

    const summary = await streamBulkPathOperation(res, ['/ok', '/bad', '/ok2'], async (path) =>
      path === '/bad' ? { ok: false, error: 'Source not found' } : { ok: true });

    // The whole point: /ok2 was still attempted after /bad failed.
    expect(summary.succeeded).toEqual(['/ok', '/ok2']);
    expect(summary.failed).toEqual([{ path: '/bad', error: 'Source not found' }]);

    const complete = frames().find(x => x.type === 'complete');
    expect(complete).toMatchObject({
      succeeded: ['/ok', '/ok2'],
      failed: [{ path: '/bad', error: 'Source not found' }],
    });
    // A per-path failure must NOT be an `error` frame — that is the only frame
    // the client throws on, and throwing would hide the two that succeeded.
    expect(frames().some(x => x.type === 'error')).toBe(false);
  });

  it('treats a THROWN runner as a per-path failure, not a batch abort', async () => {
    const { res } = fakeRes();

    const summary = await streamBulkPathOperation(res, ['/a', '/b'], async (path) => {
      if (path === '/a') throw new Error('file-manager hiccup');
      return { ok: true };
    });

    expect(summary.failed).toEqual([{ path: '/a', error: 'file-manager hiccup' }]);
    expect(summary.succeeded).toEqual(['/b']);
  });

  it('runs paths sequentially, never concurrently', async () => {
    const { res } = fakeRes();
    let inFlight = 0;
    let maxInFlight = 0;

    await streamBulkPathOperation(res, ['/1', '/2', '/3', '/4'], async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 1));
      inFlight -= 1;
      return { ok: true };
    });

    // Concurrency here would just move the client-side stampede one hop
    // closer to a single-threaded sidecar with a 128Mi limit.
    expect(maxInFlight).toBe(1);
  });

  it('collects trash ids only from the paths that succeeded', async () => {
    const { res } = fakeRes();

    const summary = await streamBulkPathOperation(res, ['/a', '/b', '/c'], async (path) => {
      if (path === '/b') return { ok: false, error: 'denied' };
      return { ok: true, trashedId: `trash-${path.slice(1)}` };
    });

    expect(summary.trashedIds).toEqual(['trash-a', 'trash-c']);
  });

  it('labels a failure with no message rather than emitting an empty reason', async () => {
    const { res } = fakeRes();
    const summary = await streamBulkPathOperation(res, ['/x'], async () => ({ ok: false }));
    expect(summary.failed).toEqual([{ path: '/x', error: 'Unknown error' }]);
  });
});

describe('failBulkStream', () => {
  it('writes an error frame and ends when nothing has been sent yet', () => {
    const { res, frames, raw } = fakeRes();
    failBulkStream(res, 'file-manager never became ready');
    expect(frames()).toEqual([{ type: 'error', message: 'file-manager never became ready' }]);
    expect(raw.end).toHaveBeenCalled();
  });

  it('still appends an error frame after headers are already sent', async () => {
    const { res, frames } = fakeRes();
    // `start` goes out before the first path runs, so a mid-stream failure
    // always finds headersSent === true.
    await streamBulkPathOperation(res, ['/a'], async () => ({ ok: true }));
    failBulkStream(res, 'connection lost');
    expect(frames().at(-1)).toEqual({ type: 'error', message: 'connection lost' });
  });
});

describe('joinDestination', () => {
  it.each([
    ['/dest', '/src/file.txt', '/dest/file.txt'],
    ['/dest/', '/src/file.txt', '/dest/file.txt'],
    ['/', '/src/file.txt', '/file.txt'],
    ['/dest', '/src/folder/', '/dest/folder'],
    ['/a/b', '/c/d/e.tar.gz', '/a/b/e.tar.gz'],
  ])('joins %s + %s => %s', (destDir, source, expected) => {
    expect(joinDestination(destDir, source)).toBe(expected);
  });
});
