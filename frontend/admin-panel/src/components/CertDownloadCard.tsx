import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Key, Loader2, Trash2, AlertCircle, ShieldAlert } from 'lucide-react';
import { apiFetch, API_BASE } from '@/lib/api-client';
import type { CertToken, CertDownloadAvailability } from '@insula/api-contracts';

/**
 * Admin-side certificate download for a tenant's domain.
 *
 * Narrower than the tenant panel's section on purpose:
 *
 *   download   yes — support routinely needs a customer's certificate to
 *              diagnose a TLS problem on their external server.
 *   list       yes — "which of my tokens is still live?" is a support question.
 *   revoke     yes — "I leaked a token" is a support emergency.
 *   create     NO. The secret is shown exactly once, and it belongs to the
 *              customer. Minting it into an admin's browser puts a live
 *              credential somewhere the customer never sees and cannot audit.
 *              The API permits it; the admin UI deliberately does not.
 */

interface Props {
  readonly tenantId: string;
  readonly domainId: string;
  readonly domainName: string;
}

function base(tenantId: string, domainId: string): string {
  return `/api/v1/tenants/${tenantId}/domains/${domainId}`;
}

export default function CertDownloadCard({ tenantId, domainId, domainName }: Props) {
  const qc = useQueryClient();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const availability = useQuery({
    queryKey: ['cert-download-availability', tenantId, domainId],
    queryFn: () => apiFetch<{ data: CertDownloadAvailability }>(
      `${base(tenantId, domainId)}/ssl-cert/download-availability`,
    ),
  });
  const tokensQuery = useQuery({
    queryKey: ['cert-tokens', tenantId, domainId],
    queryFn: () => apiFetch<{ data: CertToken[] }>(`${base(tenantId, domainId)}/cert-tokens`),
  });
  const revoke = useMutation({
    mutationFn: (tokenId: string) =>
      apiFetch<void>(`${base(tenantId, domainId)}/cert-tokens/${tokenId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cert-tokens', tenantId, domainId] }),
  });

  const avail = availability.data?.data;
  const tokens = tokensQuery.data?.data ?? [];

  async function handleDownload() {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}${base(tenantId, domainId)}/ssl-cert/download`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('auth_token') ?? ''}` },
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json() as { error?: { message?: string } };
          if (body?.error?.message) detail = body.error.message;
        } catch { /* non-JSON body — keep the status */ }
        throw new Error(detail);
      }
      const pem = await res.text();
      const url = URL.createObjectURL(new Blob([pem], { type: 'application/x-pem-file' }));
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = `${domainName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'certificate'}.pem`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } finally {
        // Always release it — the blob holds a private key in memory.
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }

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
            disabled={!avail?.available || downloading}
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
                {confirmRevoke === t.id ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={async () => { await revoke.mutateAsync(t.id); setConfirmRevoke(null); }}
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
      </div>
    </div>
  );
}
