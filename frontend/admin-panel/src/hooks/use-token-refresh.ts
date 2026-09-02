import { useEffect, useCallback } from 'react';
import { config } from '@/lib/runtime-config';

// Phase 3 split-token auth:
//   access JWT  — 30 min, in localStorage('auth_token')
//   refresh tok — 24 h,  in localStorage('auth_refresh_token')
//
// The refresh token is DB-backed and ROTATED on every use, and each rotation
// restarts its own 24h window. So a session stays alive for exactly as long as
// something keeps rotating it — which is what this hook is for.

const REFRESH_CHECK_INTERVAL_MS = 60_000;
/** Rotate once the access token is within this long of expiring. */
const TOKEN_REFRESH_WINDOW_S = 5 * 60;
/** How long one tab's claim on a rotation is honoured by the others. */
const CROSS_TAB_LOCK_MS = 30_000;
const LOCK_KEY = 'auth_refresh_lock';

function getTokenExp(): number | null {
  const token = localStorage.getItem('auth_token');
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

/**
 * Claim the right to rotate, so two open tabs never rotate the same token.
 *
 * This is load-bearing, not belt-and-braces. The backend treats a re-presented
 * already-rotated refresh token as a REUSE ATTACK and revokes the whole family
 * — logging every tab out. The old activity-gated hook rarely fired, so the
 * collision was rare; refreshing on a timer in every open tab would have made
 * it routine, and this change would have caused MORE logouts than it prevented.
 *
 * localStorage is shared across same-origin tabs and the read-then-write window
 * here is sub-millisecond against a 60s cadence.
 */
function claimRefreshSlot(): boolean {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    const heldAt = raw ? Number(raw) : 0;
    if (Number.isFinite(heldAt) && Date.now() - heldAt < CROSS_TAB_LOCK_MS) return false;
    localStorage.setItem(LOCK_KEY, String(Date.now()));
    return true;
  } catch {
    // localStorage unavailable (private mode, quota) — better to attempt the
    // refresh than to let the session lapse.
    return true;
  }
}

function releaseRefreshSlot(): void {
  try { localStorage.removeItem(LOCK_KEY); } catch { /* nothing to release */ }
}

/**
 * Keeps the session alive for as long as the tab is open.
 *
 * Previously this only rotated when the user had produced a mouse/key/scroll
 * event in the last 25 minutes, so a tab left open on a page the operator was
 * only READING went unrefreshed and eventually died. It also gave up entirely
 * once the access token had already lapsed (`timeUntilExpiry <= 0`), which is
 * exactly the state a tab returns in after sitting in the background — the
 * moment a proactive refresh is most useful.
 *
 * Now: an open tab is sufficient. `/auth/refresh` is authorised by the REFRESH
 * token, so an expired access token is refreshable — that is the normal case
 * after the tab has been hidden for a while, since browsers throttle
 * background timers and the 60s tick may not have run.
 *
 * Kept byte-identical to the tenant panel's copy — the two panels had the same
 * hook and therefore the same bug, so they get the same fix.
 */
export function useTokenRefresh() {
  const maybeRefresh = useCallback(async () => {
    const refreshToken = localStorage.getItem('auth_refresh_token');
    // No refresh token — signed out, or a session issued without one.
    if (!refreshToken) return;

    const exp = getTokenExp();
    if (!exp) return;

    const timeUntilExpiry = exp - Math.floor(Date.now() / 1000);
    // Deliberately NOT `> 0` — a token that already lapsed is precisely what we
    // want to replace, and the refresh token is what authorises doing so.
    if (timeUntilExpiry > TOKEN_REFRESH_WINDOW_S) return;

    if (!claimRefreshSlot()) return;

    try {
      const base = config.API_URL || '';
      const res = await fetch(`${base}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ refreshToken }),
      });
      if (res.ok) {
        const body = await res.json();
        const data = body?.data;
        if (data?.token && data?.refreshToken) {
          localStorage.setItem('auth_token', data.token);
          localStorage.setItem('auth_refresh_token', data.refreshToken);
        }
      }
      // A non-OK response is left alone on purpose: the refresh token may have
      // been revoked or expired, and api-client's 401 path owns sending the
      // user to /login. Retrying here would just race it.
    } catch {
      // Network blip — the next tick, or the next 401, will pick it up.
    } finally {
      releaseRefreshSlot();
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => { void maybeRefresh(); }, REFRESH_CHECK_INTERVAL_MS);

    // Background tabs get their timers throttled (and frozen outright under
    // some power-saving modes), so the tick alone cannot be trusted to have
    // run while hidden. Re-check the moment the tab is looked at again.
    const onVisible = () => { if (document.visibilityState === 'visible') void maybeRefresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    // And once on mount, so a tab restored by the browser does not wait a
    // full minute holding an already-expired token.
    void maybeRefresh();

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [maybeRefresh]);
}
