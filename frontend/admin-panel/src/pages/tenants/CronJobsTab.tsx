import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Loader2, Play, Pause, Trash2, Globe, Terminal } from 'lucide-react';
import clsx from 'clsx';
import CreateCronJobModal from '@/components/CreateCronJobModal';
import SearchableTenantSelect from '@/components/ui/SearchableTenantSelect';
import PaginationBar from '@/components/ui/PaginationBar';
import BulkActionBar, { SelectCheckbox } from '@/components/ui/BulkActionBar';
import { useCronJobs } from '@/hooks/use-cron-jobs';
import { useTenants } from '@/hooks/use-tenants';
import { useCursorPagination } from '@/hooks/use-cursor-pagination';
import { useSelection } from '@/hooks/use-selection';
import { useBulkEnableCronJobs, useBulkDisableCronJobs, useBulkDeleteCronJobs } from '@/hooks/use-bulk-cron-jobs';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

function TypeBadge({ type }: { readonly type: 'webcron' | 'deployment' }) {
  if (type === 'webcron') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:border-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
        <Globe size={10} />
        Webcron
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-purple-200 bg-purple-50 px-2.5 py-0.5 text-xs font-medium text-purple-700 dark:border-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
      <Terminal size={10} />
      Deployment
    </span>
  );
}

