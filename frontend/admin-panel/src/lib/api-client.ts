import { config } from './runtime-config';

/**
 * A readable message for an error response that is NOT a platform envelope.
 *
 * `res.statusText` is the obvious fallback and is the wrong one: over HTTP/2 it
 * is ALWAYS the empty string — h2 dropped the reason phrase and browsers expose
 * nothing in its place. Traefik serves h2 by default, so every non-JSON error
 * reached the UI carrying an empty message and rendered as a blank error box
 * with the real status visible only in devtools. Reported against a 403 while
 * adding a DNS server.
 *
 * A non-envelope body means the response came from something in FRONT of the
 * API — the ingress, the WAF, an auth gate — so the text also says so rather
 * than implying the API rejected the request on its merits.
 */
/**
 * A WAF block never reaches the platform API, so there is no error envelope
 * to render — ModSecurity answers with nginx's stock 403 page. Recognising
 * that signature is the only way the panel can tell the operator what
 * actually happened; without it the most common trigger (an endpoint URL
 * containing an IP literal, CRS rule 931100) surfaces as a bare "403".
 */
const NGINX_ERROR_PAGE = /<center>\s*nginx[^<]*<\/center>|<title>\s*40\d[^<]*<\/title>/i;

export function isWafBlock(status: number, bodyText: string): boolean {
  return status === 403 && NGINX_ERROR_PAGE.test(bodyText);
}

function nonEnvelopeMessage(status: number, statusText: string, bodyText: string): string {
  if (isWafBlock(status, bodyText)) {
    return 'Blocked by the Web Application Firewall. The request never reached the platform API — a security rule matched its contents. An endpoint URL written as an IP address is the most common cause. Open Security → WAF Events to see which rule fired and whitelist it if it is a false positive.';
  }
  const phrase = statusText.trim() || HTTP_PHRASE[status] || 'Request failed';
  const detail = bodyText.trim().slice(0, 200);
  const origin =
    status === 403
      ? ' The response did not come from the platform API — an ingress rule, the WAF, or an expired session gate is the usual cause.'
      : status === 502 || status === 503 || status === 504
        ? ' The platform API may be restarting or unreachable.'
        : '';
  return `HTTP ${status} ${phrase}.${origin}${detail ? ` Response: ${detail}` : ''}`;
}

const HTTP_PHRASE: Readonly<Record<number, string>> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  409: 'Conflict', 413: 'Payload Too Large', 422: 'Unprocessable Entity',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
};

export const API_BASE = config.API_URL;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /**
     * The `error.details` payload from the API response envelope. The
     * platform's error-handler middleware embeds an `operatorError`
     * field here for any error it could translate (k8s API failures,
     * intentional preflight rejects). Consumed by `extractOperatorError`
     * to render `<ErrorPanel>` with the full title/detail/remediation
     * envelope rather than a stringified `error.message`.
     */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Phase 3 split-token auth: when the access JWT expires (30 min), the
// API returns 401 INVALID_TOKEN. We silently POST /auth/refresh with
// the long-lived refresh token, store the rotated pair, and replay the
// original request. If the refresh itself fails, we fall back to the
// "Access Token Expired" overlay + redirect to /login.
//
// All concurrent 401s coalesce onto a single in-flight refresh promise
// so we don't issue N parallel /auth/refresh calls (which would also
// trip the rotation reuse-detection heuristic on the backend).
let refreshInFlight: Promise<RefreshOutcome> | null = null;

/**
 * Outcome of a refresh attempt. A boolean is not enough: "the server said
 * no" and "the server could not answer" have opposite correct responses.
 *
 *   refreshed   — new tokens stored, retry the original request.
 *   rejected    — the refresh token is genuinely no good. End the session.
 *   unavailable — throttled (429), 5xx, or the request never completed.
 *                 Says NOTHING about the token; keep the session and let
 *                 the caller surface the original error.
 *
 * Returning false for `unavailable` is what logged operators out during a
 * rate-limit burst on DEV while their refresh token was fine.
 */
type RefreshOutcome = 'refreshed' | 'rejected' | 'unavailable';

