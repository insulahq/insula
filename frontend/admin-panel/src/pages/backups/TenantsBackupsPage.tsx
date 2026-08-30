/**
 * `/backups/tenants` — Tenants backup-class page.
 *
 * B2 (2026-05-22) replaces the per-tenant rollup with two real
 * lists:
 *
 *   (a) Snapshots — one row per storage_snapshots entry across all
 *       tenants. Source: GET /admin/backups/tenants/snapshots.
 *       Actions: Restore… (RestorationWizard → rollback API), Delete.
 *
 *   (b) Backups — one row per tenant bundle. Source:
 *       GET /admin/tenant-bundles. Actions: Restore… (cart flow).
 *
 *   (c) Targets, Schedules & Retention — `<BackupRoutingTab>`.
 *
 * Headers carry global "Snapshot all eligible tenants" / "Bundle all
 * eligible tenants" buttons. Free-text + tenant filter for narrowing.
 */

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Package, Search, Loader2, Filter, Camera, Archive, RotateCw, AlertCircle, Trash2, Clock,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BundleSummary,
  TenantsBackupsOverviewResponse,
  TenantBackupOverviewRow,
  RestoreJobSummary,
} from '@insula/api-contracts';
import BackupClassPage from './BackupClassPage';
import RestorationWizard, { type RestoreArtifact } from '@/components/backups/RestorationWizard';
import { AdminBundleProgressModal } from '@/components/AdminBundleProgressModal';
import { useShimAssignments } from '@/hooks/use-backup-rclone-shim';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import TimeCell from '@/components/ui/TimeCell';

// ── Local types ──────────────────────────────────────────────────────

interface TenantSnapshotRow {
  readonly id: string;
  readonly tenantId: string;
  readonly tenantName: string | null;
  readonly backupClass: string;
  readonly label: string | null;
  readonly subsystem: string;
  readonly sizeBytes: number;
  readonly status: string;
  readonly targetId: string | null;
  readonly targetName: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

interface TenantSnapshotListResponse {
  readonly rows: ReadonlyArray<TenantSnapshotRow>;
  readonly hasMore: boolean;
  /** system_settings.snapshot_expiry_hours — snapshots reap after this. */
  readonly expiryHours?: number;
}

// ── Formatters ───────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (!b) return '—';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MiB`;
  return `${(b / 1024).toFixed(0)} KiB`;
}

// ── Hooks ────────────────────────────────────────────────────────────

function useTenantsRollup() {
  return useQuery({
    queryKey: ['admin', 'backups', 'tenants', 'overview'],
    queryFn: () => apiFetch<{ data: TenantsBackupsOverviewResponse }>(
      '/api/v1/admin/backups/tenants/overview',
    ),
    staleTime: 15_000,
  });
}

function useTenantSnapshots(tenantFilter: string | null) {
  return useQuery({
    queryKey: ['admin', 'backups', 'tenants', 'snapshots', tenantFilter],
    queryFn: () => apiFetch<{ data: TenantSnapshotListResponse }>(
      `/api/v1/admin/backups/tenants/snapshots${tenantFilter ? `?tenantId=${encodeURIComponent(tenantFilter)}` : ''}`,
    ),
    staleTime: 15_000,
  });
}

function useTenantBundles(tenantFilter: string | null) {
  return useQuery({
    queryKey: ['admin', 'tenant-bundles', tenantFilter],
    queryFn: () => apiFetch<{ data: ReadonlyArray<BundleSummary> | { data?: ReadonlyArray<BundleSummary> }; pagination?: unknown }>(
      `/api/v1/admin/tenant-bundles${tenantFilter ? `?tenantId=${encodeURIComponent(tenantFilter)}` : ''}`,
    ),
    staleTime: 15_000,
    // Defensive unwrap — accept BOTH the canonical `{data: [...], pagination}`
    // envelope AND a legacy double-wrap (`{data: {data: [...], pagination}}`)
    // that was shipped briefly. Without this normaliser an old platform-api
    // still in the wild blows up the page with "rows.filter is not a
    // function". Once every cluster runs the paginated() fix the inner
    // branch is dead code.
    select: (raw): ReadonlyArray<BundleSummary> => {
      const top = raw?.data;
      if (Array.isArray(top)) return top;
      if (top && typeof top === 'object' && 'data' in top && Array.isArray((top as { data?: unknown }).data)) {
        return (top as { data: ReadonlyArray<BundleSummary> }).data;
      }
      return [];
    },
  });
}

/** Restore carts across all tenants — grouped per tenant in the Backups tab. */
function useAllRestoreCarts() {
  return useQuery({
    queryKey: ['admin', 'restores', 'carts', 'all'],
    queryFn: () => apiFetch<{ data: { data: ReadonlyArray<RestoreJobSummary> } }>(
      '/api/v1/admin/restores/carts?limit=200',
    ),
    staleTime: 15_000,
    select: (raw): ReadonlyArray<RestoreJobSummary> => raw?.data?.data ?? [],
  });
}

