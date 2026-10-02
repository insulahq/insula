import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Loader2, Globe, ShieldCheck, Lock, Trash2, AlertTriangle, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import StatusBadge from '@/components/ui/StatusBadge';
import PaginationBar from '@/components/ui/PaginationBar';
import BulkActionBar, { SelectCheckbox } from '@/components/ui/BulkActionBar';
import BulkRunModal from '@/components/BulkRunModal';
import SearchableTenantSelect from '@/components/ui/SearchableTenantSelect';
import { useDomains } from '@/hooks/use-domains';
import { useTenants } from '@/hooks/use-tenants';
import { useCursorPagination } from '@/hooks/use-cursor-pagination';
import { useSelection } from '@/hooks/use-selection';
import { useBulkRun } from '@/hooks/use-bulk-run';
import {
  DOMAIN_BULK_RUNNERS,
  useInvalidateDomainQueries,
  type DomainBulkAction,
  type DomainBulkItem,
} from '@/hooks/use-bulk-domains';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

export default function DomainsTab() {
  const navigate = useNavigate();
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [confirmAction, setConfirmAction] = useState<DomainBulkAction | null>(null);

  const pagination = useCursorPagination({ defaultLimit: 20 });

  useEffect(() => {
    pagination.resetPagination();
  }, [debouncedSearch, selectedTenantId]);

  const { data: domainsData, isLoading: domainsLoading, error: domainsError } = useDomains(
    selectedTenantId ?? undefined,
    { search: debouncedSearch || undefined, limit: pagination.limit, cursor: pagination.cursor },
  );

  const { data: tenantsData } = useTenants({ limit: 100 });
  const tenantMap = new Map((tenantsData?.data ?? []).map((c) => [c.id, c.name]));

  const domains = domainsData?.data ?? [];
  const totalCount = domainsData?.pagination?.total_count ?? 0;
  const hasMore = domainsData?.pagination?.has_more ?? false;
  const nextCursor = domainsData?.pagination?.cursor ?? null;
  const { sortedData: sortedDomains, sortKey, sortDirection, onSort } = useSortable(domains, 'domainName');

  const selection = useSelection<{ id: string }>(pagination.cursor);
  const bulkRun = useBulkRun();
  const invalidateDomains = useInvalidateDomainQueries();

  const handleSearchChange = (value: string) => {
    setSearch(value);
    const key = '__domainSearchTimeout';
    const w = window as unknown as Record<string, ReturnType<typeof setTimeout>>;
    clearTimeout(w[key]);
    w[key] = setTimeout(() => setDebouncedSearch(value), 300);
  };

  // In table order, so the progress list reads like the table the operator selected from.
  const selectedDomains: readonly DomainBulkItem[] = sortedDomains
    .filter((d) => selection.isSelected(d.id))
    .map((d) => ({ id: d.id, label: d.domainName, sublabel: tenantMap.get(d.tenantId), tenantId: d.tenantId }));

  const handleBulkAction = () => {
    if (!confirmAction) return;
    bulkRun.start({
      title: BULK_TITLES[confirmAction],
      noun: 'domain',
      items: selectedDomains,
      runItem: DOMAIN_BULK_RUNNERS[confirmAction],
      onSettled: invalidateDomains,
      // Keep only what still needs doing selected, so a re-run touches just those.
      onClose: (remainingIds) => selection.setSelection(remainingIds),
    });
    setConfirmAction(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchableTenantSelect
          selectedTenantId={selectedTenantId}
          onSelect={setSelectedTenantId}
        />

        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search domains..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="domain-search"
          />
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {domainsLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {domainsError && (
          <div className="px-5 py-10 text-center text-sm text-red-500 dark:text-red-400" data-testid="domains-error">
            {domainsError instanceof Error ? domainsError.message : 'Failed to load domains'}
          </div>
        )}

        {!domainsLoading && !domainsError && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="domains-table">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="w-10 px-3 py-3">
                      <SelectCheckbox
                        checked={selection.isAllSelected(domains)}
                        indeterminate={selection.isIndeterminate(domains)}
                        onChange={() => selection.isAllSelected(domains) ? selection.deselectAll() : selection.selectAll(domains)}
                      />
                    </th>
                    <SortableHeader label="Domain Name" sortKey="domainName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Tenant" sortKey="tenantId" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="DNS Mode" sortKey="dnsMode" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden md:table-cell" />
                    <SortableHeader label="SSL" sortKey="sslAutoRenew" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                    <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sortedDomains.map((domain) => (
                    <tr
                      key={domain.id}
                      className={`transition-colors cursor-pointer ${
                        selection.isSelected(domain.id)
                          ? 'bg-brand-50 dark:bg-brand-900/20'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                      }`}
                      onClick={() => navigate(`/tenants/${domain.tenantId}`)}
                      data-testid={`domain-row-${domain.id}`}
                    >
                      <td className="w-10 px-3 py-3.5" onClick={(e) => e.stopPropagation()}>
                        <SelectCheckbox
                          checked={selection.isSelected(domain.id)}
                          onChange={() => selection.toggle(domain.id)}
                        />
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <Globe size={14} className="text-gray-400" />
                          <span className="font-medium text-gray-900 dark:text-gray-100">{domain.domainName}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">
                        {tenantMap.get(domain.tenantId) ?? '—'}
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusBadge status={domain.status as 'active' | 'pending' | 'unverified' | 'verified' | 'suspended' | 'deleted'} />
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400 uppercase md:table-cell">
                        {domain.dnsMode}
                      </td>
                      <td className="hidden px-5 py-3.5 lg:table-cell">
                        <TlsBadge domain={domain} />
                      </td>
                      <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                        {domain.createdAt ? new Date(domain.createdAt).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                  {domains.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                        {debouncedSearch
                          ? 'No domains found matching your search.'
                          : 'No domains found across any tenant.'}
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
          onClick={() => setConfirmAction('verify')}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600 transition-colors"
          data-testid="bulk-verify-domains"
        >
          <ShieldCheck size={14} />
          Verify Selected
        </button>
        <button
          onClick={() => setConfirmAction('refresh-route-dns')}
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 transition-colors dark:bg-indigo-600 dark:hover:bg-indigo-500"
          title="Rewrite the selected domains' ingress A/AAAA records from the current ingress addresses. Use after adding or removing an ingress node."
          data-testid="bulk-refresh-route-dns"
        >
          <RefreshCw size={14} />
          Refresh Route DNS
        </button>
        <button
          onClick={() => setConfirmAction('delete')}
          className="inline-flex items-center gap-1.5 rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 transition-colors"
          data-testid="bulk-delete-domains"
        >
          <Trash2 size={14} />
          Delete Selected
        </button>
      </BulkActionBar>

      {confirmAction && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50" onClick={() => setConfirmAction(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {confirmAction === 'refresh-route-dns' ? 'Refresh route DNS for' : BULK_TITLES[confirmAction]} {selectedDomains.length} domain{selectedDomains.length !== 1 ? 's' : ''}?
            </h3>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              {BULK_DESCRIPTIONS[confirmAction]}
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
                disabled={selectedDomains.length === 0}
                className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                  confirmAction === 'delete'
                    ? 'bg-red-500 hover:bg-red-600'
                    : confirmAction === 'refresh-route-dns'
                      ? 'bg-indigo-500 hover:bg-indigo-600 dark:bg-indigo-600 dark:hover:bg-indigo-500'
                      : 'bg-blue-500 hover:bg-blue-600'
                }`}
                data-testid="bulk-confirm"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      <BulkRunModal controller={bulkRun} />
    </div>
  );
}

const BULK_TITLES: Readonly<Record<DomainBulkAction, string>> = {
  verify: 'Verify',
  delete: 'Delete',
  'refresh-route-dns': 'Refresh route DNS',
};

const BULK_DESCRIPTIONS: Readonly<Record<DomainBulkAction, string>> = {
  verify: 'Runs DNS verification checks on each selected domain, one at a time, and updates its verification status.',
  delete: 'This will permanently delete the selected domains and their DNS records. This action cannot be undone.',
  'refresh-route-dns': "Rewrites each selected domain's ingress A/AAAA records from the current ingress addresses, one domain at a time. Records created by hand are not touched. Domains not in primary DNS mode are skipped.",
};

function TlsBadge({ domain }: { readonly domain: { id: string; sslAutoRenew: number; tlsCertStatus?: string; tlsCertIssuer?: string | null; tlsCertExpiresAt?: string | null; tlsCertWildcard?: boolean; tlsCertError?: string | null; tlsCertFallbackActive?: boolean } }) {
  const status = domain.tlsCertStatus ?? (domain.sslAutoRenew ? 'pending' : 'none');
  const issuer = domain.tlsCertIssuer;
  const expiry = domain.tlsCertExpiresAt ? new Date(domain.tlsCertExpiresAt) : null;
  const isWildcard = domain.tlsCertWildcard ?? false;
  const fallbackActive = domain.tlsCertFallbackActive ?? false;

  const daysUntilExpiry = expiry ? Math.ceil((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;

  const tooltip = [
    `Status: ${status.charAt(0).toUpperCase() + status.slice(1)}`,
    // Without the reason, a red "Failed" badge sends the operator
    // hunting through cert-manager logs for something we already know.
    status === 'failed' && domain.tlsCertError ? `Reason: ${domain.tlsCertError}` : null,
    fallbackActive ? 'Wildcard unavailable — per-hostname certificates in use' : null,
    issuer ? `Issuer: ${issuer}` : null,
    isWildcard ? 'Type: Wildcard' : 'Type: Single-hostname',
    expiry ? `Expires: ${expiry.toLocaleDateString()} (${daysUntilExpiry}d)` : 'Expires: N/A',
  ].filter(Boolean).join('\n');

  const styles: Record<string, string> = {
    active: 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300',
    expiring: 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300',
    expired: 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300',
    failed: 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300',
    pending: 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300',
    none: 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
  };

  const labels: Record<string, string> = {
    active: 'Active',
    expiring: `${daysUntilExpiry}d`,
    expired: 'Expired',
    failed: 'Failed',
    pending: 'Pending',
    none: 'None',
  };

  const shortIssuer = issuer?.includes("Let's Encrypt") ? 'LE' : issuer?.includes('DigiCert') ? 'DC' : issuer ? 'Custom' : '';
  const hideDetail = status === 'none' || status === 'pending' || status === 'failed';

  return (
    <span
      className={clsx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium cursor-default', styles[status] ?? styles.none)}
      title={tooltip}
      data-testid={`ssl-badge-${domain.id}`}
    >
      {status === 'failed' ? <AlertTriangle size={10} /> : <Lock size={10} />}
      {labels[status] ?? status}
      {shortIssuer && !hideDetail && <span className="opacity-70">· {shortIssuer}</span>}
      {isWildcard && !hideDetail && <span className="opacity-70">· WC</span>}
      {fallbackActive && <span className="opacity-70">· fallback</span>}
    </span>
  );
}
