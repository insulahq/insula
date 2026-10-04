import { AlertCircle, Info } from 'lucide-react';
import type { DnsApexDriftReport } from '@insula/api-contracts';

interface DnsApexDriftBannerProps {
  readonly report: DnsApexDriftReport | null | undefined;
  readonly onReview: () => void;
}

/**
 * Drift banner for the DNS settings page.
 *
 * Shown for three distinct conditions, which must not be collapsed into one
 * message:
 *   - drift  — route records are missing or stale; repair is available
 *   - error  — zones could not be read, so drift cannot be ruled out
 *   - scanError — the scan could not run at all (no ingress IPs configured)
 *
 * Silent when the last scan was clean. Foreign and held records alone never
 * raise the banner: an extra address is usually deliberate (a CDN origin) and
 * the repair never removes either — information, not a problem.
 */
export default function DnsApexDriftBanner({ report, onReview }: DnsApexDriftBannerProps) {
  if (!report) return null;

  if (report.scanError) {
    return (
      <div
        className="mb-4 flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        role="alert"
        data-testid="dns-apex-drift-banner-scan-error"
      >
        <Info size={20} className="mt-0.5 flex-shrink-0" />
        <div className="text-sm">
          <p className="font-semibold">Apex DNS drift could not be evaluated</p>
          <p className="mt-1">{report.scanError}</p>
        </div>
      </div>
    );
  }

  const hasDrift = report.driftCount > 0;
  const hasErrors = report.errorCount > 0;
  if (!hasDrift && !hasErrors) return null;

  const palette = hasDrift
    ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
    : 'border-gray-300 bg-gray-50 text-gray-900 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-200';

  return (
    <div
      className={`mb-4 flex items-start gap-3 rounded-md border px-4 py-3 ${palette}`}
      role="alert"
      data-testid="dns-apex-drift-banner"
    >
      <AlertCircle size={20} className="mt-0.5 flex-shrink-0" />
      <div className="flex-1 text-sm">
        {hasDrift && (
          <p className="font-semibold">
            {report.driftCount} domain{report.driftCount === 1 ? '' : 's'} with route DNS that no longer
            matches the ingress servers
          </p>
        )}
        {!hasDrift && hasErrors && (
          <p className="font-semibold">
            {report.errorCount} zone{report.errorCount === 1 ? '' : 's'} could not be read
          </p>
        )}
        <p className="mt-1">
          {hasDrift && (
            <>
              {report.missingCount > 0 && <>{report.missingCount} address record{report.missingCount === 1 ? ' is' : 's are'} missing, so new servers get no visitors. </>}
              {report.staleCount > 0 && <>{report.staleCount} still point{report.staleCount === 1 ? 's' : ''} at servers that were removed or no longer serve ingress. </>}
            </>
          )}
          {hasErrors && (
            <>
              {report.errorCount} zone{report.errorCount === 1 ? '' : 's'} could not be read, so
              drift there is unknown.{' '}
            </>
          )}
          Nothing changes until you apply the repair.
        </p>
        <button
          type="button"
          onClick={onReview}
          className="mt-2 inline-flex items-center rounded-md border border-current/30 px-3 py-1.5 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10"
          data-testid="dns-apex-drift-review-button"
        >
          Review drift
        </button>
      </div>
    </div>
  );
}
