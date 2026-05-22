/**
 * `/backups/tenants` — Tenants backup-class page.
 *
 * Phase 3 (2026-05-22) — flat-aggregate per the operator IA decision:
 * snapshots + bundles across ALL tenants in one table per tab, with a
 * tenant filter chip at the top and a "Tenant" column on every row.
 * No per-tenant detail page — the Restoration Wizard (Phase 6)
 * supplies the per-row drill via modal.
 *
 *   (a) Snapshots — every tenant PVC snapshot row (class=tenant_snapshot
 *                   in storage_snapshots). Filter by tenant + status.
 *   (b) Backups   — every tenant bundle row (class=tenant_bundle).
 *                   Same filter UX as (a).
 *   (c) Targets, Schedules & Retention — `<BackupRoutingTab>` for the
 *                   `tenant` shim class with the `tenant_bundle`
 *                   schedule row.
 */

import { useState } from 'react';
import { Package, Search, Loader2, Filter } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { TenantsBackupsOverviewResponse, TenantBackupOverviewRow } from '@k8s-hosting/api-contracts';
import BackupClassPage from './BackupClassPage';

function formatBytes(b: number): string {
  if (!b) return '—';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MiB`;
  return `${(b / 1024).toFixed(0)} KiB`;
}

function formatAge(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  // Future timestamps (clock skew, test data) — collapse to "just
  // now" instead of computing a negative duration that would render
  // as "-1d ago" further down.
  if (ms <= 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function useTenantsOverview(search: string) {
  return useQuery({
    queryKey: ['admin', 'backups', 'tenants', 'overview', { search }],
    queryFn: () => apiFetch<{ data: TenantsBackupsOverviewResponse }>(
      `/api/v1/admin/backups/tenants/overview${search ? `?filter=${encodeURIComponent(search)}` : ''}`,
    ),
    staleTime: 15_000,
  });
}

type View = 'snapshots' | 'backups';

function TenantAggregateTable({
  rows,
  view,
  isLoading,
}: {
  readonly rows: ReadonlyArray<TenantBackupOverviewRow>;
  readonly view: View;
  readonly isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="rounded border border-dashed border-gray-300 bg-gray-50 px-3 py-6 text-center text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400">
        No matching tenants.
      </p>
    );
  }
  const isSnap = view === 'snapshots';
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <th className="px-4 py-2">Tenant</th>
            <th className="px-4 py-2 text-right">{isSnap ? 'Snapshots' : 'Bundles'}</th>
            <th className="px-4 py-2 text-right">Bytes</th>
            <th className="px-4 py-2 text-right">Last run</th>
            <th className="px-4 py-2">Plan</th>
            <th className="px-4 py-2">Included</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700 dark:bg-gray-900">
          {rows.map((r) => {
            const count = isSnap ? r.snapshotCount : r.bundleCount;
            const bytes = isSnap ? r.snapshotBytes : r.bundleBytes;
            const lastAt = isSnap ? r.lastSnapshotAt : r.lastBundleAt;
            return (
              <tr key={r.tenantId} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                <td className="px-4 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">
                  {r.tenantName}
                  {r.isSystem && (
                    <span className="ml-1 rounded bg-purple-100 px-1 py-0.5 text-[10px] uppercase tracking-wide text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
                      system
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-gray-900 dark:text-gray-100">{count}</td>
                <td className="px-4 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">
                  {formatBytes(bytes)}
                </td>
                <td className="px-4 py-2 text-right text-xs text-gray-500 dark:text-gray-400">
                  {formatAge(lastAt)}
                </td>
                <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-300">{r.planName ?? '—'}</td>
                <td className="px-4 py-2 text-xs">
                  {r.includedInScheduledBundles ? (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                      yes
                    </span>
                  ) : (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                      no
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface FilterBarProps {
  readonly search: string;
  readonly setSearch: (v: string) => void;
  readonly rowCount: number;
}

/**
 * Lifted out of the parent's tab-content props so the input keeps
 * its DOM identity across snapshot↔backups tab switches (a shared
 * JSX node reference would unmount/remount, dropping focus and
 * cursor position mid-typing).
 */
function FilterBar({ search, setSearch, rowCount }: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative flex-1 min-w-[200px] max-w-md">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by tenant name…"
          data-testid="tenants-backups-filter"
          className="w-full rounded-md border border-gray-300 bg-white py-1.5 pl-9 pr-3 text-sm placeholder:text-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        />
      </div>
      <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
        <Filter size={12} />
        {rowCount} tenant{rowCount === 1 ? '' : 's'}
      </span>
    </div>
  );
}

export default function TenantsBackupsPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useTenantsOverview(search);
  const rows = data?.data?.rows ?? [];

  return (
    <BackupClassPage
      icon={Package}
      title="Tenant Backups"
      subtitle="Per-tenant snapshots (PVC block copies) and bundles (files + mailboxes + config). Aggregated across all tenants — filter to drill into one."
      shimClass="tenant"
      scheduleSubsystems={['tenant_bundle']}
      snapshotsTab={
        <div className="space-y-4">
          <FilterBar search={search} setSearch={setSearch} rowCount={rows.length} />
          <TenantAggregateTable rows={rows} view="snapshots" isLoading={isLoading} />
        </div>
      }
      backupsTab={
        <div className="space-y-4">
          <FilterBar search={search} setSearch={setSearch} rowCount={rows.length} />
          <TenantAggregateTable rows={rows} view="backups" isLoading={isLoading} />
        </div>
      }
    />
  );
}