function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function CronJobsTab() {
  const navigate = useNavigate();
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'enable' | 'disable' | 'delete' | null>(null);
  const pagination = useCursorPagination({ defaultLimit: 20 });

  useEffect(() => {
    pagination.resetPagination();
  }, [selectedTenantId, debouncedSearch]);

  const { data: cronJobsData, isLoading: cronJobsLoading, error } = useCronJobs({
    tenantId: selectedTenantId ?? undefined,
    search: debouncedSearch || undefined,
    limit: pagination.limit,
    cursor: pagination.cursor,
  });

  const { data: tenantsData } = useTenants({ limit: 100 });
  const tenantMap = new Map((tenantsData?.data ?? []).map((c) => [c.id, c.name]));

  const cronJobs = cronJobsData?.data ?? [];
  const totalCount = cronJobsData?.pagination?.total_count ?? 0;
  const hasMore = cronJobsData?.pagination?.has_more ?? false;
  const nextCursor = cronJobsData?.pagination?.cursor ?? null;
  const { sortedData: sortedCronJobs, sortKey, sortDirection, onSort } = useSortable(cronJobs, 'name');

  const selection = useSelection<{ id: string }>(pagination.cursor);
  const bulkEnable = useBulkEnableCronJobs();
  const bulkDisable = useBulkDisableCronJobs();
  const bulkDelete = useBulkDeleteCronJobs();

  const handleSearchChange = (value: string) => {
    setSearch(value);
    const key = '__cronSearchTimeout';
    const w = window as unknown as Record<string, ReturnType<typeof setTimeout>>;
    clearTimeout(w[key]);
    w[key] = setTimeout(() => setDebouncedSearch(value), 300);
  };

  const handleBulkAction = async () => {
    if (!confirmAction) return;
    const ids = [...selection.selectedIds];
    try {
      if (confirmAction === 'enable') await bulkEnable.mutateAsync(ids);
      else if (confirmAction === 'disable') await bulkDisable.mutateAsync(ids);
      else if (confirmAction === 'delete') await bulkDelete.mutateAsync(ids);
      selection.deselectAll();
    } finally {
      setConfirmAction(null);
    }
  };

  const isBulkPending = bulkEnable.isPending || bulkDisable.isPending || bulkDelete.isPending;

  const formatTarget = (job: (typeof cronJobs)[number]) => {
    if (job.type === 'webcron') {
      return `${job.httpMethod ?? 'GET'} ${job.url ?? ''}`;
    }
    return job.command ?? '';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchableTenantSelect
            selectedTenantId={selectedTenantId}
            onSelect={setSelectedTenantId}
          />
          <div className="relative flex-1 max-w-sm">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              placeholder="Search cron jobs..."
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              data-testid="cron-search"
            />
          </div>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          disabled={!selectedTenantId}
          className={clsx(
            'inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors',
            selectedTenantId
              ? 'bg-brand-500 hover:bg-brand-600'
              : 'bg-gray-300 cursor-not-allowed',
          )}
          data-testid="add-cron-job-button"
        >
          <Plus size={16} />
          Add Cron Job
        </button>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {cronJobsLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {error && (
          <div className="px-5 py-10 text-center text-sm text-red-500 dark:text-red-400" data-testid="cron-jobs-error">
            {error instanceof Error ? error.message : 'Failed to load cron jobs'}
          </div>
        )}

        {!cronJobsLoading && !error && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="cron-jobs-table">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="w-10 px-3 py-3">
                      <SelectCheckbox
                        checked={selection.isAllSelected(cronJobs)}
                        indeterminate={selection.isIndeterminate(cronJobs)}
                        onChange={() => selection.isAllSelected(cronJobs) ? selection.deselectAll() : selection.selectAll(cronJobs)}
                      />
                    </th>
                    <SortableHeader label="Name" sortKey="name" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Tenant" sortKey="tenantId" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Type" sortKey="type" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Schedule" sortKey="schedule" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <th className="hidden px-5 py-3 md:table-cell">Target</th>
                    <SortableHeader label="Enabled" sortKey="enabled" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Last Run" sortKey="lastRunAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                    <SortableHeader label="Status" sortKey="lastRunStatus" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sortedCronJobs.map((job) => (
                    <tr
                      key={job.id}
                      className={`transition-colors cursor-pointer ${
                        selection.isSelected(job.id)
                          ? 'bg-brand-50 dark:bg-brand-900/20'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                      }`}
                      onClick={() => navigate(`/tenants/${job.tenantId}`)}
                      data-testid={`cron-row-${job.id}`}
                    >
                      <td className="w-10 px-3 py-3.5" onClick={(e) => e.stopPropagation()}>
                        <SelectCheckbox
                          checked={selection.isSelected(job.id)}
                          onChange={() => selection.toggle(job.id)}
                        />
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="font-medium text-gray-900 dark:text-gray-100">{job.name}</span>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">
                        {tenantMap.get(job.tenantId) ?? '—'}
                      </td>
                      <td className="px-5 py-3.5">
                        <TypeBadge type={job.type} />
                      </td>
                      <td className="px-5 py-3.5">
                        <code className="rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-xs text-gray-700 dark:text-gray-300">
                          {job.schedule}
                        </code>
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400 md:table-cell max-w-xs truncate">
                        <code className="text-xs">{formatTarget(job)}</code>
                      </td>
                      <td className="px-5 py-3.5">
                        <span
                          className={clsx(
                            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                            job.enabled
                              ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                              : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                          )}
                        >
                          {job.enabled ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                        {job.lastRunAt
                          ? new Date(job.lastRunAt).toLocaleString()
                          : '—'}
                      </td>
                      <td className="hidden px-5 py-3.5 lg:table-cell">
                        {job.lastRunStatus ? (
                          <div className="flex flex-col gap-1">
                            <span
                              className={clsx(
                                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium w-fit',
                                job.lastRunStatus === 'success'
                                  ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                                  : job.lastRunStatus === 'running'
                                    ? 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400'
                                    : 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
                              )}
                            >
                              {job.lastRunStatus}
                            </span>
                            <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                              {formatDuration(job.lastRunDurationMs) && (
                                <span>{formatDuration(job.lastRunDurationMs)}</span>
                              )}
                              {job.type === 'webcron' && job.lastRunResponseCode != null && (
                                <span className="font-mono">{job.lastRunResponseCode}</span>
                              )}
                            </div>
                          </div>
                        ) : (
                          <span className="text-sm text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {cronJobs.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                        {debouncedSearch
                          ? 'No cron jobs found matching your search.'
                          : selectedTenantId
                            ? 'No cron jobs yet. Click "Add Cron Job" to create one.'
                            : 'No cron jobs found across any tenant.'}
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

      <BulkActionBar selectedCount={selection.selectedCount} onDeselectAll={selection.deselectAll}>
        <button
          onClick={() => setConfirmAction('enable')}
          className="inline-flex items-center gap-1.5 rounded-md bg-green-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600 transition-colors"
        >
          <Play size={14} />
          Enable Selected
        </button>
        <button
          onClick={() => setConfirmAction('disable')}
          className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 transition-colors"
        >
          <Pause size={14} />
          Disable Selected
        </button>
        <button
          onClick={() => setConfirmAction('delete')}
          className="inline-flex items-center gap-1.5 rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 transition-colors"
        >
          <Trash2 size={14} />
          Delete Selected
        </button>
      </BulkActionBar>

      {confirmAction && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50" onClick={() => setConfirmAction(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {confirmAction === 'delete' ? 'Delete' : confirmAction === 'enable' ? 'Enable' : 'Disable'} {selection.selectedCount} cron job{selection.selectedCount !== 1 ? 's' : ''}?
            </h3>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              {confirmAction === 'delete'
                ? 'This will permanently delete the selected cron jobs. This action cannot be undone.'
                : confirmAction === 'enable'
                  ? 'The selected cron jobs will be enabled and start running on their schedules.'
                  : 'The selected cron jobs will be disabled and stop running.'}
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button
                onClick={() => setConfirmAction(null)}
                className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkAction}
                disabled={isBulkPending}
                className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
                  confirmAction === 'delete'
                    ? 'bg-red-500 hover:bg-red-600'
                    : confirmAction === 'enable'
                      ? 'bg-green-500 hover:bg-green-600'
                      : 'bg-amber-500 hover:bg-amber-600'
                }`}
              >
                {isBulkPending && <Loader2 size={14} className="animate-spin" />}
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedTenantId && (
        <CreateCronJobModal
          open={showCreate}
          onClose={() => setShowCreate(false)}
          tenantId={selectedTenantId}
        />
      )}
    </div>
  );
}
