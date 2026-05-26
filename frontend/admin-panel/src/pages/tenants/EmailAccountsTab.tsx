import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Loader2, Mail } from 'lucide-react';
import clsx from 'clsx';
import PaginationBar from '@/components/ui/PaginationBar';
import { useAdminMailboxes } from '@/hooks/use-admin-mailboxes';
import { useCursorPagination } from '@/hooks/use-cursor-pagination';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

function StatusPill({ status }: { readonly status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    disabled: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
  };
  return (
    <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', styles[status] ?? styles.disabled)}>
      {status}
    </span>
  );
}

function TypePill({ type }: { readonly type: string }) {
  if (type === 'forward_only') {
    return (
      <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
        Forward
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
      Mailbox
    </span>
  );
}

function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

export default function EmailAccountsTab() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const pagination = useCursorPagination({ defaultLimit: 20 });

  useEffect(() => {
    pagination.resetPagination();
  }, [debouncedSearch]);

  const { data, isLoading, error } = useAdminMailboxes({
    search: debouncedSearch || undefined,
    limit: pagination.limit,
    cursor: pagination.cursor,
  });

  const mailboxes = data?.data ?? [];
  const totalCount = data?.pagination?.total_count ?? 0;
  const hasMore = data?.pagination?.has_more ?? false;
  const nextCursor = data?.pagination?.cursor ?? null;
  const { sortedData, sortKey, sortDirection, onSort } = useSortable(mailboxes, 'fullAddress');

  const handleSearchChange = (value: string) => {
    setSearch(value);
    const key = '__mailboxSearchTimeout';
    const w = window as unknown as Record<string, ReturnType<typeof setTimeout>>;
    clearTimeout(w[key]);
    w[key] = setTimeout(() => setDebouncedSearch(value), 300);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search by address, domain, tenant..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="mailbox-search"
          />
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {isLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {error && (
          <div className="px-5 py-10 text-center text-sm text-red-500 dark:text-red-400" data-testid="mailboxes-error">
            {error instanceof Error ? error.message : 'Failed to load mailboxes'}
          </div>
        )}

        {!isLoading && !error && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="mailboxes-table">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <SortableHeader label="Address" sortKey="fullAddress" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Tenant" sortKey="tenantName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Type" sortKey="mailboxType" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Quota" sortKey="quotaMb" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden md:table-cell" />
                    <SortableHeader label="Used" sortKey="usedMb" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                    <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sortedData.map((mb) => (
                    <tr
                      key={mb.id}
                      className="transition-colors cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      onClick={() => navigate(`/tenants/${mb.tenantId}`)}
                      data-testid={`mailbox-row-${mb.id}`}
                    >
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <Mail size={14} className="text-gray-400" />
                          <div>
                            <div className="font-medium text-gray-900 dark:text-gray-100">{mb.fullAddress}</div>
                            {mb.displayName && (
                              <div className="text-xs text-gray-500 dark:text-gray-400">{mb.displayName}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">
                        {mb.tenantName ?? '—'}
                      </td>
                      <td className="px-5 py-3.5">
                        <TypePill type={mb.mailboxType} />
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusPill status={mb.status} />
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm font-mono text-gray-600 dark:text-gray-400 md:table-cell">
                        {formatMb(mb.quotaMb)}
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm font-mono text-gray-600 dark:text-gray-400 lg:table-cell">
                        {formatMb(mb.usedMb)}
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                        {mb.createdAt ? new Date(mb.createdAt).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                  {mailboxes.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                        {debouncedSearch
                          ? 'No mailboxes found matching your search.'
                          : 'No mailboxes found.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <PaginationBar
              totalCount={totalCount}
              pageSize={pagination.limit}
              pageIndex={pagination.pageIndex}
              hasPrevPage={pagination.hasPrevPage}
              hasNextPage={hasMore}
              onNext={() => nextCursor && pagination.goNext(nextCursor)}
              onPrev={pagination.goPrev}
              onPageSizeChange={pagination.setPageSize}
            />
          </>
        )}
      </div>
    </div>
  );
}
