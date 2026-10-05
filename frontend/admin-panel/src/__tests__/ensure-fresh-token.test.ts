import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A background tenant recovery keeps using the token it was STARTED with —
 * the server forwards it into its provision and restore sub-requests for
 * minutes after the start request returned. Refresh-on-401 cannot help there
 * (the browser's request succeeded), so a token about to expire would fail the
 * run half-way with nobody watching. `ensureFreshAccessToken` refreshes first.
 */

function jwtWithExp(expSec: number): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u1', exp: expSec })}.sig`;
}

function okRefresh() {
  return {
    ok: true, status: 200, statusText: 'OK',
    json: () => Promise.resolve({ data: { token: 'new-access', refreshToken: 'new-refresh' } }),
  };
}

async function freshClient() {
  vi.resetModules();
  return import('../lib/api-client');
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('auth_refresh_token', 'refresh-1');
});
afterEach(() => vi.unstubAllGlobals());

describe('ensureFreshAccessToken', () => {
  it('refreshes a token that would expire within the window', async () => {
    localStorage.setItem('auth_token', jwtWithExp(Math.floor(Date.now() / 1000) + 5 * 60));
    const fetchMock = vi.fn().mockResolvedValue(okRefresh());
    vi.stubGlobal('fetch', fetchMock);
    const { ensureFreshAccessToken } = await freshClient();
    await ensureFreshAccessToken(20 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/v1/auth/refresh');
    expect(localStorage.getItem('auth_token')).toBe('new-access');
  });

  it('leaves a token with enough life alone', async () => {
    const token = jwtWithExp(Math.floor(Date.now() / 1000) + 29 * 60);
    localStorage.setItem('auth_token', token);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { ensureFreshAccessToken } = await freshClient();
    await ensureFreshAccessToken(20 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('auth_token')).toBe(token);
  });

  it('does nothing with a token it cannot read, or none', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { ensureFreshAccessToken } = await freshClient();
    await ensureFreshAccessToken(20 * 60_000);
    localStorage.setItem('auth_token', 'not-a-jwt');
    await ensureFreshAccessToken(20 * 60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
