import clsx from 'clsx';
import type { ApplicationUsage } from '@insula/api-contracts';
import { applicationRoom } from '@/hooks/use-application-usage';

/**
 * "3 / 5 applications" — the subscription's application limit at a glance.
 * Amber once full, red when over (a plan was lowered). Stopped applications
 * and private workers count; deleted applications and revoked workers do
 * not, which the tooltip says along with how many of the count are workers.
 */
export default function ApplicationUsagePill({ usage }: { readonly usage: ApplicationUsage | undefined }) {
  if (!usage) return null;
  const { atLimit, over } = applicationRoom(usage);
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium',
        over
          ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300'
          : atLimit
            ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
            : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300',
      )}
      title={applicationUsageTitle(usage)}
      data-testid="applications-usage"
    >
      {usage.current} / {usage.limit} applications deployed
    </span>
  );
}

/** The pill's tooltip: what counts, and how much of the count is private workers. Pure. */
export function applicationUsageTitle(usage: ApplicationUsage): string {
  const rule = 'Stopped applications and private workers count; deleted applications and revoked workers do not.';
  // `?? 0`: an API from before the field (a rolling upgrade) leaves it out.
  const workers = usage.privateWorkers ?? 0;
  if (workers === 0) return `Applications your subscription allows. ${rule}`;
  const apps = usage.current - workers;
  const parts = `${apps} application${apps === 1 ? '' : 's'} and ${workers} private worker${workers === 1 ? '' : 's'}`;
  return `${parts} of the ${usage.limit} your subscription allows. ${rule}`;
}

/** The sentence under the heading once the limit is reached. */
export function applicationLimitNotice(usage: ApplicationUsage): string {
  if (usage.limit === 0) return 'Your subscription does not include applications. Contact your provider to have them added.';
  const base = `You have deployed ${usage.current} of the ${usage.limit} application${usage.limit === 1 ? '' : 's'} your subscription allows`;
  return usage.current > usage.limit
    ? `${base} — more than it allows now. Everything you have keeps running; to deploy, restore or add a private worker, delete ${usage.current - usage.limit + 1} you no longer need, or upgrade your plan.`
    : `${base}. Stopped applications and private workers count too. To deploy, restore or add a private worker, delete one you no longer need, or upgrade your plan.`;
}
