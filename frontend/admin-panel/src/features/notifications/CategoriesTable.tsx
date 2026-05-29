/**
 * Notification Sources table — Platform → Notifications → Sources.
 *
 * Lists every notification source (`notification_categories` row — the
 * table name stays for backward compatibility; the operator-facing label
 * is "Source"). Operator can override defaultChannels + rate limit per
 * source. Mandatory sources render with a lock icon and channel
 * checkboxes are disabled (the backend dispatcher enforces mandatory
 * on in_app + email regardless, but the disabled UI prevents confusion).
 *
 * Editing is in a right-drawer panel — same UX shape the operator
 * already knows from the Tenant Lifecycle and WAF Exclusions surfaces.
 */

import { useMemo, useState } from 'react';
import { Lock, Loader2, Save, X } from 'lucide-react';
import {
  useNotificationCategories,
  useUpdateNotificationCategory,
} from '@/hooks/use-notification-categories';
import {
  NOTIFICATION_CHANNEL_ID,
  type NotificationCategoryResponse,
  type NotificationChannelId,
  type UpdateNotificationCategoryInput,
} from '@k8s-hosting/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

const SEVERITY_BADGE: Record<NotificationCategoryResponse['defaultSeverity'], string> = {
  info: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  error: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  critical: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
};

const AUDIENCE_BADGE: Record<NotificationCategoryResponse['audience'], string> = {
  tenant: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300',
  admin: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/40 dark:text-fuchsia-300',
  system: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

function ChannelBadges({ channels }: { readonly channels: ReadonlyArray<NotificationChannelId> }) {
  if (channels.length === 0) {
    return <span className="text-xs text-gray-400">none</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {channels.map((c) => (
        <span
          key={c}
          className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
        >
          {c}
        </span>
      ))}
    </div>
  );
}

export default function CategoriesTable() {
  const list = useNotificationCategories();
  const [editing, setEditing] = useState<NotificationCategoryResponse | null>(null);

  return (
    <div className="space-y-4">
      {list.error && (
        <ErrorPanel
          error={extractOperatorError(list.error)}
          severity="error"
          testId="categories-list-error"
        />
      )}

      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="border-b border-gray-200 px-4 py-2 dark:border-gray-700">
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Sources ({list.data?.data.length ?? 0})
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-500 dark:text-gray-400">
              <tr className="border-b border-gray-200/60 dark:border-gray-700/40">
                <th className="px-4 py-2 text-left">ID</th>
                <th className="px-4 py-2 text-left">Display Name</th>
                <th className="px-4 py-2 text-left">Audience</th>
                <th className="px-4 py-2 text-left">Severity</th>
                <th className="px-4 py-2 text-left">Default Channels</th>
                <th className="px-4 py-2 text-left">Mandatory</th>
                <th className="px-4 py-2 text-left">GDPR Basis</th>
                <th className="px-4 py-2 text-left">Rate Limit</th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading && (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-gray-500">
                    <Loader2 size={16} className="mx-auto animate-spin" />
                  </td>
                </tr>
              )}
              {!list.isLoading && (list.data?.data.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-3 text-center text-gray-500">
                    No notification sources defined.
                  </td>
                </tr>
              )}
              {list.data?.data.map((cat) => (
                <tr
                  key={cat.id}
                  className="cursor-pointer border-t border-gray-200/60 hover:bg-gray-50 dark:border-gray-700/40 dark:hover:bg-gray-700/30"
                  data-testid={`category-row-${cat.id}`}
                  onClick={() => setEditing(cat)}
                >
                  <td className="px-4 py-2 font-mono text-gray-900 dark:text-gray-100">{cat.id}</td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">
                    <div>{cat.displayName}</div>
                    {cat.description && (
                      <div className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
                        {cat.description}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${AUDIENCE_BADGE[cat.audience]}`}>
                      {cat.audience}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_BADGE[cat.defaultSeverity]}`}>
                      {cat.defaultSeverity}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <ChannelBadges channels={cat.defaultChannels} />
                  </td>
                  <td className="px-4 py-2">
                    {cat.isMandatory && (
                      <span title="Mandatory — users cannot opt out" className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                        <Lock size={12} /> mandatory
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{cat.gdprBasis}</td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">
                    {cat.rateLimitMax !== null && cat.rateLimitWindowS !== null
                      ? `${cat.rateLimitMax} / ${cat.rateLimitWindowS}s`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editing && (
        <CategoryEditDrawer
          category={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

interface CategoryEditDrawerProps {
  readonly category: NotificationCategoryResponse;
  readonly onClose: () => void;
}

function CategoryEditDrawer({ category, onClose }: CategoryEditDrawerProps) {
  const update = useUpdateNotificationCategory();
  const [channels, setChannels] = useState<ReadonlyArray<NotificationChannelId>>(category.defaultChannels);
  const [rateLimitMax, setRateLimitMax] = useState<string>(
    category.rateLimitMax !== null ? String(category.rateLimitMax) : '',
  );
  const [rateLimitWindowS, setRateLimitWindowS] = useState<string>(
    category.rateLimitWindowS !== null ? String(category.rateLimitWindowS) : '',
  );
  const [isActive, setIsActive] = useState<boolean>(category.isActive);

  const toggleChannel = (ch: NotificationChannelId): void => {
    setChannels((prev) =>
      prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch],
    );
  };

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const input: UpdateNotificationCategoryInput = {
      defaultChannels: channels.slice(),
      isActive,
    };
    if (rateLimitMax.trim() === '' && rateLimitWindowS.trim() === '') {
      input.rateLimitMax = null;
      input.rateLimitWindowS = null;
    } else if (rateLimitMax.trim() !== '' && rateLimitWindowS.trim() !== '') {
      const max = Number.parseInt(rateLimitMax, 10);
      const win = Number.parseInt(rateLimitWindowS, 10);
      if (Number.isFinite(max) && Number.isFinite(win)) {
        input.rateLimitMax = max;
        input.rateLimitWindowS = win;
      }
    }
    try {
      await update.mutateAsync({ id: category.id, input });
      onClose();
    } catch {
      // surfaced via ErrorPanel below
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      data-testid="category-edit-drawer"
      onKeyDown={onKeyDown}
    >
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <div className="flex h-full w-full max-w-md flex-col overflow-y-auto bg-white dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Edit Source — {category.displayName}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={onSubmit} className="flex-1 space-y-4 p-4">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">ID</p>
            <p className="font-mono text-xs text-gray-800 dark:text-gray-200">{category.id}</p>
          </div>

          {category.isMandatory && (
            <div className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
              <Lock size={12} className="mt-0.5 shrink-0" />
              <span>
                This category is mandatory — the dispatcher will deliver it regardless of per-user
                opt-out. You can still toggle channels here, but disabling all channels is not
                recommended.
              </span>
            </div>
          )}

          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-gray-700 dark:text-gray-200">
              Default Channels
            </legend>
            {NOTIFICATION_CHANNEL_ID.map((ch) => (
              <label key={ch} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                <input
                  type="checkbox"
                  checked={channels.includes(ch)}
                  onChange={() => toggleChannel(ch)}
                  data-testid={`channel-checkbox-${ch}`}
                  className="rounded"
                />
                {ch}
              </label>
            ))}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-gray-700 dark:text-gray-200">
              Rate Limit (leave both blank to disable)
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-gray-600 dark:text-gray-300">
                Max
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={rateLimitMax}
                  onChange={(e) => setRateLimitMax(e.target.value)}
                  data-testid="rate-limit-max"
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </label>
              <label className="text-xs text-gray-600 dark:text-gray-300">
                Window (s)
                <input
                  type="number"
                  min={1}
                  max={86400}
                  value={rateLimitWindowS}
                  onChange={(e) => setRateLimitWindowS(e.target.value)}
                  data-testid="rate-limit-window"
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </label>
            </div>
          </fieldset>

          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              data-testid="category-active"
              className="rounded"
            />
            Active
          </label>

          {update.error && (
            <ErrorPanel
              error={extractOperatorError(update.error)}
              severity="error"
              testId="category-edit-error"
              compact
            />
          )}

          <div className="flex items-center justify-end gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={update.isPending}
              data-testid="category-save"
              className="inline-flex items-center gap-1 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {update.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
