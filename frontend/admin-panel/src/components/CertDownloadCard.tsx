import { useState } from 'react';
import { Download, Key, Loader2, Trash2, AlertCircle, ShieldAlert } from 'lucide-react';
import {
  useCertDownloadAvailability,
  useCertTokens,
  useRevokeCertToken,
  downloadCertBundle,
} from '@/hooks/use-cert-download';
import { useCanManageCerts } from '@/hooks/use-can-manage-certs';

/**
 * Admin-side certificate download for a tenant's domain.
 *
 * Narrower than the tenant panel's section on purpose:
 *
 *   download   yes, for admin/super_admin — diagnosing a TLS problem on a
 *              server the customer runs themselves needs the real certificate.
 *   list       yes, for everyone who can see the page.
 *   revoke     yes, for admin/super_admin — "I leaked a token" is urgent.
 *   create     NO. The secret is shown exactly once and belongs to the
 *              customer. Minting it into an admin's browser puts a live
 *              credential somewhere the customer never sees and cannot audit.
 *              The API permits it; the admin UI deliberately does not.
 *
 * `support` gets the LIST only. It is excluded from download and revoke by
 * `requireRole` on the backend, so the controls are hidden rather than left
 * enabled to 403 on click. An earlier revision of this comment claimed support
 * could download and revoke — it never could; the backend and
 * docs/architecture/TLS_CERTIFICATE_MANAGEMENT.md always said otherwise.
 */

interface Props {
  readonly tenantId: string;
  readonly domainId: string;
  readonly domainName: string;
}

export default function CertDownloadCard({ tenantId, domainId, domainName }: Props) {
  const canManageCerts = useCanManageCerts();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const availability = useCertDownloadAvailability(tenantId, domainId);
  const tokensQuery = useCertTokens(tenantId, domainId);
  const revoke = useRevokeCertToken(tenantId, domainId);

  async function handleDownload() {
    setDownloading(true);
    setError(null);
    try {
      await downloadCertBundle(tenantId, domainId, domainName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

  // Revoke failures were previously invisible: the rejection surfaced only as
  // an unhandled promise, the confirm state never reset, and the operator got
  // no feedback on a screen whose whole purpose is credential management.
  async function handleRevoke(tokenId: string) {
    setRevokeError(null);
    try {
      await revoke.mutateAsync(tokenId);
    } catch (err) {
      setRevokeError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirmRevoke(null);
    }
  }

  const avail = availability.data?.data;
  const tokens = tokensQuery.data?.data ?? [];

  return (
    <div className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800" data-testid="admin-cert-download-card">
      <div className="border-b border-gray-100 px-5 py-4 dark:border-gray-700">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <Key size={16} />
          Certificate files
        </h3>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Download this domain&apos;s certificate, or revoke a token the customer has issued.
        </p>
      </div>

      <div className="border-b border-gray-100 px-5 py-4 dark:border-gray-700">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleDownload}
            disabled={!canManageCerts || !avail?.available || downloading}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="admin-download-cert-button"
          >
            {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Download certificate
          </button>
          {avail?.source && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {avail.source === 'managed' ? 'Platform-issued' : 'Customer-uploaded'}
              {avail.expiresAt && ` · expires ${new Date(avail.expiresAt).toLocaleDateString()}`}
            </span>
          )}
        </div>
        {!avail?.available && avail?.reason && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            {avail.reason}
          </p>
        )}
        {!canManageCerts && (
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" data-testid="admin-cert-readonly">
            Your role can view certificate details but not download the private key.
          </p>
        )}
        {error && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400" data-testid="admin-download-error">
            Download failed: {error}
          </p>
        )}
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <ShieldAlert size={12} className="mt-0.5 shrink-0" />
          Contains the customer&apos;s private key. Every download is recorded in the audit log.
        </p>
      </div>

      <div className="px-5 py-4">
        <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">Download tokens</h4>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          Issued by the customer in their panel. New tokens are created there — the secret is
          shown once and belongs to them.
        </p>
        {tokensQuery.isLoading ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : tokensQuery.error ? (
          // Never render a load failure as "no tokens" on a credentials screen.
          <p className="mt-3 text-sm text-red-600 dark:text-red-400" data-testid="admin-cert-tokens-error">
            Could not load tokens.
          </p>
        ) : tokens.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">No tokens issued.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-700">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
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
                    {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}` : 'never used'}
                  </p>
                </div>
                {!canManageCerts ? null : confirmRevoke === t.id ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleRevoke(t.id)}
                      disabled={revoke.isPending}
                      className="rounded-lg bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      data-testid={`admin-confirm-revoke-${t.id}`}
                    >
                      {revoke.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Confirm'}
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
                    data-testid={`admin-revoke-${t.id}`}
                  >
                    <Trash2 size={12} />
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {revokeError && (
          <p className="mt-3 text-xs text-red-600 dark:text-red-400" data-testid="admin-revoke-error">
            Could not revoke the token: {revokeError}
          </p>
        )}
      </div>
    </div>
  );
}
