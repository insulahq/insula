/**
 * platform-api bouncer self-heal + 403 retry unit tests.
 *
 * Covers the lapiGet 403 → re-register → retry-once flow. The integration
 * harness (Phase 4 / Phase G / Phase K) exercises the live cscli + LAPI
 * round-trip; these tests close gaps the harness can't simulate cheaply:
 *
 *   - 200 happy path (no self-heal)
 *   - 403 without `kc` provided → surface the 403 (no heal attempt)
 *   - 403 → reregister succeeds → retry → 200 (full self-heal)
 *   - 403 → reregister fails → surface the operator-actionable error
 *     (covers the cross-replica race documented in service.ts)
 *   - The retry uses a FRESH AbortController so a timed-out initial
 *     attempt's aborted signal doesn't silently defeat the retry —
 *     this is the HIGH bug the code-reviewer caught pre-merge.
 *
 * The non-stream `/v1/decisions` endpoint choice is exercised by the
 * existing harness; not duplicated here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock cscli-exec BEFORE importing the module under test so the
// `cscliExec` reference inside reregisterPlatformApiBouncer hits the
// mock and not a real kubectl exec.
vi.mock('./cscli-exec.js', () => ({
  cscliExec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  findCrowdsecPodName: vi.fn().mockResolvedValue('crowdsec-test-pod'),
}));

import { cscliExec } from './cscli-exec.js';
import { __test } from './crowdsec.js';

const { lapiGet, resetInFlightReregister } = __test;
const mockedCscli = vi.mocked(cscliExec);

const fakeKc = {} as unknown as Parameters<typeof lapiGet>[2];

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const status403 = () =>
  new Response(JSON.stringify({ message: 'access forbidden' }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  resetInFlightReregister();
  mockedCscli.mockReset();
  mockedCscli.mockResolvedValue({ stdout: '', stderr: '' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lapiGet — happy path', () => {
  it('returns parsed JSON on 200 without invoking cscli', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson([{ id: 1, value: '1.2.3.4' }])));

    const out = await lapiGet<Array<{ id: number; value: string }>>(
      '/v1/decisions',
      'fake-key',
      fakeKc,
    );

    expect(out).toEqual([{ id: 1, value: '1.2.3.4' }]);
    expect(mockedCscli).not.toHaveBeenCalled();
  });
});

describe('lapiGet — 403 without kc (cannot self-heal)', () => {
  it('surfaces the operator-actionable 403 message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(status403()));

    // Pass kc=undefined to disable the self-heal branch.
    await expect(lapiGet('/v1/decisions', 'fake-key', undefined)).rejects.toThrow(/HTTP 403/);
    expect(mockedCscli).not.toHaveBeenCalled();
  });
});

describe('lapiGet — 403 → self-heal → retry succeeds', () => {
  it('re-registers via cscli, retries once, returns the 200 body', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(status403())          // initial attempt → 403
      .mockResolvedValueOnce(okJson([{ id: 99 }])); // retry after self-heal → 200
    vi.stubGlobal('fetch', fetchMock);

    const out = await lapiGet<Array<{ id: number }>>('/v1/decisions', 'fake-key', fakeKc);

    expect(out).toEqual([{ id: 99 }]);
    // delete (no-op if not registered) then add — both via cscliExec.
    expect(mockedCscli).toHaveBeenCalledTimes(2);
    expect(mockedCscli.mock.calls[0][2]).toEqual(['bouncers', 'delete', 'platform-api']);
    expect(mockedCscli.mock.calls[1][2]).toEqual([
      'bouncers', 'add', 'platform-api', '-k', 'fake-key',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('swallows the cscli delete error (bouncer not registered yet)', async () => {
    mockedCscli
      .mockRejectedValueOnce(new Error('bouncer not found'))    // delete fails — ok
      .mockResolvedValueOnce({ stdout: 'added', stderr: '' });  // add succeeds
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>()
        .mockResolvedValueOnce(status403())
        .mockResolvedValueOnce(okJson([])),
    );

    const out = await lapiGet('/v1/decisions', 'k', fakeKc);
    expect(out).toEqual([]);
    expect(mockedCscli).toHaveBeenCalledTimes(2);
  });
});

describe('lapiGet — 403 → self-heal fails → operator-actionable error', () => {
  it('surfaces the post-heal 403 message when cscli add fails (cross-replica race)', async () => {
    mockedCscli
      .mockResolvedValueOnce({ stdout: '', stderr: '' })          // delete ok
      .mockRejectedValueOnce(new Error('bouncer already exists')); // add lost the race
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValueOnce(status403()));

    await expect(lapiGet('/v1/decisions', 'k', fakeKc))
      .rejects.toThrow(/HTTP 403.*self-heal attempt|bouncer key rejected/);
  });

  it('surfaces a non-403, non-200 error verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('boom', { status: 502 })),
    );

    await expect(lapiGet('/v1/decisions', 'k', fakeKc)).rejects.toThrow(/HTTP 502/);
    expect(mockedCscli).not.toHaveBeenCalled();
  });
});

describe('lapiGet — retry uses a fresh AbortController (HIGH review fix)', () => {
  it('does NOT inherit an aborted signal from the initial attempt on retry', async () => {
    // Capture both fetch calls' signals so we can prove they're distinct.
    const seenSignals: Array<AbortSignal | undefined> = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      seenSignals.push(init?.signal as AbortSignal | undefined);
      // First call returns 403 (triggers self-heal); second returns 200.
      return seenSignals.length === 1 ? status403() : okJson([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    await lapiGet('/v1/decisions', 'k', fakeKc);

    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).not.toBe(seenSignals[1]);
    // The retry signal must NOT be in an aborted state (which would
    // immediately reject the retry fetch before it hits the network —
    // the exact failure mode the HIGH review fix closed).
    expect(seenSignals[1]?.aborted).toBe(false);
  });
});

describe('lapiGet — coalesced self-heal across concurrent calls', () => {
  it('runs only one cscli add for N parallel 403s', async () => {
    // Two parallel callers both hit 403 → one self-heal cycle runs →
    // both retries succeed. Without coalescing this would be 2 cscli
    // add calls and a potential sqlite race on the CrowdSec pod.
    let healCalls = 0;
    mockedCscli.mockImplementation(async (..._args) => {
      healCalls += 1;
      return { stdout: '', stderr: '' };
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      return fetchMock.mock.calls.length <= 2 ? status403() : okJson([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    await Promise.all([
      lapiGet('/v1/decisions', 'k', fakeKc),
      lapiGet('/v1/decisions', 'k', fakeKc),
    ]);

    // cscli is called twice per heal cycle (delete + add). Coalesced
    // means one cycle = 2 cscli calls, NOT 4.
    expect(healCalls).toBe(2);
  });
});
