/**
 * Notification Templates table — Platform → Notifications → Templates.
 *
 * Filterable list of every template (category × channel × locale row
 * count is small in Phase 1). Click a row to open <TemplateEditor>.
 *
 * Filter chips are stateless deltas — toggle a chip and the query
 * refetches; no extra Apply button.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useNotificationTemplates } from '@/hooks/use-notification-templates';
import { useNotificationCategories } from '@/hooks/use-notification-categories';
import {
  NOTIFICATION_CHANNEL_ID,
  type NotificationChannelId,
} from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import TemplateEditor from './TemplateEditor';

export default function TemplatesTable() {
  const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
  const [channel, setChannel] = useState<NotificationChannelId | undefined>(undefined);
  const [openTemplateId, setOpenTemplateId] = useState<string | null>(null);

  const list = useNotificationTemplates({ categoryId, channel });
  const categories = useNotificationCategories();

  return (
    <div className="space-y-4">
      {/* Filter chips */}
      <section className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3 text-xs dark:border-gray-700 dark:bg-gray-800">
        <span className="text-gray-500 dark:text-gray-400">Filter:</span>
        <label className="flex items-center gap-1">
          <span className="text-gray-600 dark:text-gray-300">Category</span>
          <select
            value={categoryId ?? ''}
            onChange={(e) => setCategoryId(e.target.value || undefined)}
            data-testid="filter-category"
            className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">all</option>
            {categories.data?.data.map((c) => (
              <option key={c.id} value={c.id}>{c.displayName} ({c.id})</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-600 dark:text-gray-300">Channel</span>
          <select
            value={channel ?? ''}
            onChange={(e) => setChannel((e.target.value || undefined) as NotificationChannelId | undefined)}
            data-testid="filter-channel"
            className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">all</option>
            {NOTIFICATION_CHANNEL_ID.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        {(categoryId || channel) && (
          <button
            type="button"
            onClick={() => {
              setCategoryId(undefined);
              setChannel(undefined);
            }}
            className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
            data-testid="filter-clear"
          >
            Clear
          </button>
        )}
      </section>

      {list.error && (
        <ErrorPanel
          error={extractOperatorError(list.error)}
          severity="error"
          testId="templates-list-error"
        />
      )}

      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="border-b border-gray-200 px-4 py-2 dark:border-gray-700">
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Templates ({list.data?.data.length ?? 0})
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-500 dark:text-gray-400">
              <tr className="border-b border-gray-200/60 dark:border-gray-700/40">
                <th className="px-4 py-2 text-left">Category</th>
                <th className="px-4 py-2 text-left">Channel</th>
                <th className="px-4 py-2 text-left">Locale</th>
                <th className="px-4 py-2 text-left">Format</th>
                <th className="px-4 py-2 text-left">Version</th>
                <th className="px-4 py-2 text-left">Source</th>
                <th className="px-4 py-2 text-left">Updated</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-gray-500">
                    <Loader2 size={16} className="mx-auto animate-spin" />
                  </td>
                </tr>
              )}
              {!list.isLoading && (list.data?.data.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-3 text-center text-gray-500">
                    No templates match the current filters.
                  </td>
                </tr>
              )}
              {list.data?.data.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => setOpenTemplateId(t.id)}
                  className="cursor-pointer border-t border-gray-200/60 hover:bg-gray-50 dark:border-gray-700/40 dark:hover:bg-gray-700/30"
                  data-testid={`template-row-${t.id}`}
                >
                  <td className="px-4 py-2 font-mono text-gray-900 dark:text-gray-100">{t.categoryId}</td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{t.channel}</td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{t.locale}</td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{t.bodyFormat}</td>
                  <td className="px-4 py-2 tabular-nums text-gray-700 dark:text-gray-200">v{t.version}</td>
                  <td className="px-4 py-2">
                    {t.isSeed ? (
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
                        seed
                      </span>
                    ) : (
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                        edited
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-500 dark:text-gray-400">
                    {new Date(t.updatedAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {openTemplateId && (
        <TemplateEditor
          templateId={openTemplateId}
          onClose={() => setOpenTemplateId(null)}
        />
      )}
    </div>
  );
}
