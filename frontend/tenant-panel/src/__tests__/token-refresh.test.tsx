import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTokenRefresh } from '@/hooks/use-token-refresh';

vi.mock('@/lib/runtime-config', () => ({ config: { API_URL: '' } }));

// WHY THIS EXISTS: the session used to be kept alive by MOUSE/KEY activity —
// `if (Date.now() - lastActivity > 25min) return`. A tab left open on a page
// the operator was only reading produced no events, so nothing rotated the
// refresh token and the session eventually lapsed. The hook also bailed out
// once the access token had already expired (`timeUntilExpiry <= 0`), which is
// exactly the state a tab comes back in after sitting in the background.

/** A JWT-shaped token whose `exp` is `secondsFromNow` away. */
function tokenExpiringIn(secondsFromNow: number): string {
  const payload = { exp: Math.floor(Date.now() / 1000) + secondsFromNow, sub: 'u1' };
  return `h.${btoa(JSON.stringify(payload))}.s`;
}

function okRefresh() {
  return Promise.resolve({
    ok: true,
    json: async () => ({ data: { token: tokenExpiringIn(1800), refreshToken: 'rt-new' } }),
  } as Response);
}

const REFRESH_URL = '/api/v1/auth/refresh';
const fetchMock = vi.fn();

describe('useTokenRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    fetchMock.mockReset().mockImplementation(okRefresh);
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const refreshCalls = () => fetchMock.mock.calls.filter(c => String(c[0]).includes(REFRESH_URL));

  it('rotates a near-expiry token with NO user activity at all', async () => {
    localStorage.setItem('auth_token', tokenExpiringIn(60));
    localStorage.setItem('auth_refresh_token', 'rt-old');

    renderHook(() => useTokenRefresh());

    // No mousedown/keydown/scroll is ever dispatched — an open tab is enough.
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    await waitFor(() => expect(localStorage.getItem('auth_refresh_token')).toBe('rt-new'));
  });

  it('rotates a token that has ALREADY expired', async () => {
    // The old hook returned early here, so a tab coming back from the
    // background could not self-heal and had to wait for a request to 401.
    localStorage.setItem('auth_token', tokenExpiringIn(-120));
    localStorage.setItem('auth_refresh_token', 'rt-old');

    renderHook(() => useTokenRefresh());
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
  });

  it('leaves a comfortably fresh token alone', async () => {
    localStorage.setItem('auth_token', tokenExpiringIn(29 * 60));
    localStorage.setItem('auth_refresh_token', 'rt-old');

    renderHook(() => useTokenRefresh());
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(refreshCalls()).toHaveLength(0);
  });

  it('does nothing for an impersonated session (access token, no refresh token)', async () => {
    // POST /admin/impersonate mints a 1h access token and NO refresh token.
    // There is nothing to rotate; the 1h cap is the intended behaviour.
    localStorage.setItem('auth_token', tokenExpiringIn(30));
    localStorage.removeItem('auth_refresh_token');

    renderHook(() => useTokenRefresh());
    await act(async () => { vi.advanceTimersByTime(180_000); });
    expect(refreshCalls()).toHaveLength(0);
  });

  it('re-checks the moment the tab becomes visible again', async () => {
    localStorage.setItem('auth_token', tokenExpiringIn(29 * 60));
    localStorage.setItem('auth_refresh_token', 'rt-old');
    renderHook(() => useTokenRefresh());
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(refreshCalls()).toHaveLength(0);

    // Simulate time passing while hidden with the timer throttled: the token
    // lapses and no tick runs. Coming back must not wait a full minute.
    localStorage.setItem('auth_token', tokenExpiringIn(-30));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
  });

  it('a second tab does not rotate concurrently — the backend treats that as token reuse', async () => {
    localStorage.setItem('auth_token', tokenExpiringIn(60));
    localStorage.setItem('auth_refresh_token', 'rt-old');

    // Two tabs of the same origin share localStorage, so the lock is shared.
    renderHook(() => useTokenRefresh());
    renderHook(() => useTokenRefresh());

    await act(async () => { vi.advanceTimersByTime(500); });
    // Re-presenting an already-rotated refresh token revokes the whole family
    // and signs every tab out — so exactly one rotation may go out.
    expect(refreshCalls()).toHaveLength(1);
  });

  it('releases the cross-tab lock so a later rotation is not blocked forever', async () => {
    localStorage.setItem('auth_token', tokenExpiringIn(60));
    localStorage.setItem('auth_refresh_token', 'rt-old');

    renderHook(() => useTokenRefresh());
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    await waitFor(() => expect(localStorage.getItem('auth_refresh_lock')).toBeNull());
  });

  it('keeps the session on a failed refresh rather than clearing tokens', async () => {
    // api-client's 401 path owns sending the user to /login; racing it here
    // would sign people out on a transient blip.
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, json: async () => ({}) } as Response));
    localStorage.setItem('auth_token', tokenExpiringIn(30));
    localStorage.setItem('auth_refresh_token', 'rt-old');

    renderHook(() => useTokenRefresh());
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    expect(localStorage.getItem('auth_refresh_token')).toBe('rt-old');
    expect(localStorage.getItem('auth_token')).not.toBeNull();
  });
});
