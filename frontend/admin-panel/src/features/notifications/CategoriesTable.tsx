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
import { Lock, Loader2, Save, X, Search, Power, PowerOff } from 'lucide-react';
import {
  useNotificationCategories,
  useUpdateNotificationCategory,
} from '@/hooks/use-notification-categories';
import { useNotificationProviders } from '@/hooks/use-notification-providers';
import {
  NOTIFICATION_CHANNEL_ID,
  type NotificationCategoryResponse,
  type NotificationChannelId,
  type UpdateNotificationCategoryInput,
  type OperatorError,
  OPERATOR_ERROR_CODES,
} from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import BulkActionBar, { SelectCheckbox } from '@/components/ui/BulkActionBar';
import SortableHeader from '@/components/ui/SortableHeader';
import { useSelection } from '@/hooks/use-selection';
import { useSortable } from '@/hooks/use-sortable';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
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

/**
 * Human labels for the channel ids, used in the bulk-action dropdowns and
 * result summaries. Built as a `Record` over the enum so a newly added
 * channel is a compile error here rather than an unlabelled dropdown entry.
 */
const CHANNEL_LABEL: Record<NotificationChannelId, string> = {
  in_app: 'In-App',
  email: 'Email',
  ntfy: 'ntfy',
};

interface ChannelBulkSelectProps {
  readonly label: string;
  readonly testId: string;
  readonly onPick: (channel: NotificationChannelId) => void;
}

/** Dropdown that fires once on pick and immediately resets to its placeholder,
 *  so picking the same channel twice in a row still fires. */