async function attemptRefresh(): Promise<RefreshOutcome> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async (): Promise<RefreshOutcome> => {
    const refreshToken = localStorage.getItem('auth_refresh_token');
    if (!refreshToken) return 'rejected';

    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        // 401/403 = this token will never work again. Anything else —
        // notably 429, since /auth/refresh shares the global rate-limit
        // bucket — is transient and must not cost the user their session.
        return (res.status === 401 || res.status === 403) ? 'rejected' : 'unavailable';
      }
      const body = await res.json();
      const data = body?.data;
      if (!data?.token || !data?.refreshToken) return 'rejected';
      localStorage.setItem('auth_token', data.token);
      localStorage.setItem('auth_refresh_token', data.refreshToken);
      if (data.user) localStorage.setItem('auth_user', JSON.stringify(data.user));
      return 'refreshed';
    } catch {
      // Never reached the server at all.
      return 'unavailable';
    }
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  return apiFetchWithRetry<T>(path, options, true);
}

async function apiFetchWithRetry<T>(
  path: string,
  options: RequestInit,
  allowRetry: boolean,
): Promise<T> {
  const token = localStorage.getItem('auth_token');

  const headers: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  // Only set Content-Type for requests with a body
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  // Default `credentials: 'same-origin'` is correct here — the admin
  // panel and its /api/v1/* proxy both live on admin.<apex>, so cookies
  // flow without `include`. State-changing routes use Bearer-only auth
  // server-side regardless, so cookie handling is orthogonal.
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  });

  if (!res.ok) {
    // Read the body ONCE as text, then try to parse it. Calling res.json()
    // and later res.text() would throw "body stream already read", so the raw
    // text has to be captured up front to be usable in the fallback message.
    const rawBody = await res.text().catch(() => '');
    let body: { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      body = {
        error: {
          code: isWafBlock(res.status, rawBody) ? 'WAF_REQUEST_BLOCKED' : 'UNKNOWN',
          message: nonEnvelopeMessage(res.status, res.statusText, rawBody),
        },
      };
    }
    const code = body.error?.code ?? 'UNKNOWN';

    // Phase 3: silent refresh on access-token expiry. Skip for the
    // login + refresh endpoints themselves to avoid recursion.
    const isAuthEndpoint = path.includes('/auth/login') || path.includes('/auth/refresh');
    if (
      res.status === 401
      && code === 'INVALID_TOKEN'
      && !isAuthEndpoint
      && allowRetry
    ) {
      const outcome = await attemptRefresh();
      if (outcome === 'refreshed') {
        // Retry once with the new access token.
        return apiFetchWithRetry<T>(path, options, false);
      }
      if (outcome === 'rejected') {
        // The refresh token is genuinely dead — this IS a session end.
        showTokenExpiredAndRedirect();
      }
      // 'unavailable' — the server could not answer. Keep the session and let
      // the original error reach the caller, so the UI can say "rate limited"
      // or "service unavailable" instead of silently signing the user out.
    } else if (res.status === 401 && code === 'INVALID_TOKEN' && !isAuthEndpoint) {
      showTokenExpiredAndRedirect();
    }

    throw new ApiError(
      res.status,
      code,
      body.error?.message || nonEnvelopeMessage(res.status, res.statusText, rawBody),
      body.error?.details,
    );
  }

  if (res.status === 204) return undefined as T;

  return res.json();
}

let tokenExpiredShown = false;

function showTokenExpiredAndRedirect(): void {
  if (tokenExpiredShown) return;
  tokenExpiredShown = true;

  // Clear auth state
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_refresh_token');
  localStorage.removeItem('auth_user');

  // Show full-screen overlay
  const overlay = document.createElement('div');
  overlay.id = 'token-expired-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7)';
  overlay.innerHTML = `
    <div style="background:white;border-radius:16px;padding:48px;text-align:center;max-width:400px;box-shadow:0 25px 50px rgba(0,0,0,0.25)">
      <div style="font-size:48px;margin-bottom:16px">🔒</div>
      <h2 style="font-size:20px;font-weight:700;color:#111;margin:0 0 8px">Session Expired</h2>
      <p style="font-size:14px;color:#666;margin:0">Redirecting to login...</p>
    </div>
  `;
  document.body.appendChild(overlay);

  setTimeout(() => {
    window.location.href = '/login';
  }, 2000);
}
