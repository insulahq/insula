/**
 * Monitoring — traffic and resource usage in one place.
 *
 * This page was "Resource Usage". Traffic belongs beside it rather than in a
 * page of its own: both answer "what is my account doing", and the allowance
 * at the top of the Traffic tab is metered from the same wire the Resource
 * tab reports on.
 *
 * `/resource-usage` still resolves: App.tsx redirects it to
 * `/monitoring/resource-usage`, so bookmarks and older links land on the tab
 * they meant instead of a 404, and this page keeps one canonical URL.
 */

import { Activity } from 'lucide-react';
import clsx from 'clsx';
import TenantTrafficTab from '@/components/traffic/TenantTrafficTab';
import ResourceUsage from './ResourceUsage';
import { useTabParam } from '@/hooks/use-tab-param';
import type { TabOf } from '@/routes/tabbed-pages';

type Tab = TabOf<'/monitoring'>;

const TABS: ReadonlyArray<{ key: Tab; label: string }> = [
  { key: 'traffic', label: 'Traffic' },
  { key: 'resource-usage', label: 'Resource Usage' },
];

export default function Monitoring() {
  const [activeTab, setActiveTab] = useTabParam('/monitoring');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Activity size={28} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="monitoring-heading">
          Monitoring
        </h1>
      </div>

      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex gap-1" aria-label="Monitoring sections">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              aria-current={activeTab === tab.key ? 'page' : undefined}
              data-testid={`monitoring-tab-${tab.key}`}
              className={clsx(
                'px-5 py-3 text-sm font-medium',
                activeTab === tab.key
                  ? 'border-b-2 border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-b-2 border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300',
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'traffic' && <TenantTrafficTab />}
      {activeTab === 'resource-usage' && <ResourceUsage embedded />}
    </div>
  );
}
