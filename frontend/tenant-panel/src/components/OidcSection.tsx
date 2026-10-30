import { useState, useEffect, useMemo, type FormEvent } from 'react';
import { Lock, AlertCircle, AlertTriangle, CheckCircle, Loader2, Plus, Trash2, ExternalLink, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import {
  useIngressAuth,
  useUpsertIngressAuth,
  useDeleteIngressAuth,
  useTestIngressAuth,
  useOidcProviders,
} from '@/hooks/use-ingress-auth';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { servedHost, isWildcardHost } from '@/lib/served-host';
import type {
  ClaimRule,
  ClaimOperator,
  IngressAuthConfigInput,
  IngressAuthConfigResponse,
} from '@insula/api-contracts';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60';
const LABEL_CLASS = 'block text-sm font-medium text-gray-700 dark:text-gray-300';
const HINT_CLASS = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

const CLAIM_OPERATORS: ClaimOperator[] = ['equals', 'not_equals', 'contains', 'not_contains', 'in', 'not_in', 'exists', 'regex'];
const isListOperator = (op: ClaimOperator) => op === 'in' || op === 'not_in';

/** A claim rule as edited: the value always as typed text; parsed on save. */
interface RuleDraft {
  readonly claim: string;
  readonly operator: ClaimOperator;
  readonly text: string;
}

const toDraft = (r: ClaimRule): RuleDraft => ({
  claim: r.claim,
  operator: r.operator,
  text: Array.isArray(r.value) ? r.value.join(', ') : (r.value ?? ''),
});

function fromDraft(d: RuleDraft): ClaimRule {
  if (d.operator === 'exists') return { claim: d.claim.trim(), operator: d.operator };
  if (isListOperator(d.operator)) {
    return { claim: d.claim.trim(), operator: d.operator, value: d.text.split(',').map((s) => s.trim()).filter(Boolean) };
  }
  return { claim: d.claim.trim(), operator: d.operator, value: d.text };
}

interface Props {
  readonly tenantId: string;
  readonly routeId: string;
  readonly hostname: string;
  readonly wwwRedirect?: string | null;
}

function Toggle({ checked, onChange, testId, disabled }: {
  readonly checked: boolean;
  readonly onChange: (v: boolean) => void;
  readonly testId?: string;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        checked ? 'bg-blue-600 dark:bg-blue-500' : 'bg-gray-300 dark:bg-gray-600',
      )}
      data-testid={testId}
    >
      <span className={clsx(
        'pointer-events-none inline-block h-5 w-5 rounded-full bg-white dark:bg-gray-100 shadow transform transition-transform',
        checked ? 'translate-x-5' : 'translate-x-0',
      )} />
    </button>
  );
}