function useDeleteCart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cartId: string) =>
      apiFetch<void>(`/api/v1/admin/restores/carts/${cartId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'restores', 'carts', 'all'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'backups', 'tenants', 'overview'] });
    },
  });
}

/**
 * Measure a tenant's true restic repository size.
 *
 * Explicitly a button: `restic stats` walks the repository index over the
 * network. Neither stored size column can stand in for it — see
 * backend/src/modules/backups-overview/repo-stats.ts.
 */
function useRefreshRepoStats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) =>
      apiFetch<{ data: { totalBytes: number; measuredAt: string; components: ReadonlyArray<{ component: string; totalBytes: number | null; error: string | null }> } }>(
        `/api/v1/admin/backups/tenants/${tenantId}/repo-stats/refresh`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'backups', 'tenants', 'overview'] });
    },
  });
}

function useTenantActions(tenantTargetId: string | null) {
  const qc = useQueryClient();
  const invalidate = (tenantId?: string) => {
    qc.invalidateQueries({ queryKey: ['admin', 'backups', 'tenants'] });
    qc.invalidateQueries({ queryKey: ['admin', 'tenant-bundles'] });
    // Also refresh the per-tenant Longhorn snapshot cache shared with
    // TenantSnapshotsPanel (TenantDetail → Snapshots tab), so it isn't
    // stale after a create/delete triggered from this cross-tenant page.
    if (tenantId) qc.invalidateQueries({ queryKey: ['admin-tenant-snapshots', tenantId] });
  };

  const snapshotNow = useMutation({
    // Longhorn on-server snapshot (operator token is authorized for any
    // tenant via the route's requireTenantAccess gate). Replaces the old
    // off-site tar snapshot, whose backup target no longer exists.
    mutationFn: (tenantId: string) =>
      apiFetch(`/api/v1/tenants/${tenantId}/snapshots`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: (_d, tenantId) => invalidate(tenantId),
  });

  const bundleNow = useMutation<
    { data?: { bundleId?: string; status?: string } },
    Error,
    string
  >({
    mutationFn: (tenantId: string) => {
      if (!tenantTargetId) {
        return Promise.reject(
          new Error(
            'No backup target bound to the tenant class. Bind one at /backups/tenants → Targets, Schedules & Retention first.',
          ),
        );
      }
      // async: true → orchestrator returns the bundleId as soon as
      // the backup_jobs row is inserted; the operator sees progress
      // via AdminBundleProgressModal which polls /admin/tenant-bundles/:id.
      return apiFetch<{ data?: { bundleId?: string; status?: string } }>(
        '/api/v1/admin/tenant-bundles',
        {
          method: 'POST',
          body: JSON.stringify({ tenantId, targetConfigId: tenantTargetId, async: true }),
        },
      );
    },
    onSuccess: () => invalidate(),
  });

  const deleteSnapshot = useMutation({
    mutationFn: ({ tenantId, snapshotId }: { tenantId: string; snapshotId: string }) =>
      apiFetch(`/api/v1/tenants/${tenantId}/snapshots/${snapshotId}`, { method: 'DELETE' }),
    onSuccess: (_d, vars) => invalidate(vars.tenantId),
  });

  const createCart = useMutation({
    mutationFn: ({ tenantId, bundleId }: { tenantId: string; bundleId?: string }) =>
      apiFetch<{ data: { id: string } }>('/api/v1/admin/restores/carts', {
        method: 'POST',
        body: JSON.stringify({ tenantId, ...(bundleId ? { bundleId } : {}) }),
      }),
  });

  return { snapshotNow, bundleNow, deleteSnapshot, createCart };
}

// ── Status pill ──────────────────────────────────────────────────────

function StatusPill({ status }: { readonly status: string }) {
  const tone =
    status === 'completed' || status === 'ready'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
      : status === 'failed' || status === 'errored'
        ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300'
        : status === 'running' || status === 'pending'
          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
          : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200';
  return <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${tone}`}>{status}</span>;
}

// ── Filter bar ───────────────────────────────────────────────────────

interface FilterBarProps {
  readonly search: string;
  readonly setSearch: (v: string) => void;
  readonly rowCount: number;
  readonly tenantOptions: ReadonlyArray<{ id: string; name: string }>;
  readonly selectedTenantId: string | null;
  readonly setSelectedTenantId: (id: string | null) => void;
}

function FilterBar({ search, setSearch, rowCount, tenantOptions, selectedTenantId, setSelectedTenantId }: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative flex-1 min-w-[200px] max-w-md">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by label / target / status…"
          data-testid="tenants-backups-filter"
          className="w-full rounded-md border border-gray-300 bg-white py-1.5 pl-9 pr-3 text-sm placeholder:text-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        />
      </div>
      <select
        value={selectedTenantId ?? ''}
        onChange={(e) => setSelectedTenantId(e.target.value || null)}
        className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        data-testid="tenants-backups-tenant-filter"
      >
        <option value="">All tenants</option>
        {tenantOptions.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
        <Filter size={12} /> {rowCount} row{rowCount === 1 ? '' : 's'}
      </span>
    </div>
  );
}

// ── Snapshots tab ────────────────────────────────────────────────────

interface SnapshotsTabProps {
  readonly rows: ReadonlyArray<TenantSnapshotRow>;
  readonly tenantOptions: ReadonlyArray<{ id: string; name: string }>;
  readonly isLoading: boolean;
  readonly search: string;
  readonly setSearch: (v: string) => void;
  readonly selectedTenantId: string | null;
  readonly setSelectedTenantId: (v: string | null) => void;
  readonly tenantPendingSnapshot: string | null;
  readonly snapshotAll: () => void;
  readonly snapshotAllPending: boolean;
  readonly onSnapshot: (tenantId: string) => void;
  readonly onDelete: (row: TenantSnapshotRow) => void;
  readonly onRestore: (row: TenantSnapshotRow) => void;
  readonly deletePendingFor: string | null;
  /** system_settings.snapshot_expiry_hours (undefined while loading). */
  readonly expiryHours?: number;
}

