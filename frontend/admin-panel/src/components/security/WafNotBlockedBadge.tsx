/**
 * "Not blocked" on a WAF event: the route was in detection-only mode, or the
 * WAF let the request through for a reason it recorded — the platform
 * allowlist, one of the route's trusted IPs, a score below the threshold.
 */
import clsx from 'clsx';
import { WAF_PASS_REASON_HELP, WAF_PASS_REASON_LABEL, type WafPassReason } from '@insula/api-contracts';

export function WafNotBlockedBadge({ detectionOnly, passReason, testId, className }: {
  readonly detectionOnly: boolean;
  readonly passReason: WafPassReason | null;
  readonly testId?: string;
  readonly className?: string;
}) {
  if (!detectionOnly && passReason === null) return null;
  return (
    <span
      className={clsx(
        'inline-flex rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
        className,
      )}
      title={detectionOnly || passReason === null
        ? "The route's WAF is in detection-only mode: this request was logged, not blocked"
        : WAF_PASS_REASON_HELP[passReason]}
      data-testid={testId}
    >
      {detectionOnly || passReason === null ? 'Detected · not blocked' : `Not blocked · ${WAF_PASS_REASON_LABEL[passReason]}`}
    </span>
  );
}
