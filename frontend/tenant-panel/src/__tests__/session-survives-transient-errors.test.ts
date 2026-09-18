import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAuth } from '../hooks/use-auth';

/**
 * `showTokenExpiredAndRedirect()` guards itself with a MODULE-level
 * `tokenExpiredShown` flag so the overlay can only ever appear once per page
 * load. That is correct in production and poison across tests: the first test
 * to legitimately trigger it would make every later one unable to. Each test
 * therefore imports a fresh copy of the module.
 */
async function freshClient() {
  vi.resetModules();
  return import('../lib/api-client');
}

/**
 * A transient API failure must not end the operator's session.
 *
 * Observed on DEV: a burst of traffic tripped the 100 req/min
 * per-user rate limit, and the panel bounced to the sign-in page holding a
 * perfectly valid, unexpired token. Two independent code paths did it:
 *
 *   1. `useAuth.initialize()` calls /auth/me on every ProtectedRoute mount
 *      and its `.catch()` cleared localStorage for ANY rejection. The comment
 *      there said "Token invalid" — but a 429, a 502, a WAF block and a
 *      dropped connection all land in the same catch.
 *
 *   2. `attemptRefresh()` returned false for any non-ok response, and a
 *      `false` is read as "the refresh token is no good" → session-expired
 *      overlay. A 429 on /auth/refresh is not evidence of that.
 *
 * Only a 401 is evidence that a token is bad. Everything else is evidence
 * that the network or the server is having a moment.
 */

const OK_USER = { id: 'u1', email: 'a@example.test', fullName: 'A', role: 'tenant_admin' };

function seedSession() {
  localStorage.setItem('auth_token', 'valid-token');
  localStorage.setItem('auth_refresh_token', 'valid-refresh');
  localStorage.setItem('auth_user', JSON.stringify(OK_USER));
}

/** A fetch Response stub carrying a platform error envelope. */
function errorResponse(status: number, code: string) {
  return {
    ok: false,
    status,
    statusText: '',
    text: () => Promise.resolve(JSON.stringify({ error: { code, message: `${code} happened`, status } })),
  };
}

function okResponse(body: unknown) {
  // This panel reads Content-Length and then text() rather than json(), so a
  // json-only stub fails inside apiFetch rather than in the assertion.
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  };
}

/** Wait for initialize()'s un-awaited /auth/me promise chain to settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  useAuth.setState({ token: null, user: null, isAuthenticated: false, isLoading: true });
  document.getElementById('token-expired-overlay')?.remove();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('initialize(): which /auth/me failures end the session', () => {
  it.each([
    [429, 'RATE_LIMIT_EXCEEDED'],
    [500, 'INTERNAL_SERVER_ERROR'],
    [502, 'UNKNOWN'],
    [503, 'UNKNOWN'],
  ])('keeps the session when /auth/me returns %i', async (status, code) => {
    seedSession();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(status, code)));

    useAuth.getState().initialize();
    await flush();

    // The cached user is still good; the next navigation will retry.
    // The refresh token matters even more here: this panel's catch used to
    // drop it too, so a transient blip left the user with no way back.
    expect(localStorage.getItem('auth_token')).toBe('valid-token');
    expect(localStorage.getItem('auth_refresh_token')).toBe('valid-refresh');
    expect(useAuth.getState().isAuthenticated).toBe(true);
  });

  it('keeps the session when /auth/me cannot be reached at all', async () => {
    // A dropped connection is the least likely of all failures to mean
    // "your credentials are bad".
    seedSession();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    useAuth.getState().initialize();
    await flush();

    expect(localStorage.getItem('auth_token')).toBe('valid-token');
    expect(useAuth.getState().isAuthenticated).toBe(true);
  });

  it('DOES end the session when /auth/me returns 401', async () => {
    // The one unambiguous signal. Guard against over-correcting the fix into
    // "never log out".
    seedSession();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401, 'INVALID_TOKEN')));

    useAuth.getState().initialize();
    await flush();
    await flush();

    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(useAuth.getState().isAuthenticated).toBe(false);
  });

  it('refreshes the cached user on success', async () => {
    seedSession();
    const fresh = { ...OK_USER, fullName: 'Renamed' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ data: fresh })));

    useAuth.getState().initialize();
    await flush();

    expect(useAuth.getState().user?.fullName).toBe('Renamed');
    expect(JSON.parse(localStorage.getItem('auth_user') ?? '{}').fullName).toBe('Renamed');
  });
});

describe('attemptRefresh(): which refresh failures end the session', () => {
  it('does not show the expired overlay when the refresh is rate-limited', async () => {
    const { apiFetch, ApiError } = await freshClient();
    seedSession();
    const fetchMock = vi.fn()
      // The original request: access token expired.
      .mockResolvedValueOnce(errorResponse(401, 'INVALID_TOKEN'))
      // The refresh attempt: throttled, NOT rejected.
      .mockResolvedValueOnce(errorResponse(429, 'RATE_LIMIT_EXCEEDED'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/api/v1/domains')).rejects.toBeInstanceOf(ApiError);

    // The session must survive: a throttled refresh says nothing about
    // whether the refresh token is still good. Asserted on the tokens rather
    // than the overlay element — this panel's overlay has no id to query.
    expect(localStorage.getItem('auth_token')).toBe('valid-token');
    expect(localStorage.getItem('auth_refresh_token')).toBe('valid-refresh');
  });

  it('does not show the expired overlay when the refresh 5xxs', async () => {
    const { apiFetch, ApiError } = await freshClient();
    seedSession();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(errorResponse(401, 'INVALID_TOKEN'))
      .mockResolvedValueOnce(errorResponse(503, 'UNKNOWN')));

    await expect(apiFetch('/api/v1/domains')).rejects.toBeInstanceOf(ApiError);

    expect(localStorage.getItem('auth_token')).toBe('valid-token');
    expect(localStorage.getItem('auth_refresh_token')).toBe('valid-refresh');
  });

  it('DOES end the session when the refresh token is genuinely rejected', async () => {
    const { apiFetch, ApiError } = await freshClient();
    seedSession();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(errorResponse(401, 'INVALID_TOKEN'))
      .mockResolvedValueOnce(errorResponse(401, 'INVALID_REFRESH_TOKEN')));

    await expect(apiFetch('/api/v1/domains')).rejects.toBeInstanceOf(ApiError);

    // showTokenExpiredAndRedirect() clears the stored session; that is the
    // observable effect in this panel.
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('auth_refresh_token')).toBeNull();
  });

  it('retries the original request after a successful refresh', async () => {
    const { apiFetch } = await freshClient();
    seedSession();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(401, 'INVALID_TOKEN'))
      .mockResolvedValueOnce(okResponse({ data: { token: 'new-token', refreshToken: 'new-refresh' } }))
      .mockResolvedValueOnce(okResponse({ data: 'retried' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/api/v1/domains')).resolves.toEqual({ data: 'retried' });
    expect(localStorage.getItem('auth_token')).toBe('new-token');
  });

  it('surfaces the rate-limit error to the caller instead of swallowing it', async () => {
    // The caller should be able to tell the user "you are being throttled",
    // which means the ORIGINAL error has to reach them.
    const { apiFetch, ApiError } = await freshClient();
    seedSession();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(errorResponse(401, 'INVALID_TOKEN'))
      .mockResolvedValueOnce(errorResponse(429, 'RATE_LIMIT_EXCEEDED')));

    const err = await apiFetch('/api/v1/domains').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as { status?: number }).status).toBe(401);
  });
});
