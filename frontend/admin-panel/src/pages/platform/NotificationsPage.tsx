/**
 * Platform → Notifications — top-level operator surface for the
 * notification-system Phase 1 feature.
 *
 * Three tabs:
 *   - Categories    — taxonomy of notification kinds; channels + rate limit
 *   - Templates     — Handlebars sources keyed by (category, channel, locale)
 *   - Delivery Log  — per-channel outcomes for audit / triage
 *
 * Mirrors the WebDefensePage tab pattern (query-string-backed active tab,
 * panels keyed by id).
 */

import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bell } from 'lucide-react';
import clsx from 'clsx';
import CategoriesTable from '@/features/notifications/CategoriesTable';
import TemplatesTable from '@/features/notifications/TemplatesTable';
import DeliveryLogTable from '@/features/notifications/DeliveryLogTable';

type TabId = 'categories' | 'templates' | 'deliveries';

const TABS: ReadonlyArray<{ readonly id: TabId; readonly label: string; readonly hint: string }> = [
  { id: 'categories', label: 'Categories', hint: 'Taxonomy of notification kinds + default channels' },
  { id: 'templates', label: 'Templates', hint: 'Operator-editable Handlebars templates per (category, channel, locale)' },
  { id: 'deliveries', label: 'Delivery Log', hint: 'Per-channel delivery outcomes for audit + triage' },
];

const VALID_TABS: ReadonlySet<TabId> = new Set<TabId>(['categories', 'templates', 'deliveries']);

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
          Configure how and when the platform notifies tenants and operators. Categories define the
          taxonomy + default channels; Templates are the Handlebars sources used by the renderer;
          Delivery Log surfaces per-channel outcomes for audit + triage.
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
        {activeTab === 'templates' && <TemplatesTable />}
        {activeTab === 'deliveries' && <DeliveryLogTable />}
      </div>
    </div>
  );
}
