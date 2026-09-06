/**
 * Warns when a channel that categories route to has no usable transport.
 *
 * A channel with no enabled default platform provider does not fail loudly:
 * the dispatcher queues the delivery, the queue worker retries it six times,
 * and it lands in the dead-letter queue with `no_default_notification_provider`.
 * Nothing on this page said so, and nothing in the alert itself can — a channel
 * that cannot deliver also cannot deliver the news that it cannot deliver.
 *
 * Only channels that need a transport are checked; `in_app` is written straight
 * to the notifications table by the dispatcher and needs no provider.
 */
import { AlertTriangle } from 'lucide-react';
import { NOTIFICATION_CHANNEL_ID, type NotificationChannelId } from '@insula/api-contracts';
import { useNotificationProviders } from '@/hooks/use-notification-providers';
import { useNotificationCategories } from '@/hooks/use-notification-categories';

/**
 * Total over the channel enum on purpose: adding a channel to the contract
 * without deciding whether it needs a transport becomes a compile error here,
 * rather than a channel that silently never warns.
 */
const NEEDS_PROVIDER: Record<NotificationChannelId, boolean> = {
  in_app: false,
  email: true,
  ntfy: true,
};

const CHANNEL_LABEL: Record<NotificationChannelId, string> = {
  in_app: 'In-app',
  email: 'Email',
  ntfy: 'ntfy push',
};

export default function ProviderCoverageBanner() {
  const providers = useNotificationProviders();
  const categories = useNotificationCategories();

  // Never render on error: a banner computed from a failed fetch would either
  // invent a problem or, worse, imply coverage that was never checked. The
  // tables below surface their own load errors.
  if (providers.isError || categories.isError) return null;
  if (!providers.data?.data || !categories.data?.data) return null;

  const providerRows = providers.data.data;
  const categoryRows = categories.data.data;

  // Mirrors getDefaultProviderRow() in the backend exactly — platform scope,
  // is_default, enabled. A provider that is merely PRESENT does not deliver.
  const hasUsableProvider = (channel: NotificationChannelId): boolean =>
    providerRows.some((p) => p.channel === channel
      && p.scope === 'platform'
      && p.isDefault
      && p.enabled);

  const routedTo = (channel: NotificationChannelId): number =>
    categoryRows.filter((c) => c.defaultChannels.includes(channel)).length;

  const broken = NOTIFICATION_CHANNEL_ID
    .filter((c) => NEEDS_PROVIDER[c])
    .map((c) => ({ channel: c, categories: routedTo(c) }))
    .filter((x) => x.categories > 0 && !hasUsableProvider(x.channel));

  if (broken.length === 0) return null;

  return (
    <div
      data-testid="provider-coverage-banner"
      className="mb-4 flex items-start gap-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium">
          {broken.length === 1
            ? 'One channel cannot deliver'
            : `${broken.length} channels cannot deliver`}
        </p>
        <ul className="list-inside list-disc space-y-0.5">
          {broken.map(({ channel, categories: count }) => (
            <li key={channel}>
              <strong>{CHANNEL_LABEL[channel]}</strong> is enabled on {count}
              {count === 1 ? ' category' : ' categories'} but has no enabled default
              provider. Those notifications retry and then dead-letter with
              <code className="mx-1 rounded bg-amber-100 px-1 dark:bg-amber-950/60">
                no_default_notification_provider
              </code>
              .
            </li>
          ))}
        </ul>
        <p>
          Add a provider under <strong>Providers</strong> and mark it default, or turn the
          channel off for those categories. Past failures are listed under{' '}
          <strong>Deliveries</strong>.
        </p>
      </div>
    </div>
  );
}
