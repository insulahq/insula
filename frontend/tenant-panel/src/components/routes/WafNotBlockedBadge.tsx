/**
 * "Not blocked" on a WAF event: the route was in detection-only mode, or the
 * WAF let the request through for a reason it recorded (the platform
 * allowlist, one of the route's trusted IPs, a score below the threshold).
 * Without it, an allowlisted workstation's requests looked exactly like
 * blocks.
 */
import clsx from 'clsx';
import { WAF_PASS_REASON_HELP, WAF_PASS_REASON_LABEL, type WafPassReason } from '@insula/api-contracts';

const TONE = {
  // The event list's console-style table, dark in both themes.
  console: 'bg-sky-900/60 text-sky-200',
  panel: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
} as const;

export function WafNotBlockedBadge({ detectionOnly, passReason, tone = 'console', testId, className }: {
  readonly detectionOnly: boolean;
  readonly passReason: WafPassReason | null;
  readonly tone?: keyof typeof TONE;
  readonly testId?: string;
  readonly className?: string;
}) {
  if (!detectionOnly && passReason === null) return null;
  // Detection-only mode says it first: on such a route nothing is blocked anyway.
  const label = detectionOnly ? 'detected · not blocked' : `not blocked · ${WAF_PASS_REASON_LABEL[passReason!]}`;
  const title = detectionOnly
    ? 'Logged in detection-only mode: this request was not blocked'
    : WAF_PASS_REASON_HELP[passReason!];
  return (
    <span
      className={clsx('inline-flex rounded px-1.5 py-0.5 text-[10px] font-bold uppercase whitespace-nowrap', TONE[tone], className)}
      title={title}
      data-testid={testId}
    >
      {label}
    </span>
  );
}