function CopyButton({ text, testId }: { readonly text: string; readonly testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 rounded border border-blue-300 dark:border-blue-800 px-2 py-0.5 text-xs text-blue-800 dark:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-900/40"
      data-testid={testId}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

const DEFAULTS = {
  enabled: true,
  issuerUrl: '',
  clientId: '',
  clientSecret: '',
  usePkce: true,
  scopes: 'openid profile email',
  postLoginRedirectUrl: '',
  allowedEmails: '',
  allowedEmailDomains: '',
  allowedGroups: '',
  rules: [] as RuleDraft[],
  passUser: true,
  passGroups: true,
  passAccess: false,
  passId: false,
  passAuthorization: false,
  cookieDomain: '',
  cookieRefresh: 0,
  cookieExpire: 86400,
};
type FormState = typeof DEFAULTS;

function formFrom(existing: IngressAuthConfigResponse | null | undefined): FormState {
  if (!existing) return DEFAULTS;
  return {
    ...DEFAULTS,
    enabled: existing.enabled,
    postLoginRedirectUrl: existing.postLoginRedirectUrl ?? '',
    allowedEmails: existing.allowedEmails ?? '',
    allowedEmailDomains: existing.allowedEmailDomains ?? '',
    allowedGroups: existing.allowedGroups ?? '',
    rules: (existing.claimRules ?? []).map(toDraft),
    passUser: existing.passUserHeaders,
    passGroups: existing.setXauthrequest,
    passAccess: existing.passAccessToken,
    passId: existing.passIdToken,
    passAuthorization: existing.passAuthorizationHeader,
    cookieDomain: existing.cookieDomain ?? '',
    cookieRefresh: existing.cookieRefreshSeconds,
    cookieExpire: existing.cookieExpireSeconds,
  };
}

export default function OidcSection({ tenantId, routeId, hostname, wwwRedirect }: Props) {
  const { data: existing, isLoading, error: loadError } = useIngressAuth(tenantId, routeId);
  const upsert = useUpsertIngressAuth(tenantId, routeId);
  const remove = useDeleteIngressAuth(tenantId, routeId);
  const test = useTestIngressAuth(tenantId, routeId);
  const { data: providers } = useOidcProviders(tenantId);

  const host = servedHost(hostname, wwwRedirect);
  const wildcard = isWildcardHost(hostname);
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [providerId, setProviderId] = useState('');
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };

  // Follow the saved config — including its removal (Disable).
  useEffect(() => {
    if (existing === undefined) return;
    setForm(formFrom(existing));
    if (existing) {
      setMode('existing');
      setProviderId(existing.providerId);
    }
  }, [existing]);
  // With no config yet, start from an existing provider when there is one.
  useEffect(() => {
    if (existing === null && providers && providers.length > 0 && !providerId) {
      setMode('existing');
      setProviderId(providers[0]!.id);
    }
  }, [existing, providers, providerId]);

  const selected = useMemo(() => providers?.find((p) => p.id === providerId), [providers, providerId]);
  const callbackUrl = existing?.callbackUrl ?? `https://${host}/oauth2/callback`;
  const providerLabel = mode === 'existing' ? selected?.name : 'your provider';
  const noAllowList = !form.allowedEmails.trim() && !form.allowedEmailDomains.trim() && !form.allowedGroups.trim() && form.rules.length === 0;
  const refreshTooLong = form.cookieRefresh > 0 && form.cookieRefresh >= form.cookieExpire;
  const issuerForTest = mode === 'existing' ? (selected?.issuerUrl ?? '') : form.issuerUrl;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const base = {
      enabled: form.enabled,
      postLoginRedirectUrl: form.postLoginRedirectUrl.trim() || null,
      allowedEmails: form.allowedEmails.trim() || null,
      allowedEmailDomains: form.allowedEmailDomains.trim() || null,
      allowedGroups: form.allowedGroups.trim() || null,
      claimRules: form.rules.length > 0 ? form.rules.map(fromDraft) : null,
      passUserHeaders: form.passUser,
      setXauthrequest: form.passGroups,
      passAccessToken: form.passAccess,
      passIdToken: form.passId,
      passAuthorizationHeader: form.passAuthorization,
      cookieDomain: form.cookieDomain.trim() || null,
      cookieRefreshSeconds: form.cookieRefresh,
      cookieExpireSeconds: form.cookieExpire,
    };
    const payload: IngressAuthConfigInput = mode === 'existing'
      ? { ...base, providerId }
      : {
        ...base,
        issuerUrl: form.issuerUrl.trim(),
        clientId: form.clientId.trim(),
        clientSecret: form.clientSecret,
        usePkce: form.usePkce,
        scopes: form.scopes.trim(),
      };
    try {
      await upsert.mutateAsync(payload);
      setForm((f) => ({ ...f, clientSecret: '' }));
      setSaved(true);
    } catch {
      // Shown by the ErrorPanel below.
    }
  };

  const handleDelete = async () => {
    if (!confirm('Turn sign-in off for this route? It becomes reachable without signing in.')) return;
    try {
      await remove.mutateAsync();
    } catch {
      // Shown by the ErrorPanel below.
    }
  };

  const updateRule = (idx: number, patch: Partial<RuleDraft>) => {
    setSaved(false);
    setForm((f) => ({ ...f, rules: f.rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)) }));
  };

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
        <Loader2 size={16} className="animate-spin text-gray-500 dark:text-gray-400" />
      </div>
    );
  }

  const savedEnabled = existing?.enabled === true;
  const mutationError = upsert.error ?? remove.error;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden" data-testid="oidc-section">
      <button type="button" onClick={() => setIsOpen(!isOpen)} className="flex w-full items-center justify-between px-5 py-4 text-left">
        <div className="flex items-center gap-2">
          {isOpen ? <ChevronDown size={16} className="text-gray-400 dark:text-gray-500" /> : <ChevronRight size={16} className="text-gray-400 dark:text-gray-500" />}
          <Lock size={18} className="text-gray-700 dark:text-gray-300" />
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Sign-in (OIDC)</h3>
        </div>
        <span
          className={clsx(
            'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
            existing?.lastError && savedEnabled
              ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
              : savedEnabled
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
          )}
          data-testid="oidc-status"
        >
          {existing?.lastError && savedEnabled ? 'Not working' : savedEnabled ? 'On' : 'Off'}
        </span>
      </button>

      {isOpen && loadError && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-5">
          <ErrorPanel error={extractOperatorError(loadError)} testId="oidc-load-error" />
        </div>
      )}

      {isOpen && !loadError && wildcard && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-5 text-sm text-gray-700 dark:text-gray-300" data-testid="oidc-wildcard">
          Sign-in cannot protect a wildcard route: the identity provider needs one redirect URI per host. Add a route
          for each host you want to protect.
        </div>
      )}

      {isOpen && !loadError && !wildcard && (
        <form onSubmit={handleSubmit} className="border-t border-gray-200 dark:border-gray-700 p-5 space-y-5">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Visitors to <strong className="text-gray-900 dark:text-gray-100">{host}</strong> sign in at your identity provider
            (Google, Microsoft, Zitadel, Keycloak, …) before they reach the app.
          </p>

          {existing?.lastError && savedEnabled && (
            <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-800 dark:text-red-200" data-testid="oidc-last-error">
              <strong>Sign-in is not working:</strong> {existing.lastError}
            </div>
          )}

          <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-blue-900 dark:text-blue-100">Redirect URI to register at your identity provider</p>
              <CopyButton text={callbackUrl} testId="oidc-copy-callback" />
            </div>
            <code className="mt-1 block break-all text-sm text-blue-900 dark:text-blue-100" data-testid="oidc-callback-url">{callbackUrl}</code>
            <p className="mt-1 text-xs text-blue-900/80 dark:text-blue-200/80">
              Google: APIs &amp; Services → Credentials → your OAuth client (type <em>Web application</em>) →
              Authorized redirect URIs. Without it the provider refuses the sign-in.
            </p>
          </div>

          <fieldset className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">Identity provider</legend>
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <label className="inline-flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} disabled={!providers || providers.length === 0} data-testid="provider-mode-existing" />
                Use existing {providers && providers.length > 0 && <span className="text-xs text-gray-500 dark:text-gray-400">({providers.length})</span>}
              </label>
              <label className="inline-flex items-center gap-2 text-gray-700 dark:text-gray-300">
                <input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} data-testid="provider-mode-new" />
                New provider
              </label>
              <Link to="/settings/oidc-providers" className="ml-auto inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline" data-testid="oidc-manage-providers-link">
                Manage providers <ExternalLink size={12} />
              </Link>
            </div>

            {mode === 'existing' ? (
              <div className="space-y-2">
                <select className={INPUT_CLASS} value={providerId} onChange={(e) => { setSaved(false); setProviderId(e.target.value); }} data-testid="provider-select" required>
                  <option value="">— choose a provider —</option>
                  {(providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>{p.name} ({p.issuerUrl})</option>
                  ))}
                </select>
                {selected && (
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2" data-testid="provider-summary">
                    <div><dt className="inline text-gray-500 dark:text-gray-400">Issuer: </dt><dd className="inline text-gray-900 dark:text-gray-100 break-all">{selected.issuerUrl}</dd></div>
                    <div><dt className="inline text-gray-500 dark:text-gray-400">Client ID: </dt><dd className="inline text-gray-900 dark:text-gray-100 break-all">{selected.oauthClientId}</dd></div>
                    <div><dt className="inline text-gray-500 dark:text-gray-400">Scopes: </dt><dd className="inline text-gray-900 dark:text-gray-100">{selected.defaultScopes}</dd></div>
                    <div><dt className="inline text-gray-500 dark:text-gray-400">PKCE: </dt><dd className="inline text-gray-900 dark:text-gray-100">{selected.usePkce ? 'on' : 'off'}</dd></div>
                  </dl>
                )}
                <p className={HINT_CLASS}>Change the provider's settings on the providers page; they apply to every route that uses it.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label htmlFor="oidc-issuer" className={LABEL_CLASS}>Issuer URL</label>
                  <input id="oidc-issuer" className={`${INPUT_CLASS} mt-1`} value={form.issuerUrl} onChange={(e) => set('issuerUrl', e.target.value)} placeholder="https://accounts.google.com" data-testid="oidc-issuer" required />
                </div>
                <div>
                  <label htmlFor="oidc-cid" className={LABEL_CLASS}>Client ID</label>
                  <input id="oidc-cid" className={`${INPUT_CLASS} mt-1`} value={form.clientId} onChange={(e) => set('clientId', e.target.value)} data-testid="oidc-client-id" required />
                </div>
                <div>
                  <label htmlFor="oidc-secret" className={LABEL_CLASS}>Client secret</label>
                  <input id="oidc-secret" type="password" autoComplete="new-password" className={`${INPUT_CLASS} mt-1`} value={form.clientSecret} onChange={(e) => set('clientSecret', e.target.value)} data-testid="oidc-client-secret" required />
                </div>
                <div>
                  <label htmlFor="oidc-scopes" className={LABEL_CLASS}>Scopes</label>
                  <input id="oidc-scopes" className={`${INPUT_CLASS} mt-1`} value={form.scopes} onChange={(e) => set('scopes', e.target.value)} data-testid="oidc-scopes" />
                  <p className={HINT_CLASS}>Must include <code>openid</code>. Add <code>groups</code> if your provider sends groups that way.</p>
                </div>
                <label className="flex items-center justify-between gap-2 self-end text-sm text-gray-700 dark:text-gray-300">
                  Use PKCE (S256)
                  <Toggle checked={form.usePkce} onChange={(v) => set('usePkce', v)} testId="oidc-pkce" />
                </label>
                <p className={`${HINT_CLASS} sm:col-span-2`}>Saved as a provider named after this route, which other routes can reuse.</p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => test.mutate(issuerForTest)} disabled={!issuerForTest || test.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                data-testid="oidc-test">
                {test.isPending && <Loader2 size={14} className="animate-spin" />} Test issuer
              </button>
              {test.data && (
                <span className={clsx('inline-flex items-center gap-1 text-sm', test.data.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400')} data-testid="oidc-test-result">
                  {test.data.ok ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
                  {test.data.ok ? `Discovery OK (${test.data.issuer})` : test.data.error}
                </span>
              )}
              {test.error && <span className="text-sm text-red-700 dark:text-red-400">{extractOperatorError(test.error).detail}</span>}
            </div>
          </fieldset>

          <fieldset className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">Who may open the site</legend>
            <p className={HINT_CLASS}>
              Anyone matching <em>any</em> entry may open the site. Separate entries with commas or new lines.
            </p>
            {noAllowList && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-900 dark:text-amber-200" data-testid="oidc-open-warning">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                With no entries, anyone who can sign in at {providerLabel ?? 'the provider'} can open this site — with Google,
                that is anyone with a Google account.
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">Email addresses</label>
              <textarea rows={2} className={`${INPUT_CLASS} mt-1`} value={form.allowedEmails} onChange={(e) => set('allowedEmails', e.target.value)} placeholder="alice@example.com, bob@example.com" data-testid="oidc-allowed-emails" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">Email domains</label>
              <input className={`${INPUT_CLASS} mt-1`} value={form.allowedEmailDomains} onChange={(e) => set('allowedEmailDomains', e.target.value)} placeholder="example.com" data-testid="oidc-allowed-domains" />
              <p className={HINT_CLASS}>The domain exactly — <code>example.com</code> does not include <code>sub.example.com</code>.</p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">Groups</label>
              <input className={`${INPUT_CLASS} mt-1`} value={form.allowedGroups} onChange={(e) => set('allowedGroups', e.target.value)} placeholder="engineers, admins" data-testid="oidc-allowed-groups" />
              <p className={HINT_CLASS}>From the ID token's <code>groups</code> claim; Google does not send one.</p>
            </div>

            <div className="space-y-2 border-t border-gray-200 dark:border-gray-700 pt-3">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Claim rules</p>
              <p className={HINT_CLASS}>Checked against the ID token, on top of the lists above; all must hold.</p>
              {form.rules.map((rule, idx) => (
                <div key={idx} className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                  <input className={`${INPUT_CLASS} sm:col-span-4`} placeholder="claim (e.g. hd)" value={rule.claim} onChange={(e) => updateRule(idx, { claim: e.target.value })} data-testid={`claim-rule-claim-${idx}`} />
                  <select className={`${INPUT_CLASS} sm:col-span-3`} value={rule.operator} onChange={(e) => updateRule(idx, { operator: e.target.value as ClaimOperator })} data-testid={`claim-rule-op-${idx}`}>
                    {CLAIM_OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
                  </select>
                  <input className={`${INPUT_CLASS} sm:col-span-4`} placeholder={isListOperator(rule.operator) ? 'value1, value2' : 'value'} value={rule.text}
                    onChange={(e) => updateRule(idx, { text: e.target.value })} disabled={rule.operator === 'exists'} data-testid={`claim-rule-value-${idx}`} />
                  <button type="button" onClick={() => { setSaved(false); setForm((f) => ({ ...f, rules: f.rules.filter((_, i) => i !== idx) })); }}
                    className="sm:col-span-1 inline-flex items-center justify-center rounded-lg border border-red-200 dark:border-red-900 px-2 py-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                    aria-label="Remove rule" data-testid={`claim-rule-remove-${idx}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => { setSaved(false); setForm((f) => ({ ...f, rules: [...f.rules, { claim: '', operator: 'equals', text: '' }] })); }}
                className="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300" data-testid="claim-rule-add">
                <Plus size={14} /> Add claim rule
              </button>
            </div>
          </fieldset>

          <fieldset className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3">
            <legend className="px-2 text-sm font-medium text-gray-700 dark:text-gray-300">What the app receives</legend>
            {([
              ['passUser', 'X-Auth-Request-User / -Email / -Preferred-Username', 'pass-user'],
              ['passGroups', 'X-Auth-Request-Groups', 'pass-groups'],
              ['passAccess', 'X-Auth-Request-Access-Token', 'pass-access'],
              ['passId', 'X-Auth-Request-Id-Token', 'pass-id'],
            ] as const).map(([key, label, testId]) => (
              <label key={key} className="flex items-center justify-between gap-2 text-sm text-gray-700 dark:text-gray-300">
                {label}
                <Toggle checked={form[key]} onChange={(v) => set(key, v)} testId={testId} />
              </label>
            ))}
            <div>
              <label className="flex items-center justify-between gap-2 text-sm text-gray-700 dark:text-gray-300">
                Authorization: Bearer &lt;ID token&gt;
                <Toggle checked={form.passAuthorization} onChange={(v) => set('passAuthorization', v)} testId="pass-auth" />
              </label>
              <p className={HINT_CLASS}>
                Replaces the request's own Authorization header. Leave it off for apps with their own login or API tokens
                (Immich, Nextcloud, Gitea, …) — they would reject every call — and with password-protected folders.
              </p>
            </div>
          </fieldset>

          <div>
            <label htmlFor="oidc-post-login" className={LABEL_CLASS}>
              After signing in, go to <span className="text-xs text-gray-500 dark:text-gray-400">(optional)</span>
            </label>
            <input id="oidc-post-login" type="url" className={`${INPUT_CLASS} mt-1`} value={form.postLoginRedirectUrl} onChange={(e) => set('postLoginRedirectUrl', e.target.value)} placeholder={`https://${host}/`} data-testid="oidc-post-login" />
            <p className={HINT_CLASS}>Leave blank to return to the page the visitor asked for.</p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className={LABEL_CLASS}>Cookie domain <span className="text-xs text-gray-500 dark:text-gray-400">(optional)</span></label>
              <input className={`${INPUT_CLASS} mt-1`} value={form.cookieDomain} onChange={(e) => set('cookieDomain', e.target.value)} placeholder={host} data-testid="oidc-cookie-domain" />
              <p className={HINT_CLASS}>A parent domain shares one sign-in across its protected sub-domains.</p>
            </div>
            <div>
              <label className={LABEL_CLASS}>Re-check after (s)</label>
              <input type="number" min={0} className={`${INPUT_CLASS} mt-1`} value={form.cookieRefresh} onChange={(e) => set('cookieRefresh', Number(e.target.value))} data-testid="oidc-cookie-refresh" />
              <p className={HINT_CLASS}>0 = never before expiry. Needs a provider that issues refresh tokens (Google does not by default).</p>
            </div>
            <div>
              <label className={LABEL_CLASS}>Sign-in lasts (s)</label>
              <input type="number" min={60} className={`${INPUT_CLASS} mt-1`} value={form.cookieExpire} onChange={(e) => set('cookieExpire', Number(e.target.value))} data-testid="oidc-cookie-expire" />
            </div>
          </div>
          {refreshTooLong && <p className="text-sm text-red-700 dark:text-red-400">Re-check must be shorter than how long a sign-in lasts (or 0).</p>}
          <p className={HINT_CLASS}>The session settings are shared by all of this tenant's protected routes; the shortest values apply.</p>

          <label className="flex items-center justify-between gap-2 border-t border-gray-200 dark:border-gray-700 pt-4 text-sm font-medium text-gray-700 dark:text-gray-300">
            Require sign-in
            <Toggle checked={form.enabled} onChange={(v) => set('enabled', v)} testId="oidc-enabled" />
          </label>

          {mutationError && <ErrorPanel error={extractOperatorError(mutationError)} testId="oidc-save-error" />}
          {saved && !upsert.error && (
            <p className="inline-flex items-center gap-1 text-sm text-green-700 dark:text-green-400" data-testid="oidc-saved">
              <CheckCircle size={14} /> Saved{form.enabled ? ` — visitors to ${host} now sign in first.` : '.'}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button type="submit" disabled={upsert.isPending || refreshTooLong || (mode === 'existing' && !providerId)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 dark:bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50"
              data-testid="oidc-save">
              {upsert.isPending && <Loader2 size={14} className="animate-spin" />}
              {upsert.isPending ? 'Saving and starting sign-in…' : 'Save'}
            </button>
            {existing && (
              <button type="button" onClick={handleDelete} disabled={remove.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 dark:border-red-800 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50"
                data-testid="oidc-disable">
                {remove.isPending && <Loader2 size={14} className="animate-spin" />} Remove sign-in
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
