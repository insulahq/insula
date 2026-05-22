/**
 * `/backups/tenants` — Tenants backup-class page.
 *
 * Phase 7 (2026-05-22) added per-row actions so operators can
 * actually trigger and restore from this page:
 *   - "Snapshot" → POST /admin/tenants/:id/storage/snapshot
 *   - "Bundle"   → POST /admin/tenants/:id/backups
 *   - "Restore…" → opens RestorationWizard; on submit creates a
 *                  restore cart for this tenant + navigates to the
 *                  Plesk-style cart page.
 *
 * Phase 3 IA decision (unchanged): flat-aggregate table across all
 * tenants with a tenant filter chip + Tenant column on every row.
 * No per-tenant detail page — the Restoration Wizard supplies the
 * per-row drill via modal.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Search, Loader2, Filter, Camera, Archive, RotateCw, AlertCircle } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { TenantsBackupsOverviewResponse, TenantBackupOverviewRow } from '@k8s-hosting/api-contracts';
import BackupClassPage from './BackupClassPage';
import RestorationWizard, {
  type RestoreArtifact,
  type RestoreSelection,
} from '@/components/backups/RestorationWizard';

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

function useTenantsOverview(search: string) {
  return useQuery({
    queryKey: ['admin', 'backups', 'tenants', 'overview', { search }],
    queryFn: () => apiFetch<{ data: TenantsBackupsOverviewResponse }>(
      `/api/v1/admin/backups/tenants/overview${search ? `?filter=${encodeURIComponent(search)}` : ''}`,
    ),
    staleTime: 15_000,
  });
}

function useTenantActions() {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['admin', 'backups', 'tenants', 'overview'] });

  const snapshotNow = useMutation({
    mutationFn: (tenantId: string) =>
      apiFetch(`/api/v1/admin/tenants/${tenantId}/storage/snapshot`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: invalidate,
  });

  const bundleNow = useMutation({
    mutationFn: (tenantId: string) =>
      apiFetch(`/api/v1/admin/tenants/${tenantId}/backups`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: invalidate,
  });

  /** Restore wiring uses the existing cart create endpoint, then the
   *  RestorationWizard's onCompleted handler navigates to the cart
   *  page so the operator can pick components + execute. */
  const createCart = useMutation({
    mutationFn: ({ tenantId, bundleId }: { tenantId: string; bundleId?: string }) =>
      apiFetch<{ data: { id: string } }>('/api/v1/admin/restores/carts', {
        method: 'POST',
        body: JSON.stringify({ tenantId, ...(bundleId ? { bundleId } : {}) }),
      }),
  });

  return { snapshotNow, bundleNow, createCart };
}

type View = 'snapshots' | 'backups';

interface TableProps {
  readonly rows: ReadonlyArray<TenantBackupOverviewRow>;
  readonly view: View;
  readonly isLoading: boolean;
  readonly onSnapshot: (tenantId: string) => void;
  readonly onBundle: (tenantId: string) => void;
  readonly onRestore: (row: TenantBackupOverviewRow) => void;
  readonly snapshotPendingFor: string | null;
  readonly bundlePendingFor: string | null;
}

