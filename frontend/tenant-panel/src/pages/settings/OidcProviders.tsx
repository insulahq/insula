import { useState, type FormEvent } from 'react';
import { Lock, Loader2, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTenantContext } from '@/hooks/use-tenant-context';
import {
  useOidcProviders,
  useCreateOidcProvider,
  useUpdateOidcProvider,
  useDeleteOidcProvider,
} from '@/hooks/use-ingress-auth';
import ProvidersTable, { type ProviderRow } from '@/components/settings/ProvidersTable';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import type { OidcProviderInput, OidcProviderUpdateInput, OidcProviderResponse } from '@insula/api-contracts';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';
const LABEL_CLASS = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';

interface ProviderRowDisplay extends ProviderRow {
  readonly raw: OidcProviderResponse;
}

export default function OidcProviders() {
  const { tenantId } = useTenantContext();
  const { data: providers, isLoading, error } = useOidcProviders(tenantId ?? undefined);
  const deleteMut = useDeleteOidcProvider(tenantId ?? '');

  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; provider: OidcProviderResponse } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<OidcProviderResponse | null>(null);

  const rows: ProviderRowDisplay[] = (providers ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    subtitle: p.issuerUrl,
    consumerCount: p.consumerCount,
    raw: p,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/settings" className="rounded p-1.5 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700" aria-label="Back to settings">
          <ArrowLeft size={18} />
        </Link>
        <Lock size={24} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">OIDC Providers</h1>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
        Identity providers your routes can require a sign-in with (Google, Microsoft, Zitadel, Keycloak, …). Create one
        here, then choose it on a route's <strong>Access Control</strong> tab. All of your protected routes use the
        same provider.
      </p>

      {error && <ErrorPanel error={extractOperatorError(error)} testId="oidc-providers-load-error" />}

      <ProvidersTable
        title="Providers"
        emptyMessage="No OIDC providers yet. Create one to require a sign-in on your routes."
        rows={rows}
        isLoading={isLoading}
        onCreate={() => setModal({ mode: 'create' })}
        onEdit={(r) => setModal({ mode: 'edit', provider: r.raw })}
        onDelete={(r) => setConfirmDelete(r.raw)}
        testIdPrefix="oidc-providers"
      />

      {modal && tenantId && (
        <ProviderModal
          mode={modal.mode}
          provider={modal.mode === 'edit' ? modal.provider : null}
          tenantId={tenantId}
          onClose={() => setModal(null)}
        />
      )}

      {confirmDelete && (
        <DeleteModal
          provider={confirmDelete}
          onClose={() => { deleteMut.reset(); setConfirmDelete(null); }}
          onConfirm={async () => {
            try {
              await deleteMut.mutateAsync(confirmDelete.id);
              setConfirmDelete(null);
            } catch {
              // Shown in the dialog.
            }
          }}
          isPending={deleteMut.isPending}
          error={deleteMut.error}
        />
      )}
    </div>
  );
}

interface ModalProps {
  readonly mode: 'create' | 'edit';
  readonly provider: OidcProviderResponse | null;
  readonly tenantId: string;
  readonly onClose: () => void;
}

function RedirectUris({ provider }: { readonly provider: OidcProviderResponse | null }) {
  const urls = provider?.callbackUrls ?? [];
  return (
    <div className="md:col-span-2 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 px-3 py-2" data-testid="oidc-provider-redirect-uris">
      <p className="text-xs font-medium text-blue-900 dark:text-blue-100">Redirect URIs to register at the provider</p>
      {urls.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {urls.map((u) => <li key={u}><code className="break-all text-xs text-blue-900 dark:text-blue-100">{u}</code></li>)}
        </ul>
      )}
      <p className="mt-1 text-xs text-blue-900/80 dark:text-blue-200/80">
        One per protected host: <code>https://&lt;host&gt;/oauth2/callback</code>. A route's Access Control tab shows
        its own. Google: APIs &amp; Services → Credentials → OAuth client (<em>Web application</em>) → Authorized
        redirect URIs; the issuer is <code>https://accounts.google.com</code>.
      </p>
    </div>
  );
}

