import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Loader2, Boxes } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import PaginationBar from '@/components/ui/PaginationBar';
import { useAllDeployments } from '@/hooks/use-deployments';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

export default function WorkloadsTab() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, limit]);

  const { data, isLoading, error } = useAllDeployments({
    page,
    limit,
    search: debouncedSearch || undefined,
  });

  const workloads = data?.data ?? [];
  const totalCount = data?.pagination?.total_count ?? 0;
  const hasMore = data?.pagination?.has_more ?? false;
  const { sortedData, sortKey, sortDirection, onSort } = useSortable(workloads, 'name');

  const handleSearchChange = (value: string) => {
    setSearch(value);
    const key = '__workloadSearchTimeout';
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
            placeholder="Search workloads, tenants, catalog..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="workload-search"
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
          <div className="px-5 py-10 text-center text-sm text-red-500 dark:text-red-400" data-testid="workloads-error">
            {error instanceof Error ? error.message : 'Failed to load workloads'}
          </div>
        )}

        {!isLoading && !error && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="workloads-table">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <SortableHeader label="Name" sortKey="name" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Tenant" sortKey="tenantName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Catalog" sortKey="catalogEntryName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Type" sortKey="catalogEntryType" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden md:table-cell" />
                    <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Version" sortKey="installedVersion" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                    <SortableHeader label="Node" sortKey="currentNodeName" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden xl:table-cell" />
                    <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sortedData.map((wl) => (
                    <tr
                      key={wl.id}
                      className="transition-colors cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      onClick={() => navigate(`/tenants/${wl.tenantId}`)}
                      data-testid={`workload-row-${wl.id}`}
                    >
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <Boxes size={14} className="text-gray-400" />
                          <span className="font-medium text-gray-900 dark:text-gray-100">{wl.name}</span>
                          {wl.source === 'custom' && (
                            <span className="rounded-full bg-purple-100 dark:bg-purple-900/30 px-1.5 py-0.5 text-xs font-medium text-purple-700 dark:text-purple-300">
                              custom
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">
                        {wl.tenantName ?? '—'}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">
                        {wl.catalogEntryName ?? (wl.source === 'custom' ? '—' : '—')}
                      </td>
                      <td className="hidden px-5 py-3.5 text-xs text-gray-500 dark:text-gray-400 md:table-cell">
                        {wl.catalogEntryType ? (
                          <span className="rounded-full bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                            {wl.catalogEntryType}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusBadge status={wl.status as 'active' | 'pending' | 'failed' | 'running' | 'stopped'} />
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm font-mono text-gray-600 dark:text-gray-400 lg:table-cell">
                        {wl.installedVersion ?? '—'}
                      </td>
                      <td className="hidden px-5 py-3.5 text-xs font-mono text-gray-600 dark:text-gray-400 xl:table-cell">
                        {wl.currentNodeName ?? '—'}
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                        {wl.createdAt ? new Date(wl.createdAt).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                  {workloads.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                        {debouncedSearch
                          ? 'No workloads found matching your search.'
                          : 'No workloads deployed across any tenant.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <PaginationBar
              totalCount={totalCount}
              pageSize={limit}
              pageIndex={page - 1}
              hasPrevPage={page > 1}
              hasNextPage={hasMore}
              onNext={() => setPage((p) => p + 1)}
              onPrev={() => setPage((p) => Math.max(1, p - 1))}
              onPageSizeChange={(size) => setLimit(size)}
            />
          </>
        )}
      </div>
    </div>
  );
}
