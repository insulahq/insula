import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { Loader2, Shield, Fingerprint } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { usePasskey } from '@/hooks/use-passkey';
import TotpStep from '@/components/auth/TotpStep';
import { useAuthStatus } from '@/hooks/use-auth-status';
import ApiUnavailable from '@/components/ApiUnavailable';
import { API_BASE, ApiError } from '@/lib/api-client';
import { useSystemInfo, useDocumentTitle } from '@/hooks/use-system-info';
import { proxySsoProvider, markProxySsoAttempt, resetProxySso } from '@/lib/proxy-sso';

export default function Login() {
  // The login screen sits OUTSIDE <Layout>, so the useDocumentTitle call
  // in Layout never runs here — the tab said the build-time default while
  // the page itself showed the operator's platform name. Setting it here
  // makes the two agree from the first paint the visitor sees.
  const { data: systemInfo } = useSystemInfo();
  const platformName = systemInfo?.platformName ?? 'Hosting Platform';
  useDocumentTitle();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // The provider list AND the API-reachability signal come from one request —
  // see use-auth-status.ts. `null` while loading keeps the pre-gate rendering
  // (local form, no SSO buttons) byte-identical to what it always was.
  const { state: authState, retryNow } = useAuthStatus('tenant');
  const authStatus = authState.kind === 'ready' ? authState.status : null;

  const { login, error, setTokenAndUser, totpChallenge, clearTotpChallenge } = useAuth();
  const passkey = usePasskey();
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/';

  useEffect(() => {
    const token = searchParams.get('token');
    const userJson = searchParams.get('user');
    if (token && userJson) {
      try {
        const user = JSON.parse(decodeURIComponent(userJson));
        setTokenAndUser(token, user);
        resetProxySso(sessionStorage);
        navigate('/', { replace: true });
      } catch { /* ignore */ }
    }
  }, [searchParams, navigate, setTokenAndUser]);

  // NO auto-redirect to the IdP, even when there is exactly one provider and
  // local auth is off. The visitor always clicks "Sign in with …" first —
  // with ONE exception, below handleSso: a proxy-protected panel.
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
      // With an authenticator app on, the store now holds totpChallenge and
      // the page shows the code step instead — don't navigate yet.
      if (!useAuth.getState().totpChallenge) {
        navigate(from, { replace: true });
      }
    } catch { /* error in store */ } finally { setSubmitting(false); }
  };

  const handlePasskeyLogin = async () => {
    setSubmitting(true);
    setPasskeyError(null);
    try {
      const result = await passkey.loginUserless();
      setTokenAndUser(result.token, result.user);
      localStorage.setItem('auth_refresh_token', result.refreshToken);
      navigate(from, { replace: true });
    } catch (err) {
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


  const handleSso = (providerId: string) => {
    const callbackUrl = `${window.location.origin}/login`;
    window.location.href = `${API_BASE}/api/v1/auth/oidc/authorize/${providerId}?redirect_uri=${encodeURIComponent(callbackUrl)}`;
  };

  // Behind the OAuth2 Proxy the visitor has just signed in to the proxy's
  // provider; starting that provider here completes on the IdP session it left,
  // so they do not log in twice. Guarded against every dead end the rule above
  // exists for — see lib/proxy-sso.ts.
  const [ssoStartingWith, setSsoStartingWith] = useState<string | null>(null);
  useEffect(() => {
    if (!authStatus) return;
    const providerId = proxySsoProvider({
      proxyProviderId: authStatus.proxyProviderId,
      providerIds: authStatus.providers.map((p) => p.id),
      callbackInProgress: searchParams.has('token') || searchParams.has('error'),
      storage: sessionStorage,
      now: Date.now(),
    });
    if (!providerId) return;
    markProxySsoAttempt(sessionStorage, Date.now());
    setSsoStartingWith(authStatus.providers.find((p) => p.id === providerId)?.displayName ?? 'your provider');
    const callbackUrl = `${window.location.origin}/login`;
    window.location.href = `${API_BASE}/api/v1/auth/oidc/authorize/${providerId}?redirect_uri=${encodeURIComponent(callbackUrl)}`;
  }, [authStatus, searchParams]);

  const showLocalAuth = authStatus?.localAuthEnabled ?? true;
  const providers = authStatus?.providers ?? [];
  const oidcError = searchParams.get('error');
  const oidcMessage = searchParams.get('message');

  // API-readiness gate. Deliberately placed AFTER every hook — in particular
  // after the effect that consumes `?token=&user=` — so the OIDC callback leg
  // still completes while the API is flapping. That leg needs no authStatus.
  if (authState.kind === 'unreachable') {
    return (
      <ApiUnavailable
        attempts={authState.attempts}
        since={authState.since}
        onRetry={retryNow}
        panelLabel="your account"
      />
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-linear-to-br from-brand-500 to-accent-500 dark:from-gray-900 dark:to-gray-800 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-800 p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center">
          <img src="/insula-mark.svg" alt="" aria-hidden="true" className="h-14 w-14" />
          <h1 className="mt-4 text-xl font-bold text-gray-900 dark:text-gray-100">{platformName}</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Sign in to manage your hosting</p>
        </div>

        {/* During the code step, TotpStep shows the store's error itself. */}
        {((error && !totpChallenge) || oidcError) && (
          <div className="mb-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 px-4 py-3 text-sm text-red-700 dark:text-red-300" data-testid="login-error">
            {error ?? (oidcMessage ? decodeURIComponent(oidcMessage) : 'Authentication failed. Please contact your administrator.')}
          </div>
        )}

        {ssoStartingWith && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-brand-200 dark:border-brand-800 bg-brand-50 dark:bg-brand-900/20 px-4 py-3 text-sm text-brand-700 dark:text-brand-300" data-testid="proxy-sso-starting">
            <Loader2 size={16} className="animate-spin" /> Signing you in with {ssoStartingWith}…
          </div>
        )}

        {providers.map((p) => (
          <button key={p.id} type="button" onClick={() => handleSso(p.id)} className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid={`sso-button-${p.id}`}>
            <Shield size={16} /> Sign in with {p.displayName}
          </button>
        ))}

        {providers.length > 0 && showLocalAuth && (
          <div className="my-4 flex items-center gap-3"><div className="flex-1 border-t border-gray-200 dark:border-gray-700" /><span className="text-xs text-gray-400 dark:text-gray-500">or</span><div className="flex-1 border-t border-gray-200 dark:border-gray-700" /></div>
        )}

        {showLocalAuth && totpChallenge && (
          <TotpStep
            email={totpChallenge.user.email}
            onDone={() => navigate(from, { replace: true })}
            onCancel={clearTotpChallenge}
          />
        )}
        {showLocalAuth && !totpChallenge && (
          <form onSubmit={handleSubmit} className="space-y-4" data-testid="login-form">
            <div><label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Email</label><input id="email" type="email" required autoComplete="email webauthn" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm dark:bg-gray-700 dark:text-gray-100" placeholder="you@example.com" data-testid="email-input" /></div>
            <div><label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Password</label><input id="password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm dark:bg-gray-700 dark:text-gray-100" placeholder="Enter your password" data-testid="password-input" /></div>
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
      </div>
    </div>
  );
}
