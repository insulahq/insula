import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Loader2, UserCircle } from 'lucide-react';
import clsx from 'clsx';
import PaginationBar from '@/components/ui/PaginationBar';
import { useTenantUsers } from '@/hooks/use-tenant-users';
import { useCursorPagination } from '@/hooks/use-cursor-pagination';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

function RoleBadge({ role }: { readonly role: string }) {
  const isPrimary = role === 'primary';
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        isPrimary
          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
          : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
      )}
    >
      {isPrimary ? 'Primary' : role}
    </span>
  );
}

function StatusPill({ status }: { readonly status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    disabled: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
    pending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  };
  return (
    <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', styles[status] ?? styles.disabled)}>
      {status}
    </span>
  );
}

export default function UsersTab() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const pagination = useCursorPagination({ defaultLimit: 20 });

  useEffect(() => {
    pagination.resetPagination();
  }, [debouncedSearch]);

  const { data, isLoading, error } = useTenantUsers({
    search: debouncedSearch || undefined,
    limit: pagination.limit,
    cursor: pagination.cursor,
  });

  const users = data?.data ?? [];
  const totalCount = data?.pagination?.total_count ?? 0;
  const hasMore = data?.pagination?.has_more ?? false;
  const nextCursor = data?.pagination?.cursor ?? null;
  const { sortedData, sortKey, sortDirection, onSort } = useSortable(users, 'createdAt');

  const handleSearchChange = (value: string) => {
    setSearch(value);
    const key = '__userSearchTimeout';
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
            placeholder="Search by email, name, tenant..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="tenant-user-search"
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
          <div className="px-5 py-10 text-center text-sm text-red-500 dark:text-red-400" data-testid="tenant-users-error">
            {error instanceof Error ? error.message : 'Failed to load tenant users'}
          </div>
        )}

        {!isLoading && !error && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="tenant-users-table">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <SortableHeader label="User" sortKey="email" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Tenant" sortKey="tenantName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Role" sortKey="roleName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Last Login" sortKey="lastLoginAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden md:table-cell" />
                    <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sortedData.map((user) => (
                    <tr
                      key={user.id}
                      className="transition-colors cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      onClick={() => user.tenantId && navigate(`/tenants/${user.tenantId}`)}
                      data-testid={`tenant-user-row-${user.id}`}
                    >
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <UserCircle size={14} className="text-gray-400" />
                          <div>
                            <div className="font-medium text-gray-900 dark:text-gray-100">{user.email}</div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">{user.fullName}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">
                        {user.tenantName ?? '—'}
                      </td>
                      <td className="px-5 py-3.5">
                        <RoleBadge role={user.roleName} />
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusPill status={user.status} />
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 md:table-cell">
                        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—'}
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                        {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                        {debouncedSearch
                          ? 'No tenant users found matching your search.'
                          : 'No tenant users found.'}
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
