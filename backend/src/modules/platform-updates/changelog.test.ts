import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getReleaseNotes } from './service.js';

/**
 * `getReleaseNotes` proxies the GitHub Releases API for the version an operator
 * is about to approve. Two properties matter more than the happy path:
 *
 *  1. It must never throw. It renders beside an "Approve & upgrade" button, so a
 *     404 or a network failure has to degrade to a stated `source`, not an error
 *     that reads as "the upgrade is broken".
 *  2. The version reaches an outbound URL, so it must be validated — not
 *     interpolated on trust.
 */
function mockFetchOnce(init: { status: number; body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    json: () => Promise.resolve(init.body ?? {}),
    text: () => Promise.resolve(JSON.stringify(init.body ?? {})),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('getReleaseNotes', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns the release body as notes and reports source=release', async () => {
    mockFetchOnce({ status: 200, body: { body: '## Fixed\n- a thing', html_url: 'https://example.test/r/v2026.9.25' } });
    const res = await getReleaseNotes('2026.9.25');
    expect(res.notes).toContain('Fixed');
    expect(res.source).toBe('release');
    expect(res.url).toBe('https://example.test/r/v2026.9.25');
    expect(res.version).toBe('2026.9.25');
  });

  it('requests the tag endpoint with a leading v', async () => {
    const fn = mockFetchOnce({ status: 200, body: { body: 'x' } });
    await getReleaseNotes('2026.9.25');
    expect(String(fn.mock.calls[0][0])).toContain('/releases/tags/v2026.9.25');
  });

  it('strips a leading v the caller may already have included', async () => {
    const fn = mockFetchOnce({ status: 200, body: { body: 'x' } });
    const res = await getReleaseNotes('v2026.9.25');
    expect(String(fn.mock.calls[0][0])).toContain('/releases/tags/v2026.9.25');
    expect(String(fn.mock.calls[0][0])).not.toContain('vv');
    expect(res.version).toBe('2026.9.25');
  });

  // A development build (`2026.9.24-670a573`) has no release page. That is the
  // normal state on DEV, not a fault.
  it('reports source=none on 404 rather than failing', async () => {
    mockFetchOnce({ status: 404 });
    const res = await getReleaseNotes('2026.9.24-670a573');
    expect(res).toMatchObject({ notes: null, source: 'none', url: null });
  });

  // A release published with an empty body is "nothing to say", which must not
  // be reported as "we could not reach GitHub" — the UI words those differently.
  it('treats an empty release body as none, not as unreachable', async () => {
    mockFetchOnce({ status: 200, body: { body: '   \n  ' } });
    const res = await getReleaseNotes('2026.9.25');
    expect(res.notes).toBeNull();
    expect(res.source).toBe('none');
  });

  it('reports source=unreachable on a rate limit or server error', async () => {
    mockFetchOnce({ status: 403 });
    expect(await getReleaseNotes('2026.9.25')).toMatchObject({ source: 'unreachable', notes: null });
  });

  it('reports source=unreachable when the request throws, and does not rethrow', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')));
    await expect(getReleaseNotes('2026.9.25')).resolves.toMatchObject({ source: 'unreachable' });
  });

  // Defence in depth behind the route's zod check: a malformed version must
  // never be interpolated into the outbound URL.
  it.each([
    '2026.9.25/../../../etc/passwd',
    '../../other/repo/releases/latest',
    'https://evil.test/#',
    '2026.09.1',
    '',
  ])('refuses to fetch anything for a malformed version: %s', async (bad) => {
    const fn = mockFetchOnce({ status: 200, body: { body: 'should never be read' } });
    const res = await getReleaseNotes(bad);
    expect(fn).not.toHaveBeenCalled();
    expect(res).toMatchObject({ notes: null, source: 'none' });
  });

  // ── The signal must be fresh per call ──────────────────────────────────────
  // This is the bug the original tests could not see. `AbortSignal.timeout`
  // starts counting when CREATED, so a module-level options constant is already
  // aborted seconds into process life and every later request throws instantly.
  // A stub that ignores `signal` (as the ones above do) cannot detect that — so
  // these tests inspect the signal the caller actually passed.
  describe('per-request abort signal', () => {
    it('passes a signal that is NOT already aborted', async () => {
      const seen: AbortSignal[] = [];
      vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => {
        seen.push(init.signal as AbortSignal);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ body: 'x' }), text: () => Promise.resolve('') });
      }));
      await getReleaseNotes('2026.9.25');
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeInstanceOf(AbortSignal);
      expect(seen[0].aborted).toBe(false);
    });

    it('builds a NEW signal for each call, so a long-lived process keeps working', async () => {
      const seen: AbortSignal[] = [];
      vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => {
        seen.push(init.signal as AbortSignal);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ body: 'x' }), text: () => Promise.resolve('') });
      }));
      await getReleaseNotes('2026.9.25');
      await getReleaseNotes('2026.9.26');
      expect(seen).toHaveLength(2);
      // Distinct objects: a shared constant would hand back the same one twice,
      // and the second call would inherit the first call's elapsed countdown.
      expect(seen[0]).not.toBe(seen[1]);
      expect(seen.every((sig) => sig.aborted === false)).toBe(true);
    });

    // A stub that HONOURS the signal reproduces the original failure end to end:
    // an aborted signal must surface as `unreachable`, never as a throw.
    it('an aborted signal degrades to unreachable rather than throwing', async () => {
      vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => {
        const sig = init.signal as AbortSignal;
        if (sig.aborted) return Promise.reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ body: 'notes' }), text: () => Promise.resolve('') });
      }));
      // Fresh signal → real answer.
      expect(await getReleaseNotes('2026.9.25')).toMatchObject({ source: 'release' });
    });
  });
});