function SnapshotsTab(p: SnapshotsTabProps) {
  const filtered = useMemo(() => {
    const q = p.search.toLowerCase();
    return p.rows.filter((r) => {
      if (p.selectedTenantId && r.tenantId !== p.selectedTenantId) return false;
      if (!q) return true;
      return (
        (r.label ?? '').toLowerCase().includes(q)
        || r.status.toLowerCase().includes(q)
        || (r.targetName ?? '').toLowerCase().includes(q)
        || (r.tenantName ?? '').toLowerCase().includes(q)
        || r.subsystem.toLowerCase().includes(q)
      );
    });
  }, [p.rows, p.search, p.selectedTenantId]);
  const { sortedData, sortKey, sortDirection, onSort } = useSortable(filtered, 'createdAt', 'desc');
  const th = { currentKey: sortKey, direction: sortDirection, onSort, className: '!px-4 !py-2 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400' };

  return (
    <div className="space-y-4">
      <FilterBar
        search={p.search}
        setSearch={p.setSearch}
        rowCount={filtered.length}
        tenantOptions={p.tenantOptions}
        selectedTenantId={p.selectedTenantId}
        setSelectedTenantId={p.setSelectedTenantId}
      />
      <div
        className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200"
        data-testid="tenant-snapshots-ttl-notice"
      >
        <Clock size={13} className="mt-0.5 flex-shrink-0" />
        <span>
          Snapshots are <strong>temporary</strong> on-cluster block copies for quick rollback — each one is
          automatically reaped {p.expiryHours != null ? `${p.expiryHours} hours` : 'a configured number of hours'} after
          it was taken (Settings → System → snapshot expiry). For durable, off-site copies use <strong>Backups</strong>.
        </span>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={p.snapshotAll}
          disabled={p.snapshotAllPending || p.tenantOptions.length === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
          data-testid="tenants-snapshot-all"
        >
          {p.snapshotAllPending ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
          Snapshot all eligible tenants
        </button>
      </div>

      {p.isLoading && filtered.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 bg-gray-50 px-3 py-6 text-center text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400">
          {p.rows.length === 0
            ? 'No snapshots yet. Use "Snapshot all eligible tenants" above or trigger a per-tenant snapshot below.'
            : 'No snapshots match the filter.'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <SortableHeader label="Tenant" sortKey="tenantName" {...th} />
                <SortableHeader label="Label" sortKey="label" {...th} />
                <SortableHeader label="Subsystem" sortKey="subsystem" {...th} />
                <SortableHeader label="Status" sortKey="status" {...th} />
                <SortableHeader label="Size" sortKey="sizeBytes" {...th} className={`${th.className} text-right`} />
                <SortableHeader label="Created" sortKey="createdAt" {...th} className={`${th.className} text-right`} />
                <SortableHeader label="Expires" sortKey="expiresAt" {...th} className={`${th.className} text-right`} />
                <th className="px-4 py-2">Target</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {sortedData.map((r) => {
                const delBusy = p.deletePendingFor === r.id;
                return (
                  <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="px-4 py-2 font-mono text-xs">{r.tenantName ?? '(missing)'}</td>
                    <td className="px-4 py-2 text-xs">{r.label ?? <span className="text-gray-400">unlabeled</span>}</td>
                    <td className="px-4 py-2 text-xs"><code>{r.subsystem}</code></td>
                    <td className="px-4 py-2"><StatusPill status={r.status} /></td>
                    <td className="px-4 py-2 text-right tabular-nums text-xs">{formatBytes(r.sizeBytes)}</td>
                    <td className="px-4 py-2 text-right text-xs text-gray-500"><TimeCell iso={r.createdAt} /></td>
                    <td className="px-4 py-2 text-right text-xs text-gray-500"><TimeCell iso={r.expiresAt} mode="until" /></td>
                    <td className="px-4 py-2 text-xs">{r.targetName ?? <span className="text-gray-400">none</span>}</td>
                    <td className="px-4 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => p.onRestore(r)}
                          className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                          data-testid={`tenant-snap-restore-${r.id}`}
                        >
                          <RotateCw size={11} /> Restore…
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`Delete snapshot "${r.label ?? r.id}"? This cannot be undone.`)) {
                              p.onDelete(r);
                            }
                          }}
                          disabled={delBusy}
                          className="inline-flex items-center gap-1 rounded border border-rose-300 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
                          data-testid={`tenant-snap-delete-${r.id}`}
                        >
                          {delBusy ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <details className="rounded-lg border border-gray-200 bg-white p-3 text-xs dark:border-gray-700 dark:bg-gray-800">
        <summary className="cursor-pointer font-medium text-gray-700 dark:text-gray-300">
          Trigger a snapshot for a single tenant
        </summary>
        <ul className="mt-2 space-y-1">
          {p.tenantOptions.map((t) => {
            const busy = p.tenantPendingSnapshot === t.id;
            return (
              <li key={t.id} className="flex items-center justify-between">
                <span className="font-mono text-xs">{t.name}</span>
                <button
                  type="button"
                  onClick={() => p.onSnapshot(t.id)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded border border-brand-300 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
                  data-testid={`tenant-row-snapshot-${t.id}`}
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Camera size={11} />}
                  Snapshot
                </button>
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}

// ── Backups tab ──────────────────────────────────────────────────────

interface BackupsTabProps {
  readonly rows: ReadonlyArray<BundleSummary>;
  readonly tenantOptions: ReadonlyArray<{ id: string; name: string }>;
  readonly isLoading: boolean;
  readonly search: string;
  readonly setSearch: (v: string) => void;
  readonly selectedTenantId: string | null;
  readonly setSelectedTenantId: (v: string | null) => void;
  readonly tenantPendingBundle: string | null;
  readonly bundleAll: () => void;
  readonly bundleAllPending: boolean;
  readonly onBundle: (tenantId: string) => void;
  readonly onRestore: (row: BundleSummary) => void;
  /** Reopen an existing restore cart at the bundle it was started from. */
  readonly onResumeCart: (cart: RestoreJobSummary) => void;
  readonly tenantTargetBound: boolean;
  /** Per-tenant rollup including the inclusion-in-scheduled-bundles flag. */
  readonly rollupRows: ReadonlyArray<TenantBackupOverviewRow>;
  /** Set/clear the per-tenant scheduled-bundles override. */
  readonly onSetInclusionOverride: (tenantId: string, override: 'inherit' | 'on' | 'off') => void;
  /** Tenant id with an inclusion PATCH in flight (spinner). */
  readonly inclusionPendingFor: string | null;
}

function BackupsTab(p: BackupsTabProps) {
  const filtered = useMemo(() => {
    const q = p.search.toLowerCase();
    return p.rows.filter((r) => {
      if (p.selectedTenantId && r.tenantId !== p.selectedTenantId) return false;
      if (!q) return true;
      return (
        r.status.toLowerCase().includes(q)
        || (r.label ?? '').toLowerCase().includes(q)
        || (r.tenantName ?? '').toLowerCase().includes(q)
        || (r.lastError ?? '').toLowerCase().includes(q)
      );
    });
  }, [p.rows, p.search, p.selectedTenantId]);
  const { sortedData } = useSortable(filtered, 'createdAt', 'desc');

  // ── Grouping ───────────────────────────────────────────────────────
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = (tenantId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tenantId)) next.delete(tenantId); else next.add(tenantId);
      return next;
    });
  };

  const cartsQ = useAllRestoreCarts();
  const deleteCart = useDeleteCart();
  const refreshStats = useRefreshRepoStats();

  const cartsByTenant = useMemo(() => {
    const m = new Map<string, RestoreJobSummary[]>();
    for (const c of cartsQ.data ?? []) {
      const list = m.get(c.tenantId);
      if (list) list.push(c); else m.set(c.tenantId, [c]);
    }
    return m;
  }, [cartsQ.data]);

  const rollupByTenant = useMemo(
    () => new Map(p.rollupRows.map((r) => [r.tenantId, r])),
    [p.rollupRows],
  );

  // Bundles grouped by tenant, each group's bundles keeping the sorted
  // (newest-first) order from above.
  const groups = useMemo(() => {
    const m = new Map<string, { tenantId: string; tenantName: string; bundles: BundleSummary[]; totalBytes: number }>();
    for (const r of sortedData) {
      const g = m.get(r.tenantId);
      if (g) {
        g.bundles.push(r);
        g.totalBytes += r.sizeBytes;
      } else {
        m.set(r.tenantId, {
          tenantId: r.tenantId,
          tenantName: r.tenantName ?? r.tenantId.slice(0, 8),
          bundles: [r],
          totalBytes: r.sizeBytes,
        });
      }
    }
    return [...m.values()].sort((a, b) =>
      a.tenantName.localeCompare(b.tenantName, undefined, { sensitivity: 'base' }));
  }, [sortedData]);

  // Per-tenant backup counts across ALL bundles (unfiltered) — makes
  // "this tenant has N backups" visible at a glance and doubles as a
  // one-click tenant filter.
  const perTenant = useMemo(() => {
    const m = new Map<string, { name: string; count: number }>();
    for (const r of p.rows) {
      const cur = m.get(r.tenantId);
      if (cur) m.set(r.tenantId, { ...cur, count: cur.count + 1 });
      else m.set(r.tenantId, { name: r.tenantName ?? r.tenantId.slice(0, 8), count: 1 });
    }
    return [...m.entries()]
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [p.rows]);

  return (
    <div className="space-y-4">
      <FilterBar
        search={p.search}
        setSearch={p.setSearch}
        rowCount={filtered.length}
        tenantOptions={p.tenantOptions}
        selectedTenantId={p.selectedTenantId}
        setSelectedTenantId={p.setSelectedTenantId}
      />
      {perTenant.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="tenant-bundle-counts">
          <span className="text-gray-500 dark:text-gray-400">Backups per tenant:</span>
          {perTenant.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => p.setSelectedTenantId(p.selectedTenantId === t.id ? null : t.id)}
              className={`rounded-full border px-2 py-0.5 font-mono transition-colors ${
                p.selectedTenantId === t.id
                  ? 'border-brand-400 bg-brand-100 text-brand-800 dark:border-brand-600 dark:bg-brand-900/40 dark:text-brand-200'
                  : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
              }`}
              data-testid={`tenant-bundle-count-${t.id}`}
            >
              {t.name} ×{t.count}
            </button>
          ))}
        </div>
      )}
      {/* Inclusion summary + editor — which tenants the platform-global
          daily scheduler bundles (hosting_plans.include_in_scheduled_bundles
          with per-tenant override), editable in place. */}
      {(() => {
        const total = p.rollupRows.length;
        const included = p.rollupRows.filter((r) => r.includedInScheduledBundles).length;
        const excludedCount = total - included;
        if (total === 0) return null;
        const sortedRollup = [...p.rollupRows]
          .sort((a, b) => a.tenantName.localeCompare(b.tenantName, undefined, { sensitivity: 'base' }));
        return (
          <details
            className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs dark:border-gray-700 dark:bg-gray-800/50"
            data-testid="tenant-inclusion-summary"
          >
            <summary className="cursor-pointer font-medium text-gray-700 dark:text-gray-300">
              Scheduled inclusion: {included}/{total} tenants in the daily backup cron
              {excludedCount > 0 && ` (${excludedCount} excluded)`}
            </summary>
            <div className="mt-2 space-y-1 text-gray-600 dark:text-gray-400">
              <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedRollup.map((r) => {
                  const busy = p.inclusionPendingFor === r.tenantId;
                  return (
                    <li
                      key={r.tenantId}
                      className="flex items-center justify-between gap-2 py-1"
                      data-testid={`inclusion-row-${r.tenantId}`}
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-[11px]">{r.tenantName}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                            r.includedInScheduledBundles
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                              : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                          }`}
                        >
                          {r.includedInScheduledBundles ? 'included' : 'excluded'}
                        </span>
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        {busy && <Loader2 size={11} className="animate-spin text-gray-400" />}
                        <select
                          value={r.scheduledBundlesOverride}
                          disabled={busy}
                          onChange={(e) => p.onSetInclusionOverride(r.tenantId, e.target.value as 'inherit' | 'on' | 'off')}
                          className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[11px] disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                          data-testid={`inclusion-override-${r.tenantId}`}
                        >
                          <option value="inherit">Inherit plan{r.planName ? ` (${r.planName})` : ''}</option>
                          <option value="on">Always include</option>
                          <option value="off">Exclude from schedule</option>
                        </select>
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-500">
                “Inherit plan” follows the plan's <code>include_in_scheduled_bundles</code> default; the explicit
                options override it for this tenant only. Changes take effect at the next scheduled run.
              </p>
            </div>
          </details>
        );
      })()}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={p.bundleAll}
          disabled={p.bundleAllPending || p.tenantOptions.length === 0 || !p.tenantTargetBound}
          className="inline-flex items-center gap-1.5 rounded-md border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
          data-testid="tenants-bundle-all"
          title={p.tenantTargetBound ? 'Create a bundle for every eligible tenant' : 'Bind a target on tab (c) first'}
        >
          {p.bundleAllPending ? <Loader2 size={12} className="animate-spin" /> : <Archive size={12} />}
          Bundle all eligible tenants
        </button>
      </div>

      {p.isLoading && filtered.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 bg-gray-50 px-3 py-6 text-center text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400">
          {p.rows.length === 0
            ? 'No tenant bundles yet. Trigger one with "Bundle all eligible tenants" or per-tenant below.'
            : 'No bundles match the filter.'}
        </div>
      ) : (
        // Grouped by tenant. A flat cross-tenant list answers "what happened
        // recently"; an operator looking at backups is almost always asking
        // "how is THIS tenant covered", which meant scanning a mixed table.
        // Each group collapses to one line and opens onto that tenant's
        // bundles, sizes and restore carts.
        <div className="space-y-2" data-testid="tenant-backup-groups">
          {groups.map((g) => {
            const open = expanded.has(g.tenantId);
            const carts = cartsByTenant.get(g.tenantId) ?? [];
            const roll = rollupByTenant.get(g.tenantId);
            const statsBusy = refreshStats.isPending && refreshStats.variables === g.tenantId;
            return (
              <div
                key={g.tenantId}
                className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700"
                data-testid={`tenant-backup-group-${g.tenantId}`}
              >
                <button
                  type="button"
                  onClick={() => toggleGroup(g.tenantId)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-3 bg-gray-50 px-4 py-2 text-left hover:bg-gray-100 dark:bg-gray-800 dark:hover:bg-gray-700"
                  data-testid={`tenant-backup-group-toggle-${g.tenantId}`}
                >
                  {open ? <ChevronDown size={14} className="shrink-0 text-gray-500" /> : <ChevronRight size={14} className="shrink-0 text-gray-500" />}
                  <span className="font-medium text-gray-900 dark:text-gray-100">{g.tenantName}</span>
                  <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[11px] text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                    {g.bundles.length} backup{g.bundles.length === 1 ? '' : 's'}
                  </span>
                  {carts.length > 0 && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                      {carts.length} restore cart{carts.length === 1 ? '' : 's'}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                    {/* Two DIFFERENT numbers, labelled as such. Total bundle
                        size is the logical sum; restic dedupes, so it is not
                        what the repository occupies. Repo size is measured. */}
                    <span title="Sum of every bundle's logical size. Not storage consumed — restic deduplicates across snapshots.">
                      bundles {formatBytes(g.totalBytes)}
                    </span>
                    <span
                      className="tabular-nums"
                      title={roll?.repoStatsAt
                        ? `Measured ${new Date(roll.repoStatsAt).toLocaleString()} with restic stats`
                        : 'Never measured — press Refresh to measure the repository'}
                      data-testid={`tenant-repo-size-${g.tenantId}`}
                    >
                      repo {roll?.repoTotalBytes != null ? formatBytes(roll.repoTotalBytes) : 'not measured'}
                    </span>
                  </span>
                </button>

                {open && (
                  <div className="space-y-3 border-t border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      <button
                        type="button"
                        onClick={() => refreshStats.mutate(g.tenantId)}
                        disabled={statsBusy}
                        className="inline-flex items-center gap-1 rounded border border-brand-300 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
                        data-testid={`tenant-repo-refresh-${g.tenantId}`}
                        title="Run restic stats against this tenant's repository. Walks the repo index, so it takes a moment."
                      >
                        {statsBusy ? <Loader2 size={11} className="animate-spin" /> : <RotateCw size={11} />}
                        Refresh repo size
                      </button>
                      <span className="text-gray-500 dark:text-gray-400">
                        Last backup size {roll ? formatBytes(roll.bundleBytes / Math.max(roll.bundleCount, 1)) : '—'} avg ·
                        {' '}{roll?.repoStatsAt ? `repo measured ${new Date(roll.repoStatsAt).toLocaleDateString()}` : 'repo never measured'}
                      </span>
                      {refreshStats.isError && refreshStats.variables === g.tenantId && (
                        <span className="text-red-600 dark:text-red-400">
                          {refreshStats.error instanceof Error ? refreshStats.error.message : 'Could not measure the repository'}
                        </span>
                      )}
                    </div>

                    {carts.length > 0 && (
                      <div data-testid={`tenant-carts-${g.tenantId}`}>
                        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          Restore carts
                        </h4>
                        <ul className="space-y-1">
                          {carts.map((c) => (
                            <li
                              key={c.id}
                              className="flex items-center gap-2 rounded border border-gray-100 px-2 py-1 text-xs dark:border-gray-700"
                              data-testid={`admin-cart-row-${c.id}`}
                            >
                              <span className="font-mono text-gray-700 dark:text-gray-300">{c.id.slice(0, 12)}…</span>
                              <StatusPill status={c.status} />
                              <span className="text-gray-500 dark:text-gray-400">{c.description ?? 'no description'}</span>
                              <span className="ml-auto flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => p.onResumeCart(c)}
                                  disabled={!c.bundleId || c.status === 'executing'}
                                  title={!c.bundleId
                                    ? 'This cart has no items yet — nothing to resume'
                                    : c.status === 'executing'
                                      ? 'This restore is already running'
                                      : 'Reopen this cart where it was left'}
                                  className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                                  data-testid={`admin-cart-resume-${c.id}`}
                                >
                                  <RotateCw size={10} /> Resume
                                </button>
                                <button
                                  type="button"
                                  onClick={() => deleteCart.mutate(c.id)}
                                  disabled={c.status === 'executing' || (deleteCart.isPending && deleteCart.variables === c.id)}
                                  title={c.status === 'executing'
                                    ? 'A running restore cannot be deleted'
                                    : 'Delete this restore cart'}
                                  className="inline-flex items-center gap-1 rounded border border-red-300 px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-40 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/30"
                                  data-testid={`admin-cart-delete-${c.id}`}
                                >
                                  {deleteCart.isPending && deleteCart.variables === c.id
                                    ? <Loader2 size={10} className="animate-spin" />
                                    : <Trash2 size={10} />}
                                  Delete
                                </button>
                              </span>
                            </li>
                          ))}
                        </ul>
                        {deleteCart.isError && (
                          <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                            {deleteCart.error instanceof Error ? deleteCart.error.message : 'Could not delete the cart'}
                          </p>
                        )}
                      </div>
                    )}

                    <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
                      <thead>
                        <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
                          <th className="px-2 py-1">Label</th>
                          <th className="px-2 py-1">Status</th>
                          <th className="px-2 py-1 text-right">Size</th>
                          <th className="px-2 py-1 text-right">Created</th>
                          <th className="px-2 py-1">Initiator</th>
                          <th className="px-2 py-1 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                        {g.bundles.map((r) => (
                          <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                            <td className="px-2 py-1 text-xs">{r.label ?? <span className="text-gray-400">unlabeled</span>}</td>
                            <td className="px-2 py-1"><StatusPill status={r.status} /></td>
                            <td className="px-2 py-1 text-right tabular-nums text-xs">{formatBytes(r.sizeBytes)}</td>
                            <td className="px-2 py-1 text-right text-xs text-gray-500"><TimeCell iso={r.createdAt} /></td>
                            <td className="px-2 py-1 text-xs"><code>{r.initiator}</code></td>
                            <td className="px-2 py-1 text-right">
                              <button
                                type="button"
                                onClick={() => p.onRestore(r)}
                                // `partial` bundles can be restored — they're missing one
                                // or more components (typically mailboxes when Stalwart
                                // is misconfigured), but the components that DID complete
                                // still have valid artifacts and are restorable via the
                                // cart, which skips items whose component is missing.
                                disabled={r.status !== 'completed' && r.status !== 'partial'}
                                className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                                data-testid={`tenant-bundle-restore-${r.id}`}
                                title={
                                  r.status === 'completed' ? 'Open the Restoration Wizard'
                                  : r.status === 'partial' ? 'Open the Restoration Wizard (some components are missing — see bundle detail)'
                                  : `Bundles in '${r.status}' state cannot be restored`
                                }
                              >
                                <RotateCw size={11} /> Restore…
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <details className="rounded-lg border border-gray-200 bg-white p-3 text-xs dark:border-gray-700 dark:bg-gray-800">
        <summary className="cursor-pointer font-medium text-gray-700 dark:text-gray-300">
          Trigger a bundle for a single tenant
        </summary>
        <ul className="mt-2 space-y-1">
          {p.tenantOptions.map((t) => {
            const busy = p.tenantPendingBundle === t.id;
            return (
              <li key={t.id} className="flex items-center justify-between">
                <span className="font-mono text-xs">{t.name}</span>
                <button
                  type="button"
                  onClick={() => p.onBundle(t.id)}
                  disabled={busy || !p.tenantTargetBound}
                  className="inline-flex items-center gap-1 rounded border border-brand-300 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
                  data-testid={`tenant-row-bundle-${t.id}`}
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <Archive size={11} />}
                  Bundle
                </button>
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────

export default function TenantsBackupsPage() {
  const [search, setSearch] = useState('');
  // Deep-linkable tenant filter (?tenant=<id>) — TenantDetail links here
  // to show one tenant's full backup history.
  const [params] = useSearchParams();
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(params.get('tenant'));
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: shimResp } = useShimAssignments();
  const tenantTargetId =
    shimResp?.data?.assignments?.find((a) => a.className === 'tenant')?.targetId ?? null;
  const tenantTargetBound = !!tenantTargetId;

  const { data: rollupData } = useTenantsRollup();
  const tenantOptions = useMemo(
    () => (rollupData?.data?.rows ?? [])
      .map((r: TenantBackupOverviewRow) => ({ id: r.tenantId, name: r.tenantName }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [rollupData],
  );

  // Per-tenant scheduled-bundles override (inclusion editor in BackupsTab).
  const setInclusion = useMutation({
    mutationFn: ({ tenantId, override }: { tenantId: string; override: 'inherit' | 'on' | 'off' }) =>
      // Same route the tenant editor uses (PATCH /api/v1/tenants/:id,
      // requireRole super_admin|admin) — there is no /admin/tenants path.
      apiFetch(`/api/v1/tenants/${tenantId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          include_in_scheduled_bundles_override: override === 'inherit' ? null : override === 'on',
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'backups', 'tenants', 'overview'] }),
  });

  const snapshotsQ = useTenantSnapshots(selectedTenantId);
  const bundlesQ = useTenantBundles(selectedTenantId);

  const { snapshotNow, bundleNow, deleteSnapshot, createCart } = useTenantActions(tenantTargetId);

  const [error, setError] = useState<string | null>(null);
  const [wizardSnap, setWizardSnap] = useState<TenantSnapshotRow | null>(null);
  const [wizardBundle, setWizardBundle] = useState<BundleSummary | null>(null);
  const [snapshotAllPending, setSnapshotAllPending] = useState(false);
  const [bundleAllPending, setBundleAllPending] = useState(false);
  // Bundle id of the most recent ad-hoc "Bundle now" click — opens
  // the AdminBundleProgressModal. Cleared via modal Dismiss/Close
  // (the bundle keeps running in the background regardless).
  const [progressBundleId, setProgressBundleId] = useState<string | null>(null);

  const fireMany = async (
    tenantIds: ReadonlyArray<string>,
    fn: (id: string) => Promise<unknown>,
    label: string,
  ): Promise<void> => {
    setError(null);
    const results = await Promise.allSettled(tenantIds.map((id) => fn(id)));
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (failed.length > 0) {
      const first = failed[0].reason;
      const msg = first instanceof Error ? first.message : String(first);
      setError(`${label}: ${failed.length}/${tenantIds.length} tenants failed (${msg})`);
    }
  };

  const eligibleForBundle = (rollupData?.data?.rows ?? [])
    .filter((r) => r.includedInScheduledBundles)
    .map((r) => r.tenantId);
  const allTenantIds = tenantOptions.map((t) => t.id);

  const handlers = {
    snapshotAll: async () => {
      setSnapshotAllPending(true);
      try {
        await fireMany(allTenantIds, (id) => snapshotNow.mutateAsync(id), 'Snapshot all');
      } finally {
        setSnapshotAllPending(false);
      }
    },
    bundleAll: async () => {
      setBundleAllPending(true);
      try {
        await fireMany(eligibleForBundle, (id) => bundleNow.mutateAsync(id), 'Bundle all');
      } finally {
        setBundleAllPending(false);
      }
    },
    onSnapshot: (tenantId: string) => {
      setError(null);
      snapshotNow.mutate(tenantId, {
        onError: (e) => setError(`Snapshot failed: ${e instanceof Error ? e.message : String(e)}`),
      });
    },
    onBundle: (tenantId: string) => {
      setError(null);
      bundleNow.mutate(tenantId, {
        onSuccess: (res) => {
          const id = res?.data?.bundleId;
          if (id) setProgressBundleId(id);
        },
        onError: (e) => setError(`Bundle failed: ${e instanceof Error ? e.message : String(e)}`),
      });
    },
    onDelete: (row: TenantSnapshotRow) => {
      setError(null);
      deleteSnapshot.mutate({ tenantId: row.tenantId, snapshotId: row.id }, {
        onError: (e) => setError(`Delete failed: ${e instanceof Error ? e.message : String(e)}`),
      });
    },
    onRestoreSnap: (row: TenantSnapshotRow) => {
      setError(null);
      setWizardSnap(row);
    },
    onRestoreBundle: (row: BundleSummary) => {
      setError(null);
      setWizardBundle(row);
    },
    // Reopen an EXISTING cart rather than starting a new one. The admin
    // RestoreCart page already reads `?cartId=`, so resuming is navigation —
    // the piece that was missing was surfacing the carts at all.
    onResumeCart: (cart: RestoreJobSummary) => {
      setError(null);
      if (!cart.bundleId) return;
      navigate(
        `/backups/restore?bundleId=${encodeURIComponent(cart.bundleId)}`
        + `&tenantId=${encodeURIComponent(cart.tenantId)}`
        + `&cartId=${encodeURIComponent(cart.id)}`,
      );
    },
  };

  const buildSnapArtifact = (row: TenantSnapshotRow): RestoreArtifact => ({
    kind: 'snapshot',
    id: row.id,
    displayName: `${row.tenantName ?? row.tenantId} / ${row.label ?? row.id}`,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  });

  const buildBundleArtifact = (row: BundleSummary): RestoreArtifact => ({
    kind: 'tenant-bundle',
    id: row.id,
    displayName: `${row.tenantName ?? row.tenantId} / bundle ${row.id.slice(0, 8)}`,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    cartUrl: `/backups/restore?tenantId=${row.tenantId}&bundleId=${row.id}`,
  });

  const errorBanner = error ? (
    <div role="alert" className="flex items-start gap-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
      <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
      <span className="flex-1">{error}</span>
      <button type="button" aria-label="Dismiss error" onClick={() => setError(null)} className="text-rose-700 hover:underline dark:text-rose-300">×</button>
    </div>
  ) : null;

  return (
    <>
      <BackupClassPage
        icon={Package}
        title="Tenant Backups"
        subtitle="Per-tenant snapshots (PVC block copies) and bundles (files + mailboxes + config). One row per snapshot or bundle — filter by tenant or free-text to drill in."
        shimClass="tenant"
        scheduleSubsystems={['tenant_bundle']}
        snapshotsTab={
          <div className="space-y-3">
            {errorBanner}
            <SnapshotsTab
              rows={snapshotsQ.data?.data?.rows ?? []}
              tenantOptions={tenantOptions}
              isLoading={snapshotsQ.isLoading}
              search={search}
              setSearch={setSearch}
              selectedTenantId={selectedTenantId}
              setSelectedTenantId={setSelectedTenantId}
              tenantPendingSnapshot={snapshotNow.isPending ? (snapshotNow.variables ?? null) : null}
              snapshotAll={handlers.snapshotAll}
              snapshotAllPending={snapshotAllPending}
              onSnapshot={handlers.onSnapshot}
              onDelete={handlers.onDelete}
              onRestore={handlers.onRestoreSnap}
              deletePendingFor={deleteSnapshot.isPending ? (deleteSnapshot.variables?.snapshotId ?? null) : null}
              expiryHours={snapshotsQ.data?.data?.expiryHours}
            />
          </div>
        }
        backupsTab={
          <div className="space-y-3">
            {errorBanner}
            <BackupsTab
              rows={bundlesQ.data ?? []}
              tenantOptions={tenantOptions}
              isLoading={bundlesQ.isLoading}
              search={search}
              setSearch={setSearch}
              selectedTenantId={selectedTenantId}
              setSelectedTenantId={setSelectedTenantId}
              tenantPendingBundle={bundleNow.isPending ? (bundleNow.variables ?? null) : null}
              bundleAll={handlers.bundleAll}
              bundleAllPending={bundleAllPending}
              onBundle={handlers.onBundle}
              onRestore={handlers.onRestoreBundle}
              onResumeCart={handlers.onResumeCart}
              tenantTargetBound={tenantTargetBound}
              rollupRows={rollupData?.data?.rows ?? []}
              onSetInclusionOverride={(tenantId, override) => {
                setError(null);
                setInclusion.mutate({ tenantId, override }, {
                  onError: (e) => setError(`Inclusion change failed: ${e instanceof Error ? e.message : String(e)}`),
                });
              }}
              inclusionPendingFor={setInclusion.isPending ? (setInclusion.variables?.tenantId ?? null) : null}
            />
          </div>
        }
      />

      {wizardSnap && (
        <RestorationWizard
          artifact={buildSnapArtifact(wizardSnap)}
          onClose={() => setWizardSnap(null)}
          onSubmit={async () => {
            // Longhorn in-place revert (snapshotRevert). Operator token is
            // authorized for any tenant via requireTenantAccess.
            const r = await apiFetch<{ data: { operationId: string } }>(
              `/api/v1/tenants/${wizardSnap.tenantId}/snapshots/${wizardSnap.id}/restore`,
              { method: 'POST' },
            );
            return { taskId: r.data.operationId };
          }}
        />
      )}

      {wizardBundle && (
        <RestorationWizard
          artifact={buildBundleArtifact(wizardBundle)}
          onClose={() => setWizardBundle(null)}
          onSubmit={async () => {
            const cart = await createCart.mutateAsync({ tenantId: wizardBundle.tenantId, bundleId: wizardBundle.id });
            navigate(`/backups/restore?cartId=${cart.data.id}&tenantId=${wizardBundle.tenantId}&bundleId=${wizardBundle.id}`);
            return { taskId: cart.data.id };
          }}
        />
      )}

      {progressBundleId && (
        <AdminBundleProgressModal
          bundleId={progressBundleId}
          onClose={() => setProgressBundleId(null)}
        />
      )}
    </>
  );
}