function TenantAggregateTable({
  rows,
  view,
  isLoading,
  onSnapshot,
  onBundle,
  onRestore,
  snapshotPendingFor,
  bundlePendingFor,
}: TableProps) {
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
            <th className="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white dark:divide-gray-700 dark:bg-gray-900">
          {rows.map((r) => {
            const count = isSnap ? r.snapshotCount : r.bundleCount;
            const bytes = isSnap ? r.snapshotBytes : r.bundleBytes;
            const lastAt = isSnap ? r.lastSnapshotAt : r.lastBundleAt;
            const hasArtifacts = count > 0;
            const snapBusy = snapshotPendingFor === r.tenantId;
            const bundleBusy = bundlePendingFor === r.tenantId;
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
                <td className="px-4 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    {isSnap ? (
                      <button
                        type="button"
                        onClick={() => onSnapshot(r.tenantId)}
                        disabled={snapBusy}
                        className="inline-flex items-center gap-1 rounded border border-brand-300 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
                        data-testid={`tenant-row-snapshot-${r.tenantId}`}
                        title="Take a snapshot now"
                      >
                        {snapBusy ? <Loader2 size={11} className="animate-spin" /> : <Camera size={11} />}
                        Snapshot
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onBundle(r.tenantId)}
                        disabled={bundleBusy}
                        className="inline-flex items-center gap-1 rounded border border-brand-300 bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700 hover:bg-brand-100 disabled:opacity-50 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
                        data-testid={`tenant-row-bundle-${r.tenantId}`}
                        title="Create a backup bundle now"
                      >
                        {bundleBusy ? <Loader2 size={11} className="animate-spin" /> : <Archive size={11} />}
                        Bundle
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onRestore(r)}
                      disabled={!hasArtifacts}
                      className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                      data-testid={`tenant-row-restore-${r.tenantId}`}
                      title={hasArtifacts ? 'Open the Restoration Wizard' : 'No artifacts to restore'}
                    >
                      <RotateCw size={11} /> Restore…
                    </button>
                  </div>
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

function FilterBar({ search, setSearch, rowCount }: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative flex-1 min-w-[200px] max-w-md">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
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
        <Filter size={12} /> {rowCount} tenant{rowCount === 1 ? '' : 's'}
      </span>
    </div>
  );
}

export default function TenantsBackupsPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useTenantsOverview(search);
  const rows = data?.data?.rows ?? [];
  const navigate = useNavigate();
  const { snapshotNow, bundleNow, createCart } = useTenantActions();
  const [wizardRow, setWizardRow] = useState<TenantBackupOverviewRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fireAction = (fn: () => Promise<unknown>, label: string) => {
    setError(null);
    fn().catch((e) => {
      setError(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  const handleRestoreSubmit = async (
    row: TenantBackupOverviewRow,
    _selection: RestoreSelection,
  ): Promise<{ taskId: string }> => {
    // Open a fresh restore cart for this tenant. The execute step
    // (which actually fires the restore.cart task) happens inside the
    // cart page, where the operator picks files / mailboxes / config.
    const cart = await createCart.mutateAsync({ tenantId: row.tenantId });
    const cartId = cart.data.id;
    navigate(`/backups/restore?cartId=${cartId}&tenantId=${row.tenantId}`);
    // The wizard interface expects a taskId; we use the cart id as a
    // proxy — the cart's execute step inside RestoreCartPage creates
    // the actual restore.cart task.
    return { taskId: cartId };
  };

  const buildArtifact = (row: TenantBackupOverviewRow): RestoreArtifact => ({
    kind: 'tenant-bundle',
    id: row.tenantId,
    displayName: `${row.tenantName} (${row.bundleCount} bundle${row.bundleCount === 1 ? '' : 's'} / ${row.snapshotCount} snapshot${row.snapshotCount === 1 ? '' : 's'})`,
    cartUrl: `/backups/restore?tenantId=${row.tenantId}`,
  });

  const errorBanner = error ? (
    <div
      role="alert"
      className="flex items-start gap-2 rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200"
    >
      <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
      <span className="flex-1">{error}</span>
      <button
        type="button"
        aria-label="Dismiss error"
        onClick={() => setError(null)}
        className="text-rose-700 hover:underline dark:text-rose-300"
      >
        ×
      </button>
    </div>
  ) : null;

  const handlers = {
    onSnapshot: (id: string) =>
      fireAction(() => snapshotNow.mutateAsync(id), 'Snapshot trigger'),
    onBundle: (id: string) =>
      fireAction(() => bundleNow.mutateAsync(id), 'Bundle trigger'),
    onRestore: (row: TenantBackupOverviewRow) => {
      setError(null);
      setWizardRow(row);
    },
    snapshotPendingFor: snapshotNow.isPending ? (snapshotNow.variables ?? null) : null,
    bundlePendingFor: bundleNow.isPending ? (bundleNow.variables ?? null) : null,
  };

  return (
    <>
      <BackupClassPage
        icon={Package}
        title="Tenant Backups"
        subtitle="Per-tenant snapshots (PVC block copies) and bundles (files + mailboxes + config). Click Snapshot / Bundle on any row to trigger; Restore… opens the wizard."
        shimClass="tenant"
        scheduleSubsystems={['tenant_bundle']}
        snapshotsTab={
          <div className="space-y-4">
            {errorBanner}
            <FilterBar search={search} setSearch={setSearch} rowCount={rows.length} />
            <TenantAggregateTable rows={rows} view="snapshots" isLoading={isLoading} {...handlers} />
          </div>
        }
        backupsTab={
          <div className="space-y-4">
            {errorBanner}
            <FilterBar search={search} setSearch={setSearch} rowCount={rows.length} />
            <TenantAggregateTable rows={rows} view="backups" isLoading={isLoading} {...handlers} />
          </div>
        }
      />

      {wizardRow && (
        <RestorationWizard
          artifact={buildArtifact(wizardRow)}
          onClose={() => setWizardRow(null)}
          onSubmit={(sel) => handleRestoreSubmit(wizardRow, sel)}
        />
      )}
    </>
  );
}