function ChannelBulkSelect({ label, testId, onPick }: ChannelBulkSelectProps) {
  return (
    <select
      value=""
      aria-label={label}
      data-testid={testId}
      onChange={(e) => {
        const value = e.target.value as NotificationChannelId | '';
        e.target.value = '';
        if (value !== '') onPick(value);
      }}
      className="rounded border border-gray-600 bg-gray-800 px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700"
    >
      <option value="">{label}…</option>
      {NOTIFICATION_CHANNEL_ID.map((c) => (
        <option key={c} value={c}>
          {CHANNEL_LABEL[c]}
        </option>
      ))}
    </select>
  );
}

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
  const update = useUpdateNotificationCategory();
  const [editing, setEditing] = useState<NotificationCategoryResponse | null>(null);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 200);
  const [bulkError, setBulkError] = useState<OperatorError | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState<string | null>(null);

  const all = useMemo(() => list.data?.data ?? [], [list.data]);

  // Search covers everything visible in a row. An operator hunting for
  // "the ones that page me" is as likely to type a channel or an audience as
  // a name, and matching only the name would quietly return nothing.
  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter((c) => [
      c.id,
      c.displayName,
      c.description ?? '',
      c.audience,
      c.defaultSeverity,
      c.gdprBasis,
      c.defaultChannels.join(' '),
      c.isMandatory ? 'mandatory' : '',
      c.isActive ? 'active' : 'inactive',
    ].join(' ').toLowerCase().includes(q));
  }, [all, debouncedQuery]);

  const { sortedData, sortKey, sortDirection, onSort } = useSortable(filtered, 'id');
  const selection = useSelection<{ id: string }>(debouncedQuery);
  // Mandatory sources cannot be edited, so they must not be selectable —
  // otherwise "5 selected" silently means "4 will change".
  const selectable = useMemo(() => sortedData.filter((c) => !c.isMandatory), [sortedData]);
  const selectedRows = useMemo(
    () => selectable.filter((c) => selection.isSelected(c.id)),
    [selectable, selection],
  );

  /**
   * Apply one PATCH per selected source, SEQUENTIALLY.
   *
   * Not `Promise.all(rows.map(...))`: that fires N concurrent writes at a
   * rate-limited endpoint and, worse, rejects on the first failure while the
   * rest keep going — leaving a partial write the operator never sees. Here
   * each row is awaited, failures are collected, and the summary says exactly
   * how many changed.
   */
  const applyBulk = async (
    label: string,
    build: (c: NotificationCategoryResponse) => UpdateNotificationCategoryInput | null,
  ) => {
    setBulkError(null);
    setBulkNote(null);
    setBulkBusy(true);
    let changed = 0;
    let skipped = 0;
    const failures: string[] = [];
    for (const cat of selectedRows) {
      const input = build(cat);
      if (input === null) { skipped += 1; continue; }
      try {
        await update.mutateAsync({ id: cat.id, input });
        changed += 1;
      } catch (err) {
        failures.push(`${cat.id}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }
    setBulkBusy(false);
    if (failures.length > 0) {
      setBulkError({
        code: OPERATOR_ERROR_CODES.BULK_PARTIAL_FAILURE,
        title: `${label}: ${failures.length} of ${selectedRows.length} source(s) failed`,
        detail: `${changed} source(s) were updated successfully. The rest were left unchanged — the selection is kept so you can retry just those.`,
        remediation: [
          'Re-run the action; already-updated sources are skipped automatically.',
          'Open a failing source and apply the change in its editor to see the full backend error.',
        ],
        retryable: true,
        diagnostics: { failures },
      });
    } else {
      setBulkNote(`${label}: ${changed} updated${skipped > 0 ? `, ${skipped} already set` : ''}.`);
      selection.deselectAll();
    }
  };

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
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-2 dark:border-gray-700">
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Sources ({sortedData.length}
            {sortedData.length !== all.length ? ` of ${all.length}` : ''})
          </h2>
          <div className="relative">
            <Search
              size={13}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sources…"
              aria-label="Search notification sources"
              data-testid="category-search"
              className="w-56 rounded border border-gray-300 bg-white py-1 pl-7 pr-2 text-xs text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
            />
          </div>
        </div>
        {bulkError && (
          <div className="px-4 pt-2">
            <ErrorPanel error={bulkError} severity="error" testId="bulk-error" />
          </div>
        )}
        {bulkNote && (
          <div
            className="mx-4 mt-2 rounded border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300"
            data-testid="bulk-note"
          >
            {bulkNote}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-500 dark:text-gray-400">
              <tr className="border-b border-gray-200/60 dark:border-gray-700/40">
                <th className="w-8 px-4 py-2 text-left">
                  <SelectCheckbox
                    checked={selection.isAllSelected(selectable)}
                    indeterminate={selection.isIndeterminate(selectable)}
                    onChange={() =>
                      selection.isAllSelected(selectable)
                        ? selection.deselectAll()
                        : selection.selectAll(selectable)
                    }
                    disabled={selectable.length === 0}
                    aria-label="Select all editable sources"
                  />
                </th>
                <SortableHeader label="ID" sortKey="id" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="text-left !px-4 !py-2" />
                <SortableHeader label="Display Name" sortKey="displayName" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="text-left !px-4 !py-2" />
                <SortableHeader label="Audience" sortKey="audience" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="text-left !px-4 !py-2" />
                <SortableHeader label="Severity" sortKey="defaultSeverity" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="text-left !px-4 !py-2" />
                <th className="px-4 py-2 text-left">Default Channels</th>
                <SortableHeader label="Mandatory" sortKey="isMandatory" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="text-left !px-4 !py-2" />
                <SortableHeader label="GDPR Basis" sortKey="gdprBasis" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="text-left !px-4 !py-2" />
                <SortableHeader label="Rate Limit" sortKey="rateLimitMax" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="text-left !px-4 !py-2" />
              </tr>
            </thead>
            <tbody>
              {list.isLoading && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-gray-500">
                    <Loader2 size={16} className="mx-auto animate-spin" />
                  </td>
                </tr>
              )}
              {!list.isLoading && !list.isError && sortedData.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-3 text-center text-gray-500">
                    {debouncedQuery.trim()
                      ? `No sources match "${debouncedQuery.trim()}".`
                      : 'No notification sources defined.'}
                  </td>
                </tr>
              )}
              {sortedData.map((cat) => (
                <tr
                  key={cat.id}
                  className="cursor-pointer border-t border-gray-200/60 hover:bg-gray-50 dark:border-gray-700/40 dark:hover:bg-gray-700/30"
                  data-testid={`category-row-${cat.id}`}
                  onClick={() => setEditing(cat)}
                >
                  <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                    <SelectCheckbox
                      checked={selection.isSelected(cat.id)}
                      onChange={() => selection.toggle(cat.id)}
                      disabled={cat.isMandatory}
                      aria-label={
                        cat.isMandatory
                          ? `${cat.displayName} is mandatory and cannot be bulk-edited`
                          : `Select ${cat.displayName}`
                      }
                    />
                  </td>
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

      <BulkActionBar
        selectedCount={selection.selectedCount}
        onDeselectAll={selection.deselectAll}
      >
        {bulkBusy ? (
          <span className="flex items-center gap-2 text-sm text-gray-300">
            <Loader2 size={14} className="animate-spin" /> Applying…
          </span>
        ) : (
          <>
            <ChannelBulkSelect
              label="Enable channel"
              testId="bulk-enable-channel"
              onPick={(ch) =>
                void applyBulk(`Enabled ${CHANNEL_LABEL[ch]}`, (c) =>
                  c.defaultChannels.includes(ch)
                    ? null
                    : { defaultChannels: [...c.defaultChannels, ch] },
                )
              }
            />
            <ChannelBulkSelect
              label="Disable channel"
              testId="bulk-disable-channel"
              onPick={(ch) =>
                void applyBulk(`Disabled ${CHANNEL_LABEL[ch]}`, (c) =>
                  c.defaultChannels.includes(ch)
                    ? { defaultChannels: c.defaultChannels.filter((x) => x !== ch) }
                    : null,
                )
              }
            />
            <button
              type="button"
              data-testid="bulk-activate"
              onClick={() => void applyBulk('Activated', (c) => (c.isActive ? null : { isActive: true }))}
              className="flex items-center gap-1 rounded bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700"
            >
              <Power size={14} /> Activate
            </button>
            <button
              type="button"
              data-testid="bulk-deactivate"
              onClick={() => void applyBulk('Deactivated', (c) => (c.isActive ? { isActive: false } : null))}
              className="flex items-center gap-1 rounded bg-gray-600 px-3 py-1.5 text-sm text-white hover:bg-gray-700"
            >
              <PowerOff size={14} /> Deactivate
            </button>
          </>
        )}
      </BulkActionBar>

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
  const providers = useNotificationProviders();
  const [channels, setChannels] = useState<ReadonlyArray<NotificationChannelId>>(category.defaultChannels);
  const [rateLimitMax, setRateLimitMax] = useState<string>(
    category.rateLimitMax !== null ? String(category.rateLimitMax) : '',
  );
  const [rateLimitWindowS, setRateLimitWindowS] = useState<string>(
    category.rateLimitWindowS !== null ? String(category.rateLimitWindowS) : '',
  );
  const [isActive, setIsActive] = useState<boolean>(category.isActive);
  const [emailProviderId, setEmailProviderId] = useState<string>(category.emailProviderId ?? '');

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
      // Empty string in the select = "use default" → backend stores NULL.
      emailProviderId: emailProviderId === '' ? null : emailProviderId,
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

          <fieldset className="space-y-1">
            <legend className="text-xs font-semibold text-gray-700 dark:text-gray-200">
              Send Email via Provider
            </legend>
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              Override the default email provider for this source only. Useful for
              high-priority transactional notifications (e.g. route security alerts
              through a more reliable provider). Leave on "Default" for normal flow.
            </p>
            <select
              value={emailProviderId}
              onChange={(e) => setEmailProviderId(e.target.value)}
              data-testid="category-email-provider"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="">— Default platform email provider —</option>
              {(providers.data?.data ?? [])
                .filter((p) => p.channel === 'email' && p.enabled)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.providerType})
                  </option>
                ))}
            </select>
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
