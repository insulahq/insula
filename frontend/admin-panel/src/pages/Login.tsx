import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { Loader2, Shield, KeyRound, Fingerprint } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { usePasskey } from '@/hooks/use-passkey';
import { useAuthStatus } from '@/hooks/use-auth-status';
import ApiUnavailable from '@/components/ApiUnavailable';
import { apiFetch, API_BASE, ApiError } from '@/lib/api-client';
import { sanitizeRedirect } from '@/lib/sanitize-redirect';

// Apex is the admin panel's hostname with its first label stripped.
// admin.staging.example.test  → staging.example.test
// admin.k8s-platform.test         → k8s-platform.test
// Used to allow-list cross-subdomain redirects coming in via ?rd=.
function getPlatformApex(): string {
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  const parts = host.split('.');
  return parts.length > 1 ? parts.slice(1).join('.') : host;
}

// Route to `target` appropriately:
//   - Same-origin absolute URL → react-router navigate (keeps SPA state)
//   - Cross-subdomain absolute URL → window.location.href (browser nav
//     so the browser sends platform_session to the other subdomain)
//   - Relative path → react-router navigate
function goToTarget(target: string, navigate: (to: string, opts?: { replace?: boolean }) => void): void {
  if (target.startsWith('/')) {
    navigate(target, { replace: true });
    return;
  }
  try {
    const url = new URL(target);
    if (typeof window !== 'undefined' && url.origin === window.location.origin) {
      navigate(url.pathname + url.search + url.hash, { replace: true });
      return;
    }
    if (typeof window !== 'undefined') {
      window.location.href = target;
      return;
    }
  } catch {
    /* fall through */
  }
  navigate('/', { replace: true });
}

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [breakGlassSecret, setBreakGlassSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // The provider list AND the API-reachability signal come from one request —
  // see use-auth-status.ts. `null` while loading keeps the pre-gate rendering
  // (local form, no SSO buttons) byte-identical to what it always was.
  const { state: authState, retryNow } = useAuthStatus('admin');
  const authStatus = authState.kind === 'ready' ? authState.status : null;

  const { login, error, setTokenAndUser, token: existingToken, passkeyChallenge, clearPasskeyChallenge } = useAuth();
  const passkey = usePasskey();
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // Post-login destination. Priority:
  //   1. ?rd= query param (set by nginx auth-signin on gated subdomains
  //      like longhorn.<apex>) — sanitised against the apex allow-list
  //   2. Router state.from (React Router's internal mechanism when an
  //      authenticated route bounced the user here)
  //   3. "/" fallback
  // rd= takes priority because it's the caller that triggered the login
  // flow — state.from is often empty when the Login route is hit directly.
  const routerFrom = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/';
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const apex = getPlatformApex();
  const redirectTarget = sanitizeRedirect(searchParams.get('rd'), origin, apex, routerFrom);
  const isEmergency = searchParams.get('emergency') === 'true';

  useEffect(() => {
    const token = searchParams.get('token');
    const userJson = searchParams.get('user');
    if (token && userJson) {
      try {
        const user = JSON.parse(decodeURIComponent(userJson));
        setTokenAndUser(token, user);
        goToTarget(redirectTarget, navigate);
      } catch { /* ignore */ }
    }
  }, [searchParams, navigate, setTokenAndUser, redirectTarget]);

  // NO auto-redirect to the IdP, even when there is exactly one provider and
  // local auth is off. The visitor always clicks "Sign in with …" first.
  //
  // Auto-forwarding used to fire on a 500ms timer. It made the login page an
  // unusable dead end in the cases that matter most: a visitor who has just
  // signed OUT is bounced straight back into the IdP (which still holds its own
  // session) and cannot reach the page to switch accounts; anyone hitting an
  // IdP error lands back on /login and is immediately thrown at the same broken
  // provider again; and ?error= messages from the callback were invisible
  // because the redirect fired before they could be read. A single click costs
  // nothing and keeps the page reachable.

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setPasskeyError(null);
    try {
      await login(email, password);
      // If 2FA was required, the auth store now holds passkeyChallenge
      // and the UI re-renders into the passkey-verify view. Don't
      // navigate yet.
      if (!useAuth.getState().passkeyChallenge) {
        goToTarget(redirectTarget, navigate);
      }
    } catch { /* error in store */ } finally { setSubmitting(false); }
  };

  /** "Sign in with passkey" — userless flow. No email field needed. */
  const handlePasskeyLogin = async () => {
    setSubmitting(true);
    setPasskeyError(null);
    try {
      const result = await passkey.loginUserless();
      setTokenAndUser(result.token, result.user);
      // Browser navigation pattern: setTokenAndUser doesn't store the
      // refresh token (it expects setTokenAndUser callers from OIDC).
      // Stash it manually so the silent refresh keeps working.
      localStorage.setItem('auth_refresh_token', result.refreshToken);
      goToTarget(redirectTarget, navigate);
    } catch (err) {
      // DOM exception (user cancelled the prompt) → reset cleanly.
      const msg = err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? (err.name === 'NotAllowedError' || err.name === 'AbortError'
            ? 'Passkey login cancelled. Try again or use email + password.'
            : err.message)
          : 'Passkey login failed.';
      setPasskeyError(msg);
    } finally { setSubmitting(false); }
  };

  /** 2FA step 2: prompt the user for their passkey to finish login. */
  const handle2FA = async () => {
    if (!passkeyChallenge) return;
    setSubmitting(true);
    setPasskeyError(null);
    try {
      const result = await passkey.complete2FA(passkeyChallenge.preAuthToken);
      setTokenAndUser(result.token, result.user);
      localStorage.setItem('auth_refresh_token', result.refreshToken);
      goToTarget(redirectTarget, navigate);
    } catch (err) {
      const msg = err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? (err.name === 'NotAllowedError' || err.name === 'AbortError'
            ? 'Passkey verification cancelled.'
            : err.message)
          : '2FA verification failed.';
      setPasskeyError(msg);
    } finally { setSubmitting(false); }
  };

  const handleBreakGlass = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await apiFetch<{ data: { token: string; user: { id: string; email: string; fullName: string; role: string } } }>('/api/v1/auth/break-glass', {
        method: 'POST',
        body: JSON.stringify({ email, password, break_glass_secret: breakGlassSecret }),
      });
      setTokenAndUser(res.data.token, res.data.user);
      goToTarget(redirectTarget, navigate);
    } catch { /* error shown */ } finally { setSubmitting(false); }
  };

  const handleSso = (providerId: string) => {
    const callbackUrl = `${window.location.origin}/login`;
    window.location.href = `${API_BASE}/api/v1/auth/oidc/authorize/${providerId}?redirect_uri=${encodeURIComponent(callbackUrl)}`;
  };

  const showLocalAuth = authStatus?.localAuthEnabled ?? true;
  const providers = authStatus?.providers ?? [];
  const oidcError = searchParams.get('error');
  const oidcMessage = searchParams.get('message');

  // API-readiness gate. Deliberately placed AFTER every hook — in particular
  // after the effect that consumes `?token=&user=` — so the OIDC callback leg
  // still completes while the API is flapping. That leg needs no authStatus.
  //
  // Break-glass (?emergency=true) bypasses the gate entirely: an emergency
  // admin login is the last place an operator should be told to wait for a
  // spinner, and it posts to a different endpoint anyway.
  if (authState.kind === 'unreachable' && !isEmergency) {
    return (
      <ApiUnavailable
        attempts={authState.attempts}
        since={authState.since}
        onRetry={retryNow}
        panelLabel="admin panel"
      />
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-linear-to-br from-brand-500 to-accent-500 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-800 p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center">
          <img src="/insula-mark.svg" alt="Insula" className="h-14 w-14" />
          <h1 className="mt-4 text-xl font-bold text-gray-900 dark:text-gray-100">Insula</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{isEmergency ? 'Emergency Admin Login' : 'Sign in to admin panel'}</p>
        </div>

        {(error || oidcError) && (
          <div className="mb-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300" data-testid="login-error">
            {error ?? (oidcMessage ? decodeURIComponent(oidcMessage) : 'Authentication failed. Please contact your administrator.')}
          </div>
        )}

        {isEmergency ? (
          <form onSubmit={handleBreakGlass} className="space-y-4" data-testid="break-glass-form">
            <div><label htmlFor="bg-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Email</label><input id="bg-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm" data-testid="email-input" /></div>
            <div><label htmlFor="bg-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Password</label><input id="bg-password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm" data-testid="password-input" /></div>
            <div><label htmlFor="bg-secret" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Emergency Secret</label><input id="bg-secret" type="password" required value={breakGlassSecret} onChange={(e) => setBreakGlassSecret(e.target.value)} className="mt-1 w-full rounded-lg border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-sm" data-testid="break-glass-secret-input" /></div>
            <button type="submit" disabled={submitting} className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50" data-testid="break-glass-button">
              {submitting && <Loader2 size={16} className="animate-spin" />}<KeyRound size={16} /> Emergency Sign In
            </button>
          </form>
        ) : (
          <>
            {providers.map((p) => (
              <button key={p.id} type="button" onClick={() => handleSso(p.id)} className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid={`sso-button-${p.id}`}>
                <Shield size={16} /> Sign in with {p.displayName}
              </button>
            ))}
            {providers.length > 0 && showLocalAuth && (
              <div className="my-4 flex items-center gap-3"><div className="flex-1 border-t border-gray-200 dark:border-gray-700" /><span className="text-xs text-gray-400">or</span><div className="flex-1 border-t border-gray-200 dark:border-gray-700" /></div>
            )}
            {showLocalAuth && passkeyChallenge && (
              // 2FA step 2: password verified, awaiting passkey assertion.
              <div className="space-y-4" data-testid="passkey-2fa-prompt">
                <div className="rounded-lg border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 px-4 py-3 text-sm text-blue-900 dark:text-blue-100">
                  Almost there. Verify with your passkey to complete sign-in for <strong>{passkeyChallenge.user.email}</strong>.
                </div>
                {passkeyError && (
                  <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300" data-testid="passkey-2fa-error">{passkeyError}</div>
                )}
                <button type="button" onClick={handle2FA} disabled={submitting || !passkey.supported} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="passkey-2fa-button">
                  {submitting ? <Loader2 size={16} className="animate-spin" /> : <Fingerprint size={16} />} Verify with passkey
                </button>
                <button type="button" onClick={() => { clearPasskeyChallenge(); setPasskeyError(null); }} className="w-full rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid="passkey-2fa-cancel">
                  Cancel
                </button>
              </div>
            )}
            {showLocalAuth && !passkeyChallenge && (
              <form onSubmit={handleSubmit} className="space-y-4" data-testid="login-form">
                <div><label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Email</label><input id="email" type="email" required autoComplete="email webauthn" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm" placeholder="admin@k8s-platform.test" data-testid="email-input" /></div>
                <div><label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Password</label><input id="password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm" placeholder="Enter your password" data-testid="password-input" /></div>
                <button type="submit" disabled={submitting} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="login-button">{submitting && <Loader2 size={16} className="animate-spin" />} Sign In</button>
                {passkey.supported && (
                  <>
                    <div className="my-3 flex items-center gap-3"><div className="flex-1 border-t border-gray-200 dark:border-gray-700" /><span className="text-xs text-gray-400">or</span><div className="flex-1 border-t border-gray-200 dark:border-gray-700" /></div>
                    <button type="button" onClick={handlePasskeyLogin} disabled={submitting} className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50" data-testid="passkey-login-button">
                      <Fingerprint size={16} /> Sign in with passkey
                    </button>
                  </>
                )}
                {passkeyError && (
                  <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-2 text-xs text-red-700 dark:text-red-300" data-testid="passkey-login-error">{passkeyError}</div>
                )}
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
