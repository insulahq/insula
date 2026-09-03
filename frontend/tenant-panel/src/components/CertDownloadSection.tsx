import { useState } from 'react';
import {
  Download, Key, Loader2, Plus, Trash2, Copy, Check, AlertCircle, ShieldAlert,
} from 'lucide-react';
import type { CertTokenExpiry } from '@insula/api-contracts';
import {
  useCertDownloadAvailability,
  useCertTokens,
  useCreateCertToken,
  useRevokeCertToken,
  downloadCertBundle,
  type CreateCertTokenResponse,
} from '@/hooks/use-cert-download';
import { useCanManageCerts } from '@/hooks/use-can-manage-certs';

/**
 * Certificate download + API access for one domain.
 *
 * Two audiences on purpose:
 *
 *   the button   a one-off copy. The original TLS design was API-only, on the
 *                grounds that a browser button invites casual exposure of key
 *                material — but minting a token to fetch a file once is
 *                disproportionate, so the button exists (operator decision
 *                2026-09-03) with the warning kept.
 *   the tokens   the real use case. Let's Encrypt renews every 90 days, so an
 *                external web server or deploy pipeline needs to pick the
 *                renewed certificate up unattended. Tokens keep working when
 *                the platform is configured for OIDC-only sign-in, because the
 *                download route verifies them itself.
 */

const EXPIRY_OPTIONS: ReadonlyArray<{ value: CertTokenExpiry; label: string }> = [
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '1y', label: '1 year' },
  { value: 'never', label: 'Never' },
];

interface Props {
  readonly tenantId: string;
  readonly domainId: string;
  readonly domainName: string;
}

