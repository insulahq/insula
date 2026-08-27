import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api-client';

/**
 * Login-page readiness probe.
 *
 * The login page has always fetched `/auth/oidc/status` on mount — it needs
 * the provider list to decide what to render. What it did with a FAILURE was
 * the bug: it caught everything and fell back to
 * `{ localAuthEnabled: true, providers: [] }`, i.e. it rendered a working-
 * looking password form whenever the API was unreachable.
 *
 * Two things go wrong with that:
 *
 *   1. After a node reboot the panels are Ready ~2m20s before platform-api is
 *      (measured on production 2026-08-27: admin-panel 10:21:40, platform-api
 *      10:24:01). For that whole window an operator sees a normal login form
 *      and only discovers it is dead by typing credentials into it.
 *   2. On an OIDC-only cluster the fallback is actively WRONG — `providers:
 *      []` hides every SSO button and suppresses the auto-redirect, so the
 *      page shows a local password form that can never succeed, and keeps
 *      showing it after the API recovers until someone reloads.
 *
 * So this hook distinguishes "the API answered" from "the API is not there",
 * and re-probes with capped exponential backoff while it is not there. It adds
 * NO new request to the healthy path: the call already happened, we just stop
 * throwing its failure away.
 */

export interface AuthStatus {
  readonly localAuthEnabled: boolean;
  readonly proxyProtectionEnabled?: boolean;
  readonly providers: readonly { id: string; displayName: string }[];
}

export type AuthStatusState =
  /** First probe in flight. Callers render the form exactly as before — a
   *  healthy API answers in milliseconds and a spinner would only flash. */
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly status: AuthStatus }
  | { readonly kind: 'unreachable'; readonly attempts: number; readonly since: number };

/**
 * What the page falls back to when the API answered with something we cannot
 * interpret. Deliberately permissive: our own gate must never be the reason an
 * operator cannot reach the login form.
 */
const PERMISSIVE_FALLBACK: AuthStatus = { localAuthEnabled: true, providers: [] };

export const AUTH_STATUS_RETRY_BASE_MS = 1_000;
export const AUTH_STATUS_RETRY_MAX_MS = 10_000;

/**
 * True when the failure means "nothing answered on the other end".
 *
 * 502/504 are the edge (nginx/Traefik) reporting no upstream; 503 is the
 * upstream itself saying it cannot serve yet. A non-ApiError is the raw
 * TypeError `fetch()` throws for DNS/connect failures.
 *
 * Everything else — including 4xx and 500 — means the API DID answer, so we
 * hand back the permissive fallback rather than gating the operator out.
 */
export function isApiUnreachable(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status === 502 || err.status === 503 || err.status === 504;
  }
  return true;
}

/**
 * Capped exponential backoff with jitter over the upper half of the window.
 * Across the ~2m20s cold-start window this is ~18 requests from one tab, and
 * it stops on the first success — materially less than an operator retrying
 * the Sign In button by hand.
 */
export function authStatusRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(
    AUTH_STATUS_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
    AUTH_STATUS_RETRY_MAX_MS,
  );
  return Math.round(exp * (0.5 + 0.5 * random()));
}

export interface UseAuthStatusResult {
  readonly state: AuthStatusState;
  /** Probe immediately, cancelling any pending backoff timer. */
  readonly retryNow: () => void;
}

export function useAuthStatus(panel: 'admin' | 'tenant'): UseAuthStatusResult {
  const [state, setState] = useState<AuthStatusState>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const attemptsRef = useRef(0);
  const sinceRef = useRef(Date.now());

  const retryNow = useCallback(() => { setNonce((n) => n + 1); }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const probe = async (): Promise<void> => {
      try {
        const res = await apiFetch<{ data: AuthStatus }>(
          `/api/v1/auth/oidc/status?panel=${panel}`,
        );
        if (cancelled) return;
        attemptsRef.current = 0;
        setState({ kind: 'ready', status: res.data });
      } catch (err) {
        if (cancelled) return;
        if (!isApiUnreachable(err)) {
          setState({ kind: 'ready', status: PERMISSIVE_FALLBACK });
          return;
        }
        attemptsRef.current += 1;
        setState({
          kind: 'unreachable',
          attempts: attemptsRef.current,
          since: sinceRef.current,
        });
        timer = setTimeout(() => { void probe(); }, authStatusRetryDelayMs(attemptsRef.current));
      }
    };

    void probe();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [panel, nonce]);

  return { state, retryNow };
}
