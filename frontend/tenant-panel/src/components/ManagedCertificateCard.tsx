import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { useDomainTlsStatus, useReissueCertificate } from '@/hooks/use-tls-status';
import ErrorPanel from '@/components/ErrorPanel';
import TlsReissueProgressModal from '@/components/TlsReissueProgressModal';
import type { CertificateDetail, OperatorError } from '@insula/api-contracts';

/**
 * Managed (automatic) certificate state for one domain.
 *
 * Sits alongside the custom-certificate upload card: that one is about
 * a certificate the tenant supplies, this one is about the certificates
 * the platform obtains for them — including the failures, which used to
 * be invisible everywhere.
 */

interface Props {
  readonly tenantId: string;
  readonly domainId: string;
  readonly canManage: boolean;
}

function stateBadge(state: CertificateDetail['state']) {
  switch (state) {
    case 'issued':
      return {
        label: 'Active',
        Icon: CheckCircle2,
        className: 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300',
      };
    case 'issuing':
      return {
        label: 'Issuing',
        Icon: Loader2,
        className: 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300',
      };
    case 'failed':
      return {
        label: 'Failed',
        Icon: AlertTriangle,
        className: 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300',
      };
    default:
      return {
        label: 'Unknown',
        Icon: ShieldOff,
        className: 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
      };
  }
}

export default function ManagedCertificateCard({ tenantId, domainId, canManage }: Props) {
  const { data, isLoading, isError } = useDomainTlsStatus(tenantId, domainId);
  const reissue = useReissueCertificate(tenantId, domainId);
  const [taskId, setTaskId] = useState<string | null>(null);

  const status = data?.data;

  const handleReissue = async () => {
    try {
      const result = await reissue.mutateAsync();
      setTaskId(result.data.taskId);
    } catch {
      // Rendered from reissue.error below via ErrorPanel.
    }
  };

  // The backend answers a refused reissue with a full OperatorError
  // (cooldown, auto-TLS off, cluster unreachable) — render it rather
  // than a bare toast, so the reason and the fix arrive together.
  const operatorError = (reissue.error as { body?: { error?: { details?: { operatorError?: OperatorError } } } } | null)
    ?.body?.error?.details?.operatorError;

  return (
    <div
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm"
      data-testid="managed-certificate-card"
    >
      <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Managed Certificates</h2>
        {canManage && (
          <button
            type="button"
            onClick={handleReissue}
            disabled={reissue.isPending || Boolean(status?.reissueAvailableAt)}
            title={
              status?.reissueAvailableAt
                ? `Available again at ${new Date(status.reissueAvailableAt).toLocaleTimeString()}`
                : 'Request a new certificate now'
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="reissue-cert-button"
          >
            {reissue.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Request Certificate
          </button>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={20} className="animate-spin text-blue-600" />
        </div>
      )}

      {isError && (
        <div className="px-5 py-6 text-center text-sm text-red-500 dark:text-red-400" data-testid="tls-status-error">
          Failed to load certificate status.
        </div>
      )}

      {status && (
        <div className="space-y-4 px-5 py-4">
          {operatorError && (
            <ErrorPanel error={operatorError} testId="reissue-error" onRetry={handleReissue} retryPending={reissue.isPending} />
          )}

          {status.fallbackActive && (
            <div
              className="flex items-start gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
              data-testid="tls-fallback-notice"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                The wildcard certificate for this domain could not be issued, so each hostname is using its own
                certificate. Your sites stay secure — new subdomains just need their own certificate until the
                wildcard succeeds. We keep retrying it.
              </span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-500 dark:text-gray-400">Wildcard coverage:</span>
            {status.wildcardCapable ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-50 dark:bg-green-900/20 px-2 py-0.5 text-xs font-medium text-green-700 dark:text-green-300">
                <ShieldCheck size={11} />
                Available
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300">
                <ShieldOff size={11} />
                Not available
              </span>
            )}
          </div>
          {status.wildcardBlockedReason && (
            <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="wildcard-blocked-reason">
              {status.wildcardBlockedReason}
            </p>
          )}

          {status.certificates.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="no-managed-certs">
              No managed certificate yet. One is requested automatically as soon as a hostname on this domain is
              routed to a workload.
            </p>
          )}

          <ul className="space-y-3" data-testid="managed-cert-list">
            {status.certificates.map((cert) => {
              const badge = stateBadge(cert.state);
              return (
                <li
                  key={cert.name}
                  className="rounded-lg border border-gray-100 dark:border-gray-700 px-3 py-3"
                  data-testid={`managed-cert-${cert.name}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-sm text-gray-900 dark:text-gray-100">
                      {cert.dnsNames.join(', ')}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
                    >
                      <badge.Icon size={11} className={cert.state === 'issuing' ? 'animate-spin' : undefined} />
                      {badge.label}
                    </span>
                  </div>
                  <dl className="mt-2 grid grid-cols-1 gap-1 text-xs text-gray-500 dark:text-gray-400 sm:grid-cols-2">
                    <div>
                      <dt className="inline font-medium">Issuer: </dt>
                      <dd className="inline font-mono">{cert.issuerName ?? 'unknown'}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium">Expires: </dt>
                      <dd className="inline">
                        {cert.expiresAt ? new Date(cert.expiresAt).toLocaleDateString() : '—'}
                      </dd>
                    </div>
                  </dl>
                  {cert.state !== 'issued' && cert.message && (
                    <p
                      className="mt-2 rounded bg-gray-50 dark:bg-gray-900/40 px-2 py-1 font-mono text-xs text-gray-600 dark:text-gray-300"
                      data-testid={`managed-cert-message-${cert.name}`}
                    >
                      {cert.message}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {taskId && <TlsReissueProgressModal taskId={taskId} onClose={() => setTaskId(null)} />}
    </div>
  );
}
