import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiFetch, ApiError } from '../lib/api-client';

describe('apiFetch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('adds Authorization header when token exists', async () => {
    localStorage.setItem('auth_token', 'test-token');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: 'ok' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await apiFetch('/api/test');

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer test-token');
  });

  it('does not add Authorization header when no token', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: 'ok' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await apiFetch('/api/test');

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers.Authorization).toBeUndefined();
  });

  it('throws ApiError on non-ok response', async () => {
    // A real Response always exposes text() as well as json(); the error path
    // reads the body as text once and parses it, so the mock needs both.
    const envelope = JSON.stringify({
      error: { code: 'MISSING_BEARER_TOKEN', message: 'Missing auth token' },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: '',
      json: () => Promise.resolve(JSON.parse(envelope)),
      text: () => Promise.resolve(envelope),
    }));

    await expect(apiFetch('/api/test')).rejects.toThrow(ApiError);
    await expect(apiFetch('/api/test')).rejects.toMatchObject({
      status: 401,
      code: 'MISSING_BEARER_TOKEN',
    });
  });

  /**
   * Over HTTP/2 `res.statusText` is ALWAYS '' — h2 removed the reason phrase and
   * browsers expose nothing in its place. Traefik serves h2, so using statusText
   * as the fallback meant every non-envelope error reached the operator as a
   * blank message with the real status visible only in devtools. Reported as
   * "empty error message, Chrome shows 403" while adding a DNS server.
   */
  it('gives a readable message when a 403 has no platform envelope (HTTP/2)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: '',                       // h2: always empty
      json: () => Promise.reject(new Error('not json')),
      text: () => Promise.resolve('<html>403 Forbidden</html>'),
    }));

    await expect(apiFetch('/api/test')).rejects.toMatchObject({ status: 403 });
    const err = (await apiFetch('/api/test').catch((e: unknown) => e)) as ApiError;
    expect(err.message).toContain('403');
    expect(err.message).toContain('Forbidden');
    // Says the response did not come from the API, so the operator looks at the
    // ingress / WAF / session rather than at their input.
    expect(err.message).toMatch(/ingress|WAF|session/i);
    expect(err.message.trim()).not.toBe('');
  });

  it('still prefers the platform envelope message when there is one', async () => {
    const envelope = JSON.stringify({ error: { code: 'DNS_CONNECTION_FAILED', message: 'Cannot connect to DNS server: timeout' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: '',
      json: () => Promise.resolve(JSON.parse(envelope)),
      text: () => Promise.resolve(envelope),
    }));

    const err = (await apiFetch('/api/test').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('DNS_CONNECTION_FAILED');
    expect(err.message).toBe('Cannot connect to DNS server: timeout');
  });

  it('never surfaces an empty message, even with an empty body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: '',
      json: () => Promise.reject(new Error('not json')),
      text: () => Promise.resolve(''),
    }));

    const err = (await apiFetch('/api/test').catch((e: unknown) => e)) as ApiError;
    expect(err.message.trim()).not.toBe('');
    expect(err.message).toContain('502');
  });

  it('returns undefined for 204 responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
    }));

    const result = await apiFetch('/api/test');
    expect(result).toBeUndefined();
  });

  it('parses JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { id: '123', name: 'Test' } }),
    }));

    const result = await apiFetch<{ data: { id: string; name: string } }>('/api/test');
    expect(result.data.id).toBe('123');
    expect(result.data.name).toBe('Test');
  });
});
