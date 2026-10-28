import { Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import StatusBadge from '@/components/ui/StatusBadge';
import { useTenantBundles } from '@/hooks/use-tenant-bundles';
import type { BundleSummary } from '@insula/api-contracts';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import TimeCell from '@/components/ui/TimeCell';
import { formatBytes } from '@/lib/format-bytes';

function TabLoading() {
  return (
    <div className="flex items-center justify-center py-10" data-testid="tab-loading">
      <Loader2 size={24} className="animate-spin text-gray-400" />
    </div>
  );
}

function TabError({ message }: { readonly message: string }) {
  return <p className="py-6 text-center text-sm text-red-500 dark:text-red-400" data-testid="tab-error">{message}</p>;
}

function TabEmpty({ resource }: { readonly resource: string }) {
  return <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="tab-empty">No {resource} found for this tenant.</p>;
}

/**
 * Off-site bundle history for this tenant (backup_jobs) with a jump to
 * the cross-tenant Backups page pre-filtered to this tenant, where each
 * bundle row has its own Restore… action. Closes "nowhere shows that
 * multiple backups exist for this tenant" (operator report #3,
 * ) — the legacy table below only knows the retired
 * per-resource `backups` rows.
 */
export function TenantBundlesSummary({ tenantId }: { readonly tenantId: string }) {
  // Same hook (and therefore the same cached query) the tab body uses, so the
  // headline count and the table below it can never disagree.
  const q = useTenantBundles(tenantId);
  const bundles = Array.isArray(q.data?.data) ? q.data.data : [];
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm dark:border-gray-700 dark:bg-gray-800/50"
      data-testid="tenant-bundles-summary"
    >
      <div className="text-gray-700 dark:text-gray-300">
        <span className="font-medium">{q.isLoading ? '…' : (q.data?.pagination?.total_count ?? bundles.length)}</span>{' '}
        off-site backup bundle{bundles.length === 1 ? '' : 's'} for this tenant
        {bundles.length > 0 && (
          <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
            (latest <TimeCell iso={bundles[0]?.createdAt} />)
          </span>
        )}
      </div>
      <Link
        to={`/backups/tenants/backups?tenant=${tenantId}`}
        className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        data-testid="tenant-bundles-manage-link"
      >
        View & restore bundles →
      </Link>
    </div>
  );
}

export function BackupsTab({ bundles, isLoading, error, tenantId }: {
  readonly bundles: readonly BundleSummary[] | undefined;
  readonly isLoading: boolean;
  readonly error: Error | null;
  readonly tenantId: string | undefined;
}) {
  // Hook order must not depend on load state (Rules of Hooks) — the
  // early returns come after every hook call.
  const items = useMemo(() => (bundles ? [...bundles] : []), [bundles]);
  const { sortedData: sortedItems, sortKey, sortDirection, onSort } = useSortable(items, 'createdAt', 'desc');
  if (isLoading) return <TabLoading />;
  if (error) return <TabError message="Failed to load backups." />;
  if (items.length === 0) return <TabEmpty resource="backups" />;

  return (
    <table className="w-full text-left text-sm" data-testid="backups-table">
      <thead>
        <tr className="border-b border-gray-100 dark:border-gray-700 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
          <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort}  className="!px-3 !py-2" />
          <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort}  className="!px-3 !py-2" />
          <SortableHeader label="Size" sortKey="sizeBytes" currentKey={sortKey} direction={sortDirection} onSort={onSort}  className="!px-3 !py-2" />
          <SortableHeader label="Started by" sortKey="initiator" currentKey={sortKey} direction={sortDirection} onSort={onSort}  className="!px-3 !py-2" />
          <SortableHeader label="Expires" sortKey="expiresAt" currentKey={sortKey} direction={sortDirection} onSort={onSort}  className="!px-3 !py-2" />
          <th className="px-3 py-2" />
        </tr>
      </thead>
      <tbody>
        {sortedItems.map((b) => (
          <tr key={b.id} className="border-b border-gray-50 dark:border-gray-700">
            <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100"><TimeCell iso={b.createdAt} /></td>
            <td className="px-3 py-2"><StatusBadge status={b.status} /></td>
            <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{b.sizeBytes ? formatBytes(b.sizeBytes) : '—'}</td>
            <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{b.initiator}</td>
            {/* mode="until": an expiry is in the FUTURE, and TimeCell's default
                age mode renders any future instant as "just now" (caught in the
                browser on DEV). Same rendering the cross-tenant Backups page uses. */}
            <td className="px-3 py-2 text-gray-500 dark:text-gray-400">{b.expiresAt ? <TimeCell iso={b.expiresAt} mode="until" /> : '—'}</td>
            <td className="px-3 py-2 text-right">
              <Link
                to={`/backups/tenants/backups?tenant=${tenantId ?? b.tenantId}&bundle=${b.id}`}
                className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                Restore…
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
