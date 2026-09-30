/**
 * Tenants → SFTP Users — every SFTP account on the platform.
 *
 * The per-tenant list already existed on each tenant's page, so answering
 * "who has SFTP here" meant opening tenants one at a time. This is the same
 * data across all of them, searchable by username, path, description or
 * tenant name, with each row a link to the tenant that owns it.
 *
 * It is deliberately read-only. An SFTP account is created and rotated in
 * the context of one tenant, where the home path and the tenant's storage
 * are both visible; a cross-tenant table is where you go to FIND one.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Loader2, HardDrive } from 'lucide-react';
import clsx from 'clsx';
import PaginationBar from '@/components/ui/PaginationBar';
import { useSftpUsers } from '@/hooks/use-sftp-users';
import { useCursorPagination } from '@/hooks/use-cursor-pagination';
import { formatRelativeTime } from '@/lib/format-relative-time';

export default function SftpUsersTab() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const pagination = useCursorPagination({ defaultLimit: 20 });

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    pagination.resetPagination();
    // Paging is cursor-based, so a new search must start from the first page
    // — a cursor from the previous result set means nothing in this one.
  }, [debouncedSearch]);

  const { data, isLoading, error } = useSftpUsers({
    search: debouncedSearch || undefined,
    limit: pagination.limit,
    cursor: pagination.cursor,
  });

  const users = data?.data ?? [];
  const totalCount = data?.pagination?.total_count ?? users.length;
  const hasMore = data?.pagination?.has_more ?? false;
  const nextCursor = data?.pagination?.cursor ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[260px] flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search username, path, description or tenant…"
            aria-label="Search SFTP users"
            data-testid="sftp-users-search"
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          />
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 p-10 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={18} className="animate-spin" /> Loading SFTP users…
          </div>
        ) : error ? (
          <div className="p-6 text-sm text-red-600 dark:text-red-400">
            {(error as Error).message}
          </div>
        ) : users.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center">
            <HardDrive size={22} className="text-gray-400" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {debouncedSearch ? 'No SFTP users match that search.' : 'No SFTP users on the platform yet.'}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="sftp-users-table">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <th className="px-5 py-3">Username</th>
                    <th className="px-5 py-3">Tenant</th>
                    <th className="hidden px-5 py-3 md:table-cell">Home path</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="hidden px-5 py-3 lg:table-cell">Last login</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr
                      key={u.id}
                      onClick={() => navigate(`/tenants/${u.tenantId}`)}
                      className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50 dark:border-gray-700/50 dark:hover:bg-gray-700/40"
                      data-testid={`sftp-user-row-${u.id}`}
                    >
                      <td className="px-5 py-3 font-mono text-sm text-gray-900 dark:text-gray-100">{u.username}</td>
                      <td className="px-5 py-3 text-sm text-gray-700 dark:text-gray-300">
                        {u.tenantName ?? <span className="text-gray-400">unknown</span>}
                      </td>
                      <td className="hidden px-5 py-3 font-mono text-xs text-gray-500 md:table-cell dark:text-gray-400">
                        {u.homePath}
                      </td>
                      <td className="px-5 py-3">
                        <span className={clsx(
                          'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
                          u.enabled
                            ? 'bg-green-50 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
                        )}
                        >
                          {u.enabled ? 'enabled' : 'disabled'}
                        </span>
                      </td>
                      <td className="hidden px-5 py-3 text-sm text-gray-500 lg:table-cell dark:text-gray-400">
                        {u.lastLoginAt ? formatRelativeTime(u.lastLoginAt) : 'never'}
                      </td>
                    </tr>
                  ))}
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