function ProviderModal({ mode, provider, tenantId, onClose }: ModalProps) {
  const createMut = useCreateOidcProvider(tenantId);
  const updateMut = useUpdateOidcProvider(tenantId, provider?.id ?? '');

  const [name, setName] = useState(provider?.name ?? '');
  const [issuerUrl, setIssuerUrl] = useState(provider?.issuerUrl ?? '');
  const [oauthClientId, setOauthClientId] = useState(provider?.oauthClientId ?? '');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [usePkce, setUsePkce] = useState(provider?.usePkce ?? true);
  const [defaultScopes, setDefaultScopes] = useState(provider?.defaultScopes ?? 'openid profile email');

  const isPending = createMut.isPending || updateMut.isPending;
  const error = createMut.error ?? updateMut.error;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      if (mode === 'create') {
        const payload: OidcProviderInput = { name, issuerUrl, oauthClientId, oauthClientSecret, usePkce, defaultScopes };
        await createMut.mutateAsync(payload);
      } else {
        const payload: OidcProviderUpdateInput = {
          name, issuerUrl, oauthClientId, usePkce, defaultScopes,
          ...(oauthClientSecret ? { oauthClientSecret } : {}),
        };
        await updateMut.mutateAsync(payload);
      }
      onClose();
    } catch {
      // Shown below.
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4" role="dialog" aria-modal="true" data-testid="oidc-provider-modal">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {mode === 'create' ? 'New OIDC provider' : `Edit "${provider?.name}"`}
        </h2>
        {mode === 'edit' && (provider?.consumerCount ?? 0) > 0 && (
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Used by {provider!.consumerCount} route{provider!.consumerCount === 1 ? '' : 's'}; saving restarts their sign-in.
          </p>
        )}

        <form onSubmit={onSubmit} className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <RedirectUris provider={provider} />
          <div className="md:col-span-2">
            <label className={LABEL_CLASS}>Name</label>
            <input className={INPUT_CLASS} value={name} onChange={(e) => setName(e.target.value)} required placeholder="Google" data-testid="oidc-provider-name" />
          </div>
          <div className="md:col-span-2">
            <label className={LABEL_CLASS}>Issuer URL</label>
            <input className={INPUT_CLASS} type="url" value={issuerUrl} onChange={(e) => setIssuerUrl(e.target.value)} required placeholder="https://accounts.google.com" data-testid="oidc-provider-issuer" />
          </div>
          <div>
            <label className={LABEL_CLASS}>Client ID</label>
            <input className={INPUT_CLASS} value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} required data-testid="oidc-provider-client-id" />
          </div>
          <div>
            <label className={LABEL_CLASS}>
              Client secret {mode === 'edit' && <span className="text-gray-400 dark:text-gray-500">(leave empty to keep it)</span>}
            </label>
            <input className={INPUT_CLASS} type="password" autoComplete="new-password" value={oauthClientSecret} onChange={(e) => setOauthClientSecret(e.target.value)}
              required={mode === 'create'} placeholder={mode === 'edit' && provider?.secretSet ? '••••••••' : ''} data-testid="oidc-provider-client-secret" />
          </div>
          <div>
            <label className={LABEL_CLASS}>Scopes</label>
            <input className={INPUT_CLASS} value={defaultScopes} onChange={(e) => setDefaultScopes(e.target.value)} placeholder="openid profile email" data-testid="oidc-provider-scopes" />
          </div>
          <div className="flex items-center gap-2 pt-6">
            <input type="checkbox" id="provider-pkce" checked={usePkce} onChange={(e) => setUsePkce(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700 text-blue-600 focus:ring-blue-500" />
            <label htmlFor="provider-pkce" className="text-sm text-gray-700 dark:text-gray-300">Use PKCE (S256)</label>
          </div>

          {error && (
            <div className="md:col-span-2">
              <ErrorPanel error={extractOperatorError(error)} testId="oidc-provider-error" />
            </div>
          )}

          <div className="md:col-span-2 mt-2 flex justify-end gap-2">
            <button type="button" onClick={onClose}
              className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
              Cancel
            </button>
            <button type="submit" disabled={isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 dark:bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50"
              data-testid="oidc-provider-submit">
              {isPending && <Loader2 size={14} className="animate-spin" />}
              {mode === 'create' ? 'Create' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface DeleteModalProps {
  readonly provider: OidcProviderResponse;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
  readonly isPending: boolean;
  readonly error: unknown;
}

function DeleteModal({ provider, onClose, onConfirm, isPending, error }: DeleteModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Delete provider?</h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          This permanently removes <strong className="text-gray-900 dark:text-gray-100">{provider.name}</strong>.
        </p>
        {provider.consumerCount > 0 && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            {provider.consumerCount} route{provider.consumerCount === 1 ? ' uses' : 's use'} it — remove their sign-in first.
          </p>
        )}
        {error != null && <div className="mt-3"><ErrorPanel error={extractOperatorError(error)} testId="oidc-provider-delete-error" /></div>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={isPending || provider.consumerCount > 0}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 dark:bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 dark:hover:bg-red-600 disabled:opacity-50"
            data-testid="oidc-provider-confirm-delete">
            {isPending && <Loader2 size={14} className="animate-spin" />}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