export default function CertDownloadSection({ tenantId, domainId, domainName }: Props) {
  // NOT the page's broader `useCanManage` — that includes `support`, which the
  // backend excludes from every key-bearing route. Using it here renders
  // enabled buttons that 403 on click.
  const canManage = useCanManageCerts();
  const availability = useCertDownloadAvailability(tenantId, domainId);
  const tokensQuery = useCertTokens(tenantId, domainId);
  const createToken = useCreateCertToken(tenantId, domainId);
  const revokeToken = useRevokeCertToken(tenantId, domainId);

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<CertTokenExpiry>('90d');
  const [minted, setMinted] = useState<CreateCertTokenResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const avail = availability.data?.data;
  const tokens = tokensQuery.data?.data ?? [];

  async function handleDownload() {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadCertBundle(tenantId, domainId, domainName);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const res = await createToken.mutateAsync({ name: name.trim(), expiry });
    setMinted(res.data);
    setName('');
    setExpiry('90d');
    setShowCreate(false);
  }

  // Revoke failures were previously invisible: the rejection surfaced only as
  // an unhandled promise, the confirm state never reset, and the customer got
  // no feedback on a screen whose whole purpose is credential management.
  async function handleRevoke(tokenId: string) {
    setRevokeError(null);
    try {
      await revokeToken.mutateAsync(tokenId);
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirmRevoke(null);
    }
  }

  async function handleCopy(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the value is on screen and selectable.
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="border-b border-gray-100 px-5 py-4 dark:border-gray-700">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <Key size={16} />
          Certificate files
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Download the certificate and private key for this domain, or create a token so a
          server can fetch the renewed certificate on its own.
        </p>
      </div>

      {/* ── Manual download ────────────────────────────────────────── */}
      <div className="border-b border-gray-100 px-5 py-4 dark:border-gray-700">
        {availability.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={14} className="animate-spin" /> Checking…
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleDownload}
                disabled={!canManage || !avail?.available || downloading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="download-cert-button"
              >
                {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                Download certificate
              </button>
              {avail?.source && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {avail.source === 'managed'
                    ? "Issued automatically by the platform"
                    : 'Uploaded by you'}
                  {avail.expiresAt && ` · expires ${new Date(avail.expiresAt).toLocaleDateString()}`}
                </span>
              )}
            </div>

            {!avail?.available && avail?.reason && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-gray-500 dark:text-gray-400" data-testid="download-unavailable">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                {avail.reason}
              </p>
            )}
            {!canManage && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Your role can view certificate details but not download the private key.
              </p>
            )}
            {downloadError && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400" data-testid="download-error">
                Download failed: {downloadError}
              </p>
            )}
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <ShieldAlert size={12} className="mt-0.5 shrink-0" />
              The file contains the private key. Store it somewhere only your servers can read.
            </p>
          </>
        )}
      </div>

      {/* ── Freshly minted token — shown once ───────────────────────── */}
      {minted && (
        <div
          className="border-b border-amber-200 bg-amber-50 px-5 py-4 dark:border-amber-800 dark:bg-amber-900/20"
          data-testid="minted-token"
        >
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Token created — copy it now
          </p>
          <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
            This is the only time it is shown. It cannot be retrieved later; if you lose it,
            revoke it and create another.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code
              className="flex-1 overflow-x-auto rounded border border-amber-300 bg-white px-2 py-1.5 font-mono text-xs text-gray-900 dark:border-amber-700 dark:bg-gray-900 dark:text-gray-100"
              data-testid="minted-token-value"
            >
              {minted.token}
            </code>
            <button
              type="button"
              onClick={() => handleCopy(minted.token)}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-gray-800 dark:text-amber-200 dark:hover:bg-gray-700"
              data-testid="copy-token-button"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setMinted(null)}
            className="mt-2 text-xs text-amber-800 underline hover:no-underline dark:text-amber-300"
          >
            I have saved it
          </button>
        </div>
      )}

      {/* ── Tokens ─────────────────────────────────────────────────── */}
      <div className="px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">API access</h4>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
              For servers and deploy pipelines that fetch the certificate automatically.
            </p>
          </div>
          {canManage && (
            <button
              type="button"
              onClick={() => setShowCreate((p) => !p)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              data-testid="new-cert-token-button"
            >
              <Plus size={14} />
              New token
            </button>
          )}
        </div>

        {showCreate && (
          <form onSubmit={handleCreate} className="mt-3 space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid="create-token-form">
            <div>
              <label htmlFor="cert-token-name" className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                Name
              </label>
              <input
                id="cert-token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={100}
                placeholder="e.g. staging-server"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                data-testid="cert-token-name-input"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                So you can tell your tokens apart later — one per server is a good habit.
              </p>
            </div>
            <div>
              <label htmlFor="cert-token-expiry" className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                Expires
              </label>
              <select
                id="cert-token-expiry"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value as CertTokenExpiry)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                data-testid="cert-token-expiry-select"
              >
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            {createToken.error && (
              <p className="text-xs text-red-600 dark:text-red-400" data-testid="create-token-error">
                {createToken.error instanceof Error ? createToken.error.message : 'Could not create the token.'}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={createToken.isPending || name.trim().length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                data-testid="submit-cert-token"
              >
                {createToken.isPending && <Loader2 size={14} className="animate-spin" />}
                Create token
              </button>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {tokensQuery.isLoading ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={14} className="animate-spin" /> Loading tokens…
          </div>
        ) : tokensQuery.error ? (
          // An error must never render as "no tokens" — that reads as
          // "nothing to revoke" on a screen about credentials.
          <p className="mt-3 text-sm text-red-600 dark:text-red-400" data-testid="cert-tokens-error">
            Could not load tokens.
          </p>
        ) : tokens.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400" data-testid="no-cert-tokens">
            No tokens yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-700" data-testid="cert-token-list">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2.5" data-testid={`cert-token-${t.id}`}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t.name}
                    {t.expired && (
                      <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/20 dark:text-red-300">
                        Expired
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {t.expiresAt ? `Expires ${new Date(t.expiresAt).toLocaleDateString()}` : 'Never expires'}
                    {' · '}
                    {t.lastUsedAt
                      ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
                      : 'never used'}
                  </p>
                </div>
                {canManage && (
                  confirmRevoke === t.id ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleRevoke(t.id)}
                        disabled={revokeToken.isPending}
                        className="rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        data-testid={`confirm-revoke-${t.id}`}
                      >
                        {revokeToken.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRevoke(null)}
                        className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:border-gray-600 dark:text-gray-200"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRevoke(t.id)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-red-300 px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/30"
                      data-testid={`revoke-${t.id}`}
                    >
                      <Trash2 size={12} />
                      Revoke
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}

        {revokeError && (
          <p className="mt-3 text-xs text-red-600 dark:text-red-400" data-testid="revoke-error">
            Could not revoke the token: {revokeError}
          </p>
        )}

        <details className="mt-4 text-xs text-gray-500 dark:text-gray-400">
          <summary className="cursor-pointer select-none font-medium text-gray-700 dark:text-gray-300">
            How to use a token
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-gray-50 p-3 font-mono text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">
{`curl -H "Authorization: Bearer <token>" \\
  ${window.location.origin}/api/v1/certs/${domainName}/download \\
  -o ${domainName}.pem`}
          </pre>
          <p className="mt-2">
            The file contains the private key, the certificate and the full chain, in that
            order. Re-run it after each renewal — certificates issued by the platform are
            renewed automatically about every 60 days.
          </p>
        </details>
      </div>
    </div>
  );
}
