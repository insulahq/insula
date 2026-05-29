/**
 * Platform → Notifications — top-level operator surface.
 *
 * The mental model is Sources × Providers:
 *   - Sources       — what TRIGGERS a notification (one entry per event
 *                     taxonomy, persisted in notification_categories;
 *                     the table name stays for stability — internal IDs
 *                     remain `category_id`, only the operator label
 *                     changes).
 *   - Templates     — Handlebars sources keyed by (source, channel, locale).
 *   - Delivery Log  — per-channel delivery outcomes for audit + triage.
 *   - Providers     — transport endpoints (today: SMTP relays; tomorrow:
 *                     SMS providers, webhooks). Surfaced via the existing
 *                     /admin/email/smtp-relays endpoints.
 *
 * The tab URL parameter stays `categories` so existing direct links keep
 * working; the label that operators see is "Sources".
 */

import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bell } from 'lucide-react';
import clsx from 'clsx';
import CategoriesTable from '@/features/notifications/CategoriesTable';
import TemplatesTable from '@/features/notifications/TemplatesTable';
import DeliveryLogTable from '@/features/notifications/DeliveryLogTable';
import ProvidersTable from '@/features/notifications/ProvidersTable';

type TabId = 'categories' | 'providers' | 'templates' | 'deliveries';

const TABS: ReadonlyArray<{ readonly id: TabId; readonly label: string; readonly hint: string }> = [
  { id: 'categories', label: 'Sources', hint: 'What triggers a notification: per-event source + default channels + rate limit' },
  { id: 'providers', label: 'Providers', hint: 'SMTP transport endpoints used by the dispatcher (Stalwart, Postmark, Brevo, ...)' },
  { id: 'templates', label: 'Templates', hint: 'Operator-editable Handlebars templates per (source, channel, locale)' },
  { id: 'deliveries', label: 'Delivery Log', hint: 'Per-channel delivery outcomes for audit + triage' },
];

const VALID_TABS: ReadonlySet<TabId> = new Set<TabId>(['categories', 'providers', 'templates', 'deliveries']);

export default function NotificationsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const activeTab: TabId = useMemo(() => {
    if (requested && VALID_TABS.has(requested as TabId)) return requested as TabId;
    return 'categories';
  }, [requested]);
  const setActiveTab = (id: TabId): void => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <Bell size={24} className="text-brand-600 dark:text-brand-400" />
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Notifications</h1>
        </div>
        <p className="max-w-3xl text-sm text-gray-600 dark:text-gray-400">
          Configure how and when the platform notifies tenants and operators.{' '}
          <strong>Sources</strong> are the events that trigger a notification (security, subscription,
          tenant lifecycle, backups…). <strong>Providers</strong> are the transports that deliver
          them (SMTP relays today). Templates render the body; the delivery log surfaces per-channel
          outcomes for audit and triage.
        </p>
      </header>

      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700" role="tablist">
        {TABS.map(({ id, label, hint }) => {
          const isActive = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`notifications-panel-${id}`}
              id={`notifications-tab-${id}`}
              data-testid={`tab-${id}`}
              title={hint}
              onClick={() => setActiveTab(id)}
              className={clsx(
                '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`notifications-panel-${activeTab}`}
        aria-labelledby={`notifications-tab-${activeTab}`}
      >
        {activeTab === 'categories' && <CategoriesTable />}
        {activeTab === 'providers' && <ProvidersTable />}
        {activeTab === 'templates' && <TemplatesTable />}
        {activeTab === 'deliveries' && <DeliveryLogTable />}
      </div>
    </div>
  );
}
