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
import { useNavigate } from 'react-router-dom';
import {
  Package, Search, Loader2, Filter, Camera, Archive, RotateCw, AlertCircle, Trash2,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  BundleSummary,
  TenantsBackupsOverviewResponse,
  TenantBackupOverviewRow,
} from '@k8s-hosting/api-contracts';
import BackupClassPage from './BackupClassPage';
import RestorationWizard, { type RestoreArtifact } from '@/components/backups/RestorationWizard';
import { useShimAssignments } from '@/hooks/use-backup-rclone-shim';

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
}

// ── Formatters ───────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (!b) return '—';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MiB`;
  return `${(b / 1024).toFixed(0)} KiB`;
}

function formatAge(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms <= 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
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

function useTenantActions(tenantTargetId: string | null) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'backups', 'tenants'] });
    qc.invalidateQueries({ queryKey: ['admin', 'tenant-bundles'] });
  };

  const snapshotNow = useMutation({
    mutationFn: (tenantId: string) =>
      apiFetch(`/api/v1/admin/tenants/${tenantId}/storage/snapshot`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: invalidate,
  });

  const bundleNow = useMutation({
    mutationFn: (tenantId: string) => {
      if (!tenantTargetId) {
        return Promise.reject(
          new Error(
            'No backup target bound to the tenant class. Bind one at /backups/tenants → Targets, Schedules & Retention first.',
          ),
        );
      }
      return apiFetch('/api/v1/admin/tenant-bundles', {
        method: 'POST',
        body: JSON.stringify({ tenantId, targetConfigId: tenantTargetId }),
      });
    },
    onSuccess: invalidate,
  });

  const deleteSnapshot = useMutation({
    mutationFn: (snapshotId: string) =>
      apiFetch(`/api/v1/admin/storage/snapshots/${snapshotId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
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
  readonly onDelete: (snapshotId: string) => void;
  readonly onRestore: (row: TenantSnapshotRow) => void;
  readonly deletePendingFor: string | null;
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
                <th className="px-4 py-2">Tenant</th>
                <th className="px-4 py-2">Label</th>
                <th className="px-4 py-2">Subsystem</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Size</th>
                <th className="px-4 py-2 text-right">Created</th>
                <th className="px-4 py-2">Target</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {filtered.map((r) => {
                const delBusy = p.deletePendingFor === r.id;
                return (
                  <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                    <td className="px-4 py-2 font-mono text-xs">{r.tenantName ?? '(missing)'}</td>
                    <td className="px-4 py-2 text-xs">{r.label ?? <span className="text-gray-400">unlabeled</span>}</td>
                    <td className="px-4 py-2 text-xs"><code>{r.subsystem}</code></td>
                    <td className="px-4 py-2"><StatusPill status={r.status} /></td>
                    <td className="px-4 py-2 text-right tabular-nums text-xs">{formatBytes(r.sizeBytes)}</td>
                    <td className="px-4 py-2 text-right text-xs text-gray-500">{formatAge(r.createdAt)}</td>
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
                              p.onDelete(r.id);
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
  readonly tenantTargetBound: boolean;
  /** Per-tenant rollup including the inclusion-in-scheduled-bundles flag. */
  readonly rollupRows: ReadonlyArray<TenantBackupOverviewRow>;
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
      {/* Inclusion summary — operator-visible breakdown of which
          tenants will be picked up by the platform-global daily
          scheduler (driven by hosting_plans.include_in_scheduled_bundles
          with per-tenant override). */}
      {(() => {
        const total = p.rollupRows.length;
        const included = p.rollupRows.filter((r) => r.includedInScheduledBundles).length;
        const excluded = p.rollupRows.filter((r) => !r.includedInScheduledBundles);
        if (total === 0) return null;
        return (
          <details
            className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs dark:border-gray-700 dark:bg-gray-800/50"
            data-testid="tenant-inclusion-summary"
          >
            <summary className="cursor-pointer font-medium text-gray-700 dark:text-gray-300">
              Scheduled inclusion: {included}/{total} tenants in the daily backup cron
              {excluded.length > 0 && ` (${excluded.length} excluded)`}
            </summary>
            {excluded.length > 0 && (
              <div className="mt-2 space-y-0.5 text-gray-600 dark:text-gray-400">
                <p className="font-medium">Excluded tenants (no scheduled bundles will run for these):</p>
                <ul className="ml-4 list-disc">
                  {excluded.map((r) => (
                    <li key={r.tenantId} className="font-mono text-[11px]" data-testid={`excluded-tenant-${r.tenantId}`}>
                      {r.tenantName ?? r.tenantId} —{' '}
                      {r.tenantId.slice(0, 8)}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-500">
                  Operator can change inclusion on the tenant detail page (per-tenant override) or on the plan (default for all
                  tenants on that plan).
                </p>
              </div>
            )}
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
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <th className="px-4 py-2">Tenant</th>
                <th className="px-4 py-2">Label</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Size</th>
                <th className="px-4 py-2 text-right">Created</th>
                <th className="px-4 py-2">Initiator</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {filtered.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                  <td className="px-4 py-2 font-mono text-xs">{r.tenantName ?? '(missing)'}</td>
                  <td className="px-4 py-2 text-xs">{r.label ?? <span className="text-gray-400">unlabeled</span>}</td>
                  <td className="px-4 py-2"><StatusPill status={r.status} /></td>
                  <td className="px-4 py-2 text-right tabular-nums text-xs">{formatBytes(r.sizeBytes)}</td>
                  <td className="px-4 py-2 text-right text-xs text-gray-500">{formatAge(r.createdAt)}</td>
                  <td className="px-4 py-2 text-xs"><code>{r.initiator}</code></td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => p.onRestore(r)}
                      disabled={r.status !== 'completed'}
                      className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                      data-testid={`tenant-bundle-restore-${r.id}`}
                      title={r.status === 'completed' ? 'Open the Restoration Wizard' : 'Only completed bundles can be restored'}
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
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const navigate = useNavigate();

  const { data: shimResp } = useShimAssignments();
  const tenantTargetId =
    shimResp?.data?.assignments?.find((a) => a.className === 'tenant')?.targetId ?? null;
  const tenantTargetBound = !!tenantTargetId;

  const { data: rollupData } = useTenantsRollup();
  const tenantOptions = useMemo(
    () => (rollupData?.data?.rows ?? []).map((r: TenantBackupOverviewRow) => ({ id: r.tenantId, name: r.tenantName })),
    [rollupData],
  );

  const snapshotsQ = useTenantSnapshots(selectedTenantId);
  const bundlesQ = useTenantBundles(selectedTenantId);

  const { snapshotNow, bundleNow, deleteSnapshot, createCart } = useTenantActions(tenantTargetId);

  const [error, setError] = useState<string | null>(null);
  const [wizardSnap, setWizardSnap] = useState<TenantSnapshotRow | null>(null);
  const [wizardBundle, setWizardBundle] = useState<BundleSummary | null>(null);
  const [snapshotAllPending, setSnapshotAllPending] = useState(false);
  const [bundleAllPending, setBundleAllPending] = useState(false);

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
        onError: (e) => setError(`Bundle failed: ${e instanceof Error ? e.message : String(e)}`),
      });
    },
    onDelete: (snapshotId: string) => {
      setError(null);
      deleteSnapshot.mutate(snapshotId, {
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
              deletePendingFor={deleteSnapshot.isPending ? (deleteSnapshot.variables ?? null) : null}
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
              tenantTargetBound={tenantTargetBound}
              rollupRows={rollupData?.data?.rows ?? []}
            />
          </div>
        }
      />

      {wizardSnap && (
        <RestorationWizard
          artifact={buildSnapArtifact(wizardSnap)}
          onClose={() => setWizardSnap(null)}
          onSubmit={async () => {
            const r = await apiFetch<{ data: { operationId: string } }>(
              `/api/v1/admin/tenants/${wizardSnap.tenantId}/storage/rollback`,
              { method: 'POST', body: JSON.stringify({ snapshotId: wizardSnap.id }) },
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
    </>
  );
}
