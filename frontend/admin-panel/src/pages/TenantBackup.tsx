/**
 * Tenant Backup admin page (consolidated).
 *
 * Single-stop operator surface for the per-tenant (tenant) bundle
 * lifecycle. Replaces the friction of context-switching between
 * /settings/backups, /restores, /restore, and per-tenant tabs.
 *
 * Tabs (deep-linkable via ?tab=…):
 *   - bundles   (default) — cross-tenant searchable list + filters,
 *                           inline verify/delete/GDPR/restore.
 *   - schedules            — global cron list, inline run-now + edit.
 *   - carts                — recent restore-carts list (resume failed).
 *   - targets              — off-site config (S3 / SSH-SFTP).
 *
 * super_admin + admin gated (router enforces).
 */

import { useState, useMemo, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Package, Calendar, RotateCcw, Cloud, Search, X, Play, Pencil,
  Trash2, ShieldCheck, Download, Upload, Loader2, AlertCircle, CheckCircle2,
  Pause, FileText, Server, Plus, Shield, AlertTriangle,
  FileDown, Eye, EyeOff, Sparkles,
} from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import SearchableTenantSelect from '@/components/ui/SearchableTenantSelect';
import { BackupScheduleEditor } from '@/components/BackupScheduleEditor';
import { useBundles, useDeleteBundle, useVerifyBundle, useCreateBundle, useBundleCoverage, useBundleDetailLive, useVerifyAllBundles, downloadDataExport, downloadBundleExport, importBundle, previewImport, restoreFromBundle, type ImportPreviewResponse, type RestoreFromBundleResult } from '@/hooks/use-backup-bundles';
import { usePlans, useRegions } from '@/hooks/use-plans';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import type { VerifyAllResult } from '@/hooks/use-backup-bundles';
import { useAllBackupSchedules, useRunBackupScheduleNow } from '@/hooks/use-backup-schedule';
import { useRestoreCarts } from '@/hooks/use-restore-carts';
import { useBackupConfigs } from '@/hooks/use-backup-config';
import { useTenants } from '@/hooks/use-tenants';
import { formatBytes } from '@/hooks/use-platform-storage';
import type {
  BundleSummary,
  BackupScheduleSummary,
  RestoreJobSummary,
  BackupJobStatus,
} from '@k8s-hosting/api-contracts';

type Tab = 'bundles' | 'schedules' | 'carts' | 'targets' | 'coverage';
const TABS: ReadonlyArray<{ id: Tab; label: string; icon: typeof Package }> = [
  { id: 'bundles', label: 'Bundles', icon: Package },
  { id: 'schedules', label: 'Schedules', icon: Calendar },
  { id: 'carts', label: 'Restore Carts', icon: RotateCcw },
  { id: 'targets', label: 'Off-site Targets', icon: Cloud },
  { id: 'coverage', label: 'Coverage', icon: Shield },
];

function isTab(v: string | null): v is Tab {
  return v !== null && TABS.some((t) => t.id === v);
}

const BUNDLE_STATUSES: ReadonlyArray<BackupJobStatus | ''> = [
  '', 'completed', 'partial', 'failed', 'running', 'pending', 'expired',
];
const CART_STATUSES: ReadonlyArray<{ key: string; label: string }> = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'executing', label: 'Executing' },
  { key: 'paused', label: 'Paused' },
  { key: 'failed', label: 'Failed' },
  { key: 'done', label: 'Done' },
];

export default function TenantBackup() {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const [tab, setTab] = useState<Tab>(isTab(tabParam) ? tabParam : 'bundles');

  // Keep URL in sync with tab so links are shareable + back-button works.
  useEffect(() => {
    if (params.get('tab') !== tab) {
      const next = new URLSearchParams(params);
      next.set('tab', tab);
      setParams(next, { replace: true });
    }
  }, [tab, params, setParams]);

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Tenant Backup</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Per-tenant off-site bundles, schedules, restores, and targets.
          </p>
        </div>
      </header>

      <nav className="flex gap-1 border-b border-gray-200 dark:border-gray-700" aria-label="Tabs">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={
              tab === id
                ? 'flex items-center gap-2 border-b-2 border-brand-500 px-4 py-2 text-sm font-medium text-brand-600 dark:text-brand-300'
                : 'flex items-center gap-2 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }
            aria-current={tab === id ? 'page' : undefined}
            data-testid={`tenant-backup-tab-${id}`}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </nav>

      {tab === 'bundles' && <BundlesTab onSwitchToTargets={() => setTab('targets')} />}
      {tab === 'schedules' && <SchedulesTab />}
      {tab === 'carts' && <CartsTab />}
      {tab === 'targets' && <TargetsTab />}
      {tab === 'coverage' && <CoverageTab />}
    </div>
  );
}

// ─── Coverage Tab ───────────────────────────────────────────────────

function CoverageTab() {
  const { data, isLoading, error } = useBundleCoverage();
  const report = data?.data;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-500 dark:text-gray-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading coverage report…
      </div>
    );
  }
  if (error || !report) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
        <AlertCircle className="mr-2 inline h-4 w-4" />
        Failed to load coverage: {error instanceof Error ? error.message : 'unknown error'}
      </div>
    );
  }

  const { components, drift } = report;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800">
        <p className="text-sm text-gray-700 dark:text-gray-200">
          The bundle coverage report shows what each component captures and detects drift between declared
          coverage and the live database. Orphan tables (a tenant DB table no component claims) indicate a
          gap that must be closed before tenant data starts dropping silently.
        </p>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Source: <code className="font-mono text-xs">backend/src/modules/tenant-bundles/component-registry.ts</code>
        </p>
      </div>

      {/* Drift summary */}
      <section className="rounded-lg border border-gray-200 dark:border-gray-700">
        <header className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Drift report</h3>
          {drift.orphanTables.length === 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
              <CheckCircle2 size={12} /> No drift
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300">
              <AlertTriangle size={12} /> {drift.orphanTables.length} orphan{drift.orphanTables.length === 1 ? '' : 's'}
            </span>
          )}
        </header>
        <div className="px-4 py-3 text-sm">
          <div className="grid grid-cols-4 gap-3">
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Tenant tables (DB)</div>
              <div className="mt-0.5 text-2xl font-semibold text-gray-900 dark:text-gray-100">{drift.totalTenantTables}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Captured by a component</div>
              <div className="mt-0.5 text-2xl font-semibold text-green-700 dark:text-green-300">{drift.ownedTableCount}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Excluded (documented)</div>
              <div className="mt-0.5 text-2xl font-semibold text-gray-700 dark:text-gray-200">{drift.excludedTables.length}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 dark:text-gray-400">Orphans (silently dropped)</div>
              <div className={`mt-0.5 text-2xl font-semibold ${drift.orphanTables.length === 0 ? 'text-gray-700 dark:text-gray-200' : 'text-red-700 dark:text-red-300'}`}>
                {drift.orphanTables.length}
              </div>
            </div>
          </div>
          {drift.orphanTables.length > 0 && (
            <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                Tables in DB with <code className="font-mono text-xs">tenant_id</code> that NO component claims:
              </p>
              <ul className="mt-1 list-disc pl-5 text-sm text-amber-900 dark:text-amber-200">
                {drift.orphanTables.map((o) => (
                  <li key={o.table}><code className="font-mono">{o.table}</code></li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
                Fix: add the table to <code className="font-mono">CONFIG_DUMP_TABLES</code> (or to{' '}
                <code className="font-mono">CONFIG_DUMP_EXCLUDED_CLIENT_FK_TABLES</code> with a reason),
                then add it to the corresponding entry in <code className="font-mono">component-registry.ts</code>.
              </p>
            </div>
          )}
          {drift.excludedTables.length > 0 && (
            <details className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800">
              <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-200">
                {drift.excludedTables.length} table{drift.excludedTables.length === 1 ? '' : 's'} intentionally excluded
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-gray-600 dark:text-gray-300">
                {drift.excludedTables.map((e) => (
                  <li key={e.table}>
                    <code className="font-mono">{e.table}</code>{' '}
                    <span className="text-gray-500 dark:text-gray-400">— {e.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </section>

      {/* Per-component declarations */}
      <section className="rounded-lg border border-gray-200 dark:border-gray-700">
        <header className="border-b border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Component registry</h3>
        </header>
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {components.map((c) => (
            <li key={c.name} className="px-4 py-3">
              <div className="flex items-center gap-2">
                <Package size={14} className="text-brand-600 dark:text-brand-400" />
                <span className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">{c.name}</span>
              </div>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{c.description}</p>
              <div className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                {c.tables.length > 0 && (
                  <div>
                    <span className="font-medium text-gray-700 dark:text-gray-200">Tables: </span>
                    <span className="font-mono text-gray-600 dark:text-gray-300">{c.tables.join(', ')}</span>
                  </div>
                )}
                {c.pvcs.length > 0 && (
                  <div>
                    <span className="font-medium text-gray-700 dark:text-gray-200">PVCs: </span>
                    <span className="font-mono text-gray-600 dark:text-gray-300">{c.pvcs.join(', ')}</span>
                  </div>
                )}
                {c.secretTypes.length > 0 && (
                  <div>
                    <span className="font-medium text-gray-700 dark:text-gray-200">Secrets: </span>
                    <span className="font-mono text-gray-600 dark:text-gray-300">{c.secretTypes.join(', ')}</span>
                  </div>
                )}
                {c.externalResources.length > 0 && (
                  <div>
                    <span className="font-medium text-gray-700 dark:text-gray-200">External: </span>
                    <span className="font-mono text-gray-600 dark:text-gray-300">{c.externalResources.join('; ')}</span>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ─── Bundles Tab ────────────────────────────────────────────────────

function BundlesTab({ onSwitchToTargets }: { onSwitchToTargets: () => void }) {
  const { data: bundlesResp, isLoading } = useBundles();
  const { data: clientsResp } = useTenants();
  const { data: configsResp } = useBackupConfigs();
  const verifyBundle = useVerifyBundle();
  const deleteBundle = useDeleteBundle();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [tenantFilter, setTenantFilter] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<{ id: string; ok: boolean; msg: string } | null>(null);
  const [deletePromptId, setDeletePromptId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [exportPromptId, setExportPromptId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showRestore, setShowRestore] = useState(false);
  const [verifyAllResult, setVerifyAllResult] = useState<VerifyAllResult | null>(null);
  const [verifyAllError, setVerifyAllError] = useState<string | null>(null);
  const verifyAll = useVerifyAllBundles();

  // useBundles wraps as { data: { data: [...], pagination } } —
  // see hooks/use-backup-bundles.ts ListResponse type.
  const bundles: ReadonlyArray<BundleSummary> = bundlesResp?.data?.data ?? [];
  const tenants = clientsResp?.data ?? [];
  const configs = configsResp?.data ?? [];

  const tenantName = useMemo(() => {
    const m = new Map(tenants.map((c) => [c.id, c.name]));
    return (id: string) => m.get(id) ?? '(unknown)';
  }, [tenants]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bundles.filter((b) => {
      if (statusFilter && b.status !== statusFilter) return false;
      if (tenantFilter && b.tenantId !== tenantFilter) return false;
      if (!q) return true;
      const haystack = [
        b.id,
        b.label ?? '',
        b.description ?? '',
        tenantName(b.tenantId).toLowerCase(),
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [bundles, search, statusFilter, tenantFilter, tenantName]);

  const handleVerify = async (bundleId: string) => {
    setVerifyResult(null);
    setVerifyingId(bundleId);
    try {
      const r = await verifyBundle.mutateAsync(bundleId);
      // components is a record { files?, config?, secrets? }. Each
      // component is "ok" when present and lacks an error field.
      const components = r.data.components;
      const checked: string[] = [];
      const failed: string[] = [];
      if (components.files) {
        checked.push('files');
        if (!components.files.reachable) failed.push('files');
      }
      if (components.config) {
        checked.push('config');
        if (components.config.parseError) failed.push('config');
      }
      if (components.secrets) {
        checked.push('secrets');
        if (components.secrets.decryptError) failed.push('secrets');
      }
      setVerifyResult({
        id: bundleId,
        ok: failed.length === 0,
        msg: failed.length === 0
          ? `All ${checked.length} component(s) verified clean: ${checked.join(', ')}.`
          : `${failed.length} of ${checked.length} component(s) failed: ${failed.join(', ')}.`,
      });
    } catch (err) {
      setVerifyResult({ id: bundleId, ok: false, msg: err instanceof Error ? err.message : 'Verify failed' });
    } finally {
      setVerifyingId(null);
    }
  };

  const handleDelete = async (bundleId: string) => {
    setDeleteError(null);
    try {
      await deleteBundle.mutateAsync(bundleId);
      setDeletePromptId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  // No targets configured? Surface a friendly nudge — bundles can't be
  // captured without an off-site target.
  if (configs.length === 0) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
        <p className="text-sm text-amber-900 dark:text-amber-200">
          No off-site backup target configured. Configure one in the
          <button type="button" className="mx-1 underline" onClick={onSwitchToTargets}>
            Off-site Targets
          </button>
          tab to start capturing tenant bundles.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative grow sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by bundle id, label, or tenant name…"
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            data-testid="bundle-search"
          />
          {search && (
            <button type="button" onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600" aria-label="Clear search">
              <X size={14} />
            </button>
          )}
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          data-testid="bundle-status-filter"
        >
          {BUNDLE_STATUSES.map((s) => (
            <option key={s || 'all'} value={s}>{s ? s : 'All statuses'}</option>
          ))}
        </select>

        <div className="min-w-[12rem]">
          <SearchableTenantSelect
            selectedTenantId={tenantFilter}
            onSelect={setTenantFilter}
            placeholder="All tenants"
          />
        </div>

        <span className="ml-auto text-sm text-gray-500 dark:text-gray-400">
          {filtered.length} of {bundles.length}
        </span>

        <button
          type="button"
          onClick={async () => {
            setVerifyAllResult(null);
            setVerifyAllError(null);
            try {
              const r = await verifyAll.mutateAsync();
              setVerifyAllResult(r.data);
            } catch (err) {
              setVerifyAllError(err instanceof Error ? err.message : 'Verify-all failed');
            }
          }}
          disabled={verifyAll.isPending || bundles.length === 0}
          className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
          data-testid="bundle-verify-all"
          title="Round-trip integrity check on every bundle"
        >
          {verifyAll.isPending ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} Verify all
        </button>

        <button
          type="button"
          onClick={() => setShowImport(true)}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          data-testid="bundle-import"
          title="Import a bundle archive (tar.gz / tar.gz.enc / zip) for an existing local tenant"
        >
          <Upload size={14} /> Import
        </button>

        <button
          type="button"
          onClick={() => setShowRestore(true)}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          data-testid="bundle-restore-from-bundle"
          title="Restore a deleted tenant from a bundle archive — creates a new tenant with a fresh UUID + namespace"
        >
          <RotateCcw size={14} /> Restore from bundle
        </button>

        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          data-testid="bundle-create"
        >
          <Plus size={14} /> New bundle
        </button>
      </div>

      {verifyAllError && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          <AlertCircle className="mr-2 inline h-4 w-4" />
          Verify-all failed: {verifyAllError}
          <button type="button" className="ml-2 underline" onClick={() => setVerifyAllError(null)}>dismiss</button>
        </div>
      )}

      {verifyAllResult && (
        <div className={
          verifyAllResult.summary.failed === 0
            ? 'rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
            : 'rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'
        }>
          <div className="flex items-center justify-between">
            <span>
              <strong>Verify-all:</strong> {verifyAllResult.summary.passed} passed,{' '}
              {verifyAllResult.summary.failed} failed,{' '}
              {verifyAllResult.summary.skipped} skipped
              <span className="text-xs opacity-70"> (of {verifyAllResult.summary.total})</span>
            </span>
            <button type="button" className="underline" onClick={() => setVerifyAllResult(null)}>dismiss</button>
          </div>
          {verifyAllResult.summary.failed > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs">
              {verifyAllResult.results.filter((r) => r.status === 'failed').slice(0, 10).map((r) => (
                <li key={r.bundleId}>
                  <code className="font-mono">{r.bundleId.slice(0, 24)}…</code> — {r.reason}
                </li>
              ))}
              {verifyAllResult.results.filter((r) => r.status === 'failed').length > 10 && (
                <li>… and {verifyAllResult.results.filter((r) => r.status === 'failed').length - 10} more</li>
              )}
            </ul>
          )}
        </div>
      )}

      {verifyResult && (
        <div className={
          verifyResult.ok
            ? 'rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
            : 'rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'
        }>
          Bundle <code className="font-mono text-xs">{verifyResult.id}</code>: {verifyResult.msg}
          <button type="button" className="ml-2 underline" onClick={() => setVerifyResult(null)}>dismiss</button>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-500 dark:text-gray-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading bundles…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
          {bundles.length === 0 ? (
            <>
              No tenant bundles captured yet.{' '}
              <button type="button" className="text-brand-600 underline" onClick={() => setShowCreate(true)}>
                Create one now
              </button>
              {' '}or set up a per-tenant schedule on the Schedules tab.
            </>
          ) : (
            'No bundles match the current filter.'
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                {['Bundle', 'Client', 'Status', 'Target', 'Size', 'Captured', 'Actions'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {filtered.map((b) => (
                <BundleRow
                  key={b.id}
                  bundle={b}
                  tenantName={tenantName(b.tenantId)}
                  onVerify={() => handleVerify(b.id)}
                  onDelete={() => { setDeleteError(null); setDeletePromptId(b.id); }}
                  onDataExport={() => downloadDataExport(b.id)}
                  onExportForRegion={() => setExportPromptId(b.id)}
                  verifying={verifyingId === b.id}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deletePromptId && (
        <DeleteConfirmModal
          bundleId={deletePromptId}
          onCancel={() => { setDeletePromptId(null); setDeleteError(null); }}
          onConfirm={() => handleDelete(deletePromptId)}
          isDeleting={deleteBundle.isPending}
          error={deleteError}
        />
      )}

      {showCreate && (
        <CreateBundleModal
          configs={configs}
          onClose={() => setShowCreate(false)}
        />
      )}

      {exportPromptId && (
        <ExportBundleModal
          bundleId={exportPromptId}
          onClose={() => setExportPromptId(null)}
        />
      )}

      {showImport && (
        <ImportBundleModal
          configs={configs}
          onClose={() => setShowImport(false)}
        />
      )}

      {showRestore && (
        <RestoreFromBundleModal
          configs={configs}
          onClose={() => setShowRestore(false)}
        />
      )}
    </div>
  );
}

function ExportBundleModal({ bundleId, onClose }: { bundleId: string; onClose: () => void }) {
  const [format, setFormat] = useState<'tar' | 'zip'>('tar');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Password is offered ONLY for the Tar format. Any non-empty
  // password passes through — the operator chooses (and may have a
  // strong generated value). Empty = plaintext tar.gz. ZIP is always
  // plaintext.
  const passwordAllowed = format === 'tar';
  const wantsEncryption = passwordAllowed && password.length > 0;

  // Generate a 16-char URL-safe random password using crypto.getRandomValues
  // — runs entirely browser-side, never leaves the page until export.
  const generatePassword = () => {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const out = Array.from(bytes, (b) => charset[b % charset.length]).join('');
    setPassword(out);
    // Show by default after generating — operator needs to record it
    // before submitting. The platform never stores it.
    setShowPassword(true);
  };

  const handleExport = async () => {
    setError(null);
    setPending(true);
    try {
      await downloadBundleExport(bundleId, format, wantsEncryption ? password : null);
      // Wait a beat so the browser has actually triggered the download
      // before the modal disappears (otherwise the user briefly sees
      // nothing while the request is in flight).
      setTimeout(onClose, 400);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="export-bundle-title">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-3 flex items-center justify-between">
          <h3 id="export-bundle-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Export bundle</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Streams every component artifact + meta.json directly to your browser — no server-side staging.
        </p>
        <p className="mt-1 font-mono text-xs text-gray-500">{bundleId}</p>

        <div className="mt-4 space-y-3 text-sm">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Format</label>
            <div className="flex gap-3">
              <label className="flex flex-1 cursor-pointer items-start gap-2 rounded-md border border-gray-300 p-2 dark:border-gray-600 dark:text-gray-100">
                <input type="radio" name="export-format" value="tar" checked={format === 'tar'} onChange={() => setFormat('tar')} className="mt-1" />
                <span>
                  <span className="font-medium">Tar (.tar.gz)</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    Optional <code className="font-mono">openssl</code> AES-256-CBC envelope. Filenames hidden when encrypted.
                  </span>
                </span>
              </label>
              <label className="flex flex-1 cursor-pointer items-start gap-2 rounded-md border border-gray-300 p-2 dark:border-gray-600 dark:text-gray-100">
                <input type="radio" name="export-format" value="zip" checked={format === 'zip'} onChange={() => setFormat('zip')} className="mt-1" />
                <span>
                  <span className="font-medium">Zip (.zip)</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    Plaintext only. Any OS unzips without extra tools. Use Tar if you need a password.
                  </span>
                </span>
              </label>
            </div>
          </div>
          {passwordAllowed && (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                Password <span className="text-gray-400">(optional, leave blank for unencrypted)</span>
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="(optional)"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 pr-10 font-mono text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={generatePassword}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                  title="Generate a 16-char random password"
                >
                  <Sparkles size={14} /> Generate
                </button>
              </div>
            </div>
          )}
          {passwordAllowed && wantsEncryption && (
            <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              The platform never stores this password. If you lose it the export is unrecoverable.
              The secrets component remains encrypted with the source region's <code className="font-mono">PLATFORM_ENCRYPTION_KEY</code> — for full cross-region restore the target region needs the same KEK or the bundle will surface a decrypt error on the secrets component only.
            </p>
          )}
          {passwordAllowed && !wantsEncryption && (
            <p className="rounded-md bg-blue-50 p-2 text-xs text-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
              No password set — the tar archive will download unencrypted. Anyone with the file can read every component.
            </p>
          )}
          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
              <AlertCircle className="mr-1 inline h-4 w-4" /> {error}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:text-gray-100">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={pending}
            className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {pending
              ? <><Loader2 size={14} className="animate-spin" /> Starting…</>
              : <><FileDown size={14} /> Download {format === 'zip' ? 'Zip' : 'Tar'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Two-step import flow:
 *   1. Pick file + (optional) passphrase → click Inspect →
 *      `POST /import-preview` returns the parsed meta v2 + a local
 *      lookup of the source tenantId.
 *   2. Server-resolved tenant info shows in the modal:
 *      - if the source tenant exists locally and is active/suspended:
 *        BLOCK with "use the Restore Cart" warning (no import).
 *      - if the source tenant is archived/missing: unlock the
 *        RestoreFromBundleModal path.
 *      - if no local match: prompt the operator to either pick a
 *        target tenant manually (legacy /import) OR open the
 *        RestoreFromBundleModal in "create-new" mode.
 *   3. Operator picks the off-site target + final action.
 *
 * The tenantId field has been removed from the form — the source
 * meta carries the answer. The modal still exposes a manual override
 * path (used when the bundle is being adopted by a different
 * tenant — typical multi-region migration).
 */
function ImportBundleModal({ configs, onClose }: {
  configs: ReadonlyArray<{ readonly id: string; readonly name: string; readonly active: boolean }>;
  onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [targetConfigId, setTargetConfigId] = useState<string>(
    () => configs.find((c) => c.active)?.id ?? configs[0]?.id ?? '',
  );
  // Manual-adoption tenantId — only used when the operator overrides
  // the auto-detected target (e.g. adopting bundle to a different tenant).
  const [overrideTenantId, setOverrideTenantId] = useState<string | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState<{ bundleId: string; sizeBytes: number } | null>(null);

  // Derived: which downstream path the local match unlocks.
  // - active/suspended: blocked (operator should use Restore Cart on the existing tenant)
  // - archived/missing/no-match: unlocked (will open RestoreFromBundleModal in a follow-up; for now → legacy /import with explicit tenantId)
  const localMatch = preview?.localTenantMatch ?? null;
  const blocked = localMatch && (localMatch.status === 'active' || localMatch.status === 'suspended');

  const handleInspect = async () => {
    if (!file) {
      setError('Pick a file first.');
      return;
    }
    setError(null);
    setPending(true);
    try {
      const result = await previewImport({ file, passphrase: passphrase || undefined });
      setPreview(result);
      // Reset override since a new file may have changed the source tenant.
      setOverrideTenantId(null);
      setShowOverride(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Inspect failed');
    } finally {
      setPending(false);
    }
  };

  const handleImport = async () => {
    if (!preview || !file) return;
    if (blocked) {
      setError(`This region already has an ${localMatch!.status} tenant with the source UUID — open the tenant and use Restore Cart instead. Importing would overwrite live state.`);
      return;
    }
    // Decide the target tenantId:
    //   - If operator picked an override: use it.
    //   - Else use the source meta tenantId (which matches the local archived/missing tenant).
    const tenantId = overrideTenantId ?? preview.sourceMeta.tenantId;
    if (!tenantId) {
      setError('Source meta has no tenantId AND no override was picked. Pick a target tenant manually.');
      return;
    }
    setError(null);
    setPending(true);
    try {
      const r = await importBundle({ file, passphrase, tenantId, targetConfigId });
      setSuccess({ bundleId: r.bundleId, sizeBytes: r.sizeBytes });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="import-bundle-title">
      <div className="w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-3 flex items-center justify-between">
          <h3 id="import-bundle-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Import bundle</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {success ? (
          <div className="space-y-3">
            <div className="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200">
              <CheckCircle2 className="mr-1 inline h-4 w-4" />
              Imported as <code className="font-mono text-xs">{success.bundleId}</code> ({(success.sizeBytes / 1024 / 1024).toFixed(1)} MiB).
              The bundle now appears in the list and is restorable via the standard Restore Cart flow.
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="rounded-md bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700">Done</button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-3 text-sm">
              {/* Step 1 — file picker */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                  Bundle archive
                  <span className="ml-2 text-gray-400">(.tar.gz, .tar.gz.enc, or .zip)</span>
                </label>
                <input
                  type="file"
                  accept=".gz,.enc,.tar,.zip,application/octet-stream,application/zip,application/gzip"
                  onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }}
                  className="block w-full text-sm text-gray-700 dark:text-gray-300"
                />
                {file && <p className="mt-1 text-xs text-gray-500">{file.name} ({(file.size / 1024 / 1024).toFixed(1)} MiB)</p>}
              </div>

              {/* Passphrase — optional, only used if archive is encrypted */}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                  Passphrase <span className="text-gray-400">(only if the archive is .tar.gz.enc)</span>
                </label>
                <div className="relative">
                  <input
                    type={showPassphrase ? 'text' : 'password'}
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="(optional)"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 pr-10 font-mono text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassphrase(!showPassphrase)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                    aria-label={showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
                  >
                    {showPassphrase ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {/* Inspect button — runs the preview if no preview yet */}
              {!preview && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleInspect}
                    disabled={!file || pending}
                    className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    {pending ? <><Loader2 size={14} className="animate-spin" /> Inspecting…</> : <>Inspect archive</>}
                  </button>
                </div>
              )}

              {/* Step 2 — preview + decision */}
              {preview && (
                <div className="space-y-3 rounded-md border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50">
                  <div className="flex items-center justify-between">
                    <h4 className="font-medium text-gray-900 dark:text-gray-100">Detected bundle</h4>
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                      {preview.format}
                    </span>
                  </div>

                  {/* Source-meta facts */}
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    {preview.sourceMeta.tenant?.name && (
                      <><dt className="text-gray-500">Source tenant</dt><dd className="text-gray-900 dark:text-gray-100">{preview.sourceMeta.tenant.name}</dd></>
                    )}
                    {preview.sourceMeta.tenantId && (
                      <><dt className="text-gray-500">Source UUID</dt><dd className="font-mono text-gray-700 dark:text-gray-300" title={preview.sourceMeta.tenantId}>{preview.sourceMeta.tenantId.slice(0, 8)}…</dd></>
                    )}
                    {preview.sourceMeta.tenant?.regionId && (
                      <><dt className="text-gray-500">Source region</dt><dd className="font-mono text-gray-700 dark:text-gray-300">{preview.sourceMeta.tenant.regionId.slice(0, 8)}…</dd></>
                    )}
                    {preview.sourceMeta.capturedAt && (
                      <><dt className="text-gray-500">Captured at</dt><dd className="text-gray-700 dark:text-gray-300">{new Date(preview.sourceMeta.capturedAt).toLocaleString()}</dd></>
                    )}
                    <dt className="text-gray-500">Archive size</dt><dd className="text-gray-700 dark:text-gray-300">{(preview.totalBytes / 1024 / 1024).toFixed(1)} MiB · {preview.entryCount} entries</dd>
                  </dl>

                  {/* Component breakdown */}
                  {Object.keys(preview.components).length > 0 && (
                    <div className="text-xs">
                      <span className="text-gray-500">Components:</span>{' '}
                      {Object.entries(preview.components).map(([k, v]) => (
                        <span key={k} className="mr-2 text-gray-700 dark:text-gray-300">
                          {k} ({v.count}, {(v.totalBytes / 1024 / 1024).toFixed(1)}MiB)
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Local-match decision */}
                  {localMatch ? (
                    blocked ? (
                      <div className="rounded-md bg-red-50 p-2 text-xs text-red-900 dark:bg-red-950/40 dark:text-red-200">
                        <AlertCircle className="mr-1 inline h-3.5 w-3.5" />
                        This region already has an <strong>{localMatch.status}</strong> tenant (<em>{localMatch.name}</em>)
                        with the source UUID. Importing would create a parallel bundle row pointing at the live tenant —
                        instead, open <code className="font-mono">/tenants/{localMatch.id}</code> and use the Restore Cart there.
                      </div>
                    ) : (
                      <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                        <AlertCircle className="mr-1 inline h-3.5 w-3.5" />
                        This region has an <strong>{localMatch.status}</strong> tenant (<em>{localMatch.name}</em>)
                        with the source UUID. The import will register the bundle against this tenant; restoration
                        is then via the Restore Cart. (Full RestoreFromBundleModal coming soon for {localMatch.status} cases.)
                      </div>
                    )
                  ) : (
                    <div className="rounded-md bg-blue-50 p-2 text-xs text-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
                      No local tenant matches the source UUID. Pick a target tenant below to adopt the bundle.
                    </div>
                  )}

                  {/* Override picker — only useful when adopting to a different tenant */}
                  {!blocked && (
                    <div className="text-xs">
                      <button
                        type="button"
                        onClick={() => setShowOverride(!showOverride)}
                        className="text-blue-700 underline dark:text-blue-300"
                      >
                        {showOverride ? 'Hide' : (localMatch ? 'Adopt under a different tenant…' : 'Pick target tenant…')}
                      </button>
                      {(showOverride || !localMatch) && (
                        <div className="mt-2">
                          <SearchableTenantSelect selectedTenantId={overrideTenantId} onSelect={setOverrideTenantId} placeholder={localMatch ? 'Override target tenant…' : 'Pick a tenant…'} />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Off-site target — always required */}
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Off-site target</label>
                    <select
                      value={targetConfigId}
                      onChange={(e) => setTargetConfigId(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                    >
                      {configs.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}{c.active ? ' (active)' : ''}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
                  <AlertCircle className="mr-1 inline h-4 w-4" /> {error}
                </div>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:text-gray-100">
                Cancel
              </button>
              {preview && (
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={pending || !!blocked || (!preview.sourceMeta.tenantId && !overrideTenantId)}
                  className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
                  title={blocked ? 'Source tenant is active locally — use Restore Cart instead' : ''}
                >
                  {pending ? <><Loader2 size={14} className="animate-spin" /> Importing…</> : <><Upload size={14} /> Import</>}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CreateBundleModal({ configs, onClose }: {
  configs: ReadonlyArray<{ readonly id: string; readonly name: string; readonly active: boolean }>;
  onClose: () => void;
}) {
  const createBundle = useCreateBundle();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [targetConfigId, setTargetConfigId] = useState<string>(
    () => configs.find((c) => c.active)?.id ?? configs[0]?.id ?? '',
  );
  const [components, setComponents] = useState({ files: true, mailboxes: true, config: true, secrets: true });
  const [label, setLabel] = useState('');
  const [retentionDays, setRetentionDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  // Once the orchestrator has reserved the bundle (async path), we
  // get the bundleId and switch the modal into "live progress" mode
  // — polling /:id every 2s and rendering per-component status.
  const [progressBundleId, setProgressBundleId] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    if (!tenantId) { setError('Pick a tenant.'); return; }
    if (!targetConfigId) { setError('Pick an off-site target.'); return; }
    try {
      const r = await createBundle.mutateAsync({
        tenantId,
        initiator: 'admin',
        components,
        label: label.trim() || null,
        retentionDays,
        targetConfigId,
        async: true,
      });
      setProgressBundleId(r.data.bundleId);
      // Don't auto-close — operator watches per-component progress.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-bundle-title"
    >
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h3 id="create-bundle-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Create tenant bundle</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Client</label>
            <SearchableTenantSelect selectedTenantId={tenantId} onSelect={setTenantId} placeholder="Pick a tenant…" />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Off-site target</label>
            <select
              value={targetConfigId}
              onChange={(e) => setTargetConfigId(e.target.value)}
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            >
              {configs.length === 0 && <option value="">(no targets — configure one first)</option>}
              {configs.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.active ? ' (active)' : ''}</option>
              ))}
            </select>
          </div>

          <fieldset>
            <legend className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Components to capture</legend>
            <div className="grid grid-cols-2 gap-2">
              {(['files', 'mailboxes', 'config', 'secrets'] as const).map((key) => (
                <label key={key} className="flex items-center gap-2 rounded-md border border-gray-200 px-2 py-1 dark:border-gray-700">
                  <input
                    type="checkbox"
                    checked={components[key]}
                    onChange={(e) => setComponents((c) => ({ ...c, [key]: e.target.checked }))}
                  />
                  <span className="capitalize">{key}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Label (optional)</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. pre-upgrade"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Retention (days)</label>
              <input
                type="number"
                min={1}
                max={3650}
                value={retentionDays}
                onChange={(e) => setRetentionDays(Math.max(1, Number(e.target.value) || 30))}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
              <AlertCircle className="mr-1 inline h-4 w-4" /> {error}
            </div>
          )}
          {progressBundleId && (
            <BundleCaptureProgress bundleId={progressBundleId} onAcknowledge={onClose} />
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          {!progressBundleId && (
            <button type="button" onClick={onClose} className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:text-gray-100">
              Cancel
            </button>
          )}
          {!progressBundleId && (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!tenantId || !targetConfigId || createBundle.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {createBundle.isPending ? <><Loader2 size={14} className="animate-spin" /> Starting…</> : <><Plus size={14} /> Create bundle</>}
            </button>
          )}
          {progressBundleId && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:text-gray-100"
              title="Close the modal — capture continues in background"
            >
              Close (capture continues in background)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * RestoreFromBundleModal — single-shot create-new-tenant + import flow
 * for bundles whose source tenant doesn't exist locally any more.
 *
 * Operator workflow:
 *   1. Pick the bundle archive (.tar.gz / .tar.gz.enc / .zip).
 *   2. Click "Inspect" → preview decodes the archive + returns the
 *      meta v2 tenant block. Form is pre-populated from those values.
 *   3. Operator edits company name/email, picks region/plan/worker
 *      node/storage tier (matches CreateTenantModal's UX).
 *   4. Submit → POST /import-finalize creates the tenant + imports
 *      the bundle in one shot. Returns the new tenantId + the auto-
 *      generated tenant_admin password for one-shot display.
 *
 * Scope (deferred):
 *   - re-use UUID toggle (would bypass createTenant's randomUUID)
 *   - re-use namespace toggle (would bypass generateNamespace)
 *   These come in a follow-up alongside the restore-archived path
 *   that needs both for byte-identical recovery.
 */
function RestoreFromBundleModal({ configs, onClose }: {
  configs: ReadonlyArray<{ readonly id: string; readonly name: string; readonly active: boolean }>;
  onClose: () => void;
}) {
  // Step 1 — file + passphrase
  const [file, setFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);

  // Step 2 — operator-edited form (pre-filled from preview)
  const [name, setCompanyName] = useState('');
  const [primaryEmail, setCompanyEmail] = useState('');
  const [secondaryEmail, setContactEmail] = useState('');
  const [planId, setPlanId] = useState('');
  const [regionId, setRegionId] = useState('');
  const [nodeName, setWorkerNodeName] = useState('');
  const [storageTier, setStorageTier] = useState<'local' | 'ha'>('local');
  const [targetConfigId, setTargetConfigId] = useState<string>(
    () => configs.find((c) => c.active)?.id ?? configs[0]?.id ?? '',
  );

  // Step 3 — submit / result
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RestoreFromBundleResult | null>(null);
  const [pwCopied, setPwCopied] = useState(false);

  // Lookups for the form dropdowns
  const { data: plansData } = usePlans();
  const { data: regionsData } = useRegions();
  const { data: nodesData } = useClusterNodes();

  const handleInspect = async () => {
    if (!file) {
      setError('Pick a file first.');
      return;
    }
    setError(null);
    setPending(true);
    try {
      const p = await previewImport({ file, passphrase: passphrase || undefined });
      setPreview(p);
      // Pre-fill the form from the source meta where available.
      const c = p.sourceMeta.tenant;
      if (c) {
        setCompanyName(c.name || '');
        setCompanyEmail(c.primaryEmail || '');
        setContactEmail(c.secondaryEmail ?? '');
        setStorageTier((c.storageTier as 'local' | 'ha') ?? 'local');
      }
      // The source plan/region UUIDs may not match anything in this
      // region — leave the dropdowns at default and let the operator
      // pick. nodeName ditto (different cluster).
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Inspect failed');
    } finally {
      setPending(false);
    }
  };

  const validForSubmit = !!file && !!preview && !!name && !!primaryEmail
    && !!planId && !!regionId && !!targetConfigId;

  const handleSubmit = async () => {
    if (!validForSubmit || !file) {
      setError('Fill all required fields.');
      return;
    }
    setError(null);
    setPending(true);
    try {
      const r = await restoreFromBundle({
        file,
        passphrase: passphrase || undefined,
        targetConfigId,
        overrides: {
          name: name,
          primary_email: primaryEmail,
          secondary_email: secondaryEmail || undefined,
          plan_id: planId,
          region_id: regionId,
          node_name: nodeName || undefined,
          storage_tier: storageTier,
        },
      });
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setPending(false);
    }
  };

  // Result screen — show the new tenant + one-shot generated password
  if (result) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
        <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Client restored</h3>
            <button type="button" onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600" aria-label="Close">
              <X size={16} />
            </button>
          </div>
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-green-300 bg-green-50 p-3 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200">
              <CheckCircle2 className="mr-1 inline h-4 w-4" />
              Created tenant <code className="font-mono text-xs">{result.newTenantId.slice(0, 8)}</code>{' '}
              + bundle <code className="font-mono text-xs">{result.bundleId.slice(0, 16)}</code>{' '}
              ({(result.sizeBytes / 1024 / 1024).toFixed(1)} MiB).
            </div>
            {result.tenantUser?.generatedPassword && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="mb-2 font-medium">Auto-generated tenant_admin credentials (shown ONCE — record now):</p>
                <div className="space-y-1 font-mono">
                  <div>email: <code>{result.tenantUser.email}</code></div>
                  <div className="flex items-center gap-2">
                    <span>password:</span>
                    <code className="rounded bg-white/50 px-1 py-0.5 dark:bg-gray-900/50">{result.tenantUser.generatedPassword}</code>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(result.tenantUser!.generatedPassword!);
                        setPwCopied(true);
                        setTimeout(() => setPwCopied(false), 2000);
                      }}
                      className="text-blue-700 underline dark:text-blue-300"
                    >
                      {pwCopied ? 'copied' : 'copy'}
                    </button>
                  </div>
                </div>
              </div>
            )}
            <p className="text-xs text-gray-600 dark:text-gray-300">
              Open the new tenant and use Restore Cart to apply the bundle to the freshly-provisioned tenant.
            </p>
            <div className="flex justify-end gap-2">
              <Link
                to={`/tenants/${result.newTenantId}`}
                className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700"
                onClick={onClose}
              >
                Open tenant →
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Restore tenant from bundle</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          Re-creates a tenant tenant from a bundle archive. Use when the source tenant has been deleted from this region.
          For active or suspended tenants, open the tenant and use Restore Cart instead — that path preserves UUID + namespace.
        </p>

        <div className="space-y-3 text-sm">
          {/* Step 1 — file picker */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
              Bundle archive <span className="text-gray-400">(.tar.gz, .tar.gz.enc, .zip)</span>
            </label>
            <input
              type="file"
              accept=".gz,.enc,.tar,.zip,application/octet-stream,application/zip,application/gzip"
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }}
              className="block w-full text-sm text-gray-700 dark:text-gray-300"
            />
            {file && <p className="mt-1 text-xs text-gray-500">{file.name} ({(file.size / 1024 / 1024).toFixed(1)} MiB)</p>}
          </div>

          {/* Passphrase — optional, only used if archive is encrypted */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
              Passphrase <span className="text-gray-400">(only if archive is encrypted)</span>
            </label>
            <div className="relative">
              <input
                type={showPassphrase ? 'text' : 'password'}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="(optional)"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 pr-10 font-mono text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowPassphrase(!showPassphrase)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                aria-label={showPassphrase ? 'Hide' : 'Show'}
              >
                {showPassphrase ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {!preview && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleInspect}
                disabled={!file || pending}
                className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {pending ? <><Loader2 size={14} className="animate-spin" /> Inspecting…</> : <>Inspect archive</>}
              </button>
            </div>
          )}

          {/* Step 2 — operator-edited form */}
          {preview && (
            <>
              <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-700 dark:bg-gray-900/50">
                <span className="font-medium text-gray-700 dark:text-gray-200">Detected:</span>{' '}
                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">{preview.format}</span>{' '}
                · {preview.entryCount} entries · {(preview.totalBytes / 1024 / 1024).toFixed(1)} MiB
                {preview.sourceMeta.tenant && (
                  <span className="ml-2 text-gray-500">
                    (source: <em>{preview.sourceMeta.tenant.name}</em>, captured {preview.sourceMeta.capturedAt ? new Date(preview.sourceMeta.capturedAt).toLocaleDateString() : '—'})
                  </span>
                )}
              </div>

              {preview.localTenantMatch && (preview.localTenantMatch.status === 'active' || preview.localTenantMatch.status === 'suspended') ? (
                <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
                  <AlertCircle className="mr-1 inline h-4 w-4" />
                  This region already has an <strong>{preview.localTenantMatch.status}</strong> tenant (<em>{preview.localTenantMatch.name}</em>) with the source UUID.
                  Restore-from-bundle would create a SECOND parallel tenant. Open the existing tenant and use Restore Cart instead.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Company name *</label>
                      <input type="text" value={name} onChange={(e) => setCompanyName(e.target.value)}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Company email *</label>
                      <input type="email" value={primaryEmail} onChange={(e) => setCompanyEmail(e.target.value)}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Contact email</label>
                      <input type="email" value={secondaryEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="(optional)"
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Region *</label>
                      <select value={regionId} onChange={(e) => setRegionId(e.target.value)}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100">
                        <option value="">— pick region —</option>
                        {(regionsData?.data ?? []).map((r) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Plan *</label>
                      <select value={planId} onChange={(e) => setPlanId(e.target.value)}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100">
                        <option value="">— pick plan —</option>
                        {(plansData?.data ?? []).map((p) => (
                          <option key={p.id} value={p.id}>{p.name} — {p.cpuLimit}vCPU / {p.memoryLimit}MB / {p.storageLimit}GB</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Storage tier</label>
                      <select value={storageTier} onChange={(e) => setStorageTier(e.target.value as 'local' | 'ha')}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100">
                        <option value="local">Local (1 replica)</option>
                        <option value="ha" disabled={(nodesData?.data ?? []).filter((n) => n.canHostTenantWorkloads).length < 3}>
                          HA (2 replicas){(nodesData?.data ?? []).filter((n) => n.canHostTenantWorkloads).length < 3 && ' — needs ≥3 nodes'}
                        </option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Worker node</label>
                      <select value={nodeName} onChange={(e) => setWorkerNodeName(e.target.value)}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100">
                        <option value="">Auto (scheduler picks based on capacity)</option>
                        {(nodesData?.data ?? []).filter((n) => n.canHostTenantWorkloads).map((n) => (
                          <option key={n.name} value={n.name}>{n.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Off-site target *</label>
                      <select value={targetConfigId} onChange={(e) => setTargetConfigId(e.target.value)}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100">
                        {configs.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}{c.active ? ' (active)' : ''}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                    <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                    A new tenant will be provisioned with a fresh UUID + namespace. The bundle is registered against
                    the new tenant; apply the actual data via Restore Cart on the resulting tenant page.
                  </p>
                </>
              )}
            </>
          )}

          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
              <AlertCircle className="mr-1 inline h-4 w-4" /> {error}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:text-gray-100">
            Cancel
          </button>
          {preview && !(preview.localTenantMatch && (preview.localTenantMatch.status === 'active' || preview.localTenantMatch.status === 'suspended')) && (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!validForSubmit || pending}
              className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {pending ? <><Loader2 size={14} className="animate-spin" /> Restoring…</> : <><RotateCcw size={14} /> Restore tenant</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Live capture-progress widget: polls the bundle detail every 2s
// while still in flight. Renders per-component pending/running/done/
// failed/skipped pills and surfaces last_error inline so the operator
// can see WHICH component is stuck or has failed without leaving the
// modal.
function BundleCaptureProgress({ bundleId, onAcknowledge }: {
  bundleId: string;
  onAcknowledge: () => void;
}) {
  const { data, error, isLoading } = useBundleDetailLive(bundleId);
  const detail = data?.data;

  if (isLoading || !detail) {
    return (
      <div className="rounded-md border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
        <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
        Reserving bundle <code className="font-mono text-xs">{bundleId}</code>…
        {error && <div className="mt-1 text-red-700">poll error: {error instanceof Error ? error.message : String(error)}</div>}
      </div>
    );
  }

  const inFlight = detail.status === 'pending' || detail.status === 'running';
  const succeeded = detail.status === 'completed';
  const partial = detail.status === 'partial';
  const failed = detail.status === 'failed' || detail.status === 'expired';

  const startedAt = detail.startedAt ? new Date(detail.startedAt) : null;
  const elapsedSec = startedAt
    ? Math.round((Date.now() - startedAt.getTime()) / 1000)
    : 0;

  const pillClass = (s: string): string => {
    if (s === 'completed') return 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300';
    if (s === 'failed') return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300';
    if (s === 'running') return 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';
    if (s === 'skipped') return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
    return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'; // pending
  };

  return (
    <div className="rounded-md border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200">
      <div className="flex items-center justify-between gap-2">
        <div>
          {inFlight && <><Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> Capturing</>}
          {succeeded && <><CheckCircle2 className="mr-1 inline h-4 w-4" /> Capture complete</>}
          {partial && <><AlertTriangle className="mr-1 inline h-4 w-4" /> Captured with partial failures</>}
          {failed && <><AlertCircle className="mr-1 inline h-4 w-4" /> Capture failed</>}
          <code className="ml-1 font-mono text-xs">{bundleId.slice(0, 24)}…</code>
        </div>
        <span className="text-xs opacity-70">{elapsedSec}s elapsed</span>
      </div>

      {/* Per-component status — the heart of the new UX. Operator sees
          exactly which component is in flight, complete, or failed.  */}
      <div className="mt-3 space-y-1">
        {detail.components.length === 0 ? (
          <div className="text-xs italic opacity-70">no components recorded yet…</div>
        ) : (
          detail.components.map((c) => (
            <div key={`${c.component}-${c.artifactName}`} className="flex items-start justify-between gap-2 text-xs">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium capitalize">{c.component}</span>
                  <span className={`rounded-full px-2 py-0.5 ${pillClass(c.status)}`}>{c.status}</span>
                  {c.sizeBytes > 0 && (
                    <span className="opacity-70">{(c.sizeBytes / 1024 / 1024).toFixed(1)} MiB</span>
                  )}
                </div>
                {c.lastError && (
                  <div className="mt-0.5 break-words text-red-700 dark:text-red-300">
                    {c.lastError}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {detail.lastError && (
        <div className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          <strong>Bundle-level error:</strong> {detail.lastError}
        </div>
      )}

      {!inFlight && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onAcknowledge}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs text-white hover:bg-brand-700"
          >
            {succeeded ? 'Close' : 'Acknowledge & close'}
          </button>
        </div>
      )}
    </div>
  );
}

interface BundleRowProps {
  readonly bundle: BundleSummary;
  readonly tenantName: string;
  readonly onVerify: () => void;
  readonly onDelete: () => void;
  readonly onDataExport: () => void;
  readonly onExportForRegion: () => void;
  readonly verifying: boolean;
}

function BundleRow({ bundle: b, tenantName, onVerify, onDelete, onDataExport, onExportForRegion, verifying }: BundleRowProps) {
  return (
    <tr className="text-sm">
      <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-300">
        <div className="truncate" title={b.id}>{b.id.slice(0, 24)}…</div>
        {b.label && <div className="text-[11px] text-gray-500">{b.label}</div>}
      </td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-200">
        <div className="flex items-center gap-2">
          {b.tenantStatus === 'missing' ? (
            // No /tenants/:id row exists for a missing tenant — render
            // as plain text so the operator doesn't get a 404 click.
            <span className="text-gray-500 italic">{b.tenantName ?? tenantName}</span>
          ) : (
            <Link to={`/tenants/${b.tenantId}`} className="hover:text-brand-600 hover:underline">{b.tenantName ?? tenantName}</Link>
          )}
          {b.tenantStatus && b.tenantStatus !== 'active' && (
            <StatusBadge status={b.tenantStatus} />
          )}
        </div>
      </td>
      <td className="px-4 py-2"><StatusBadge status={b.status} /></td>
      <td className="px-4 py-2 text-gray-600 dark:text-gray-300">
        <span className="font-mono text-xs">{b.targetKind}</span>
      </td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{formatBytes(b.sizeBytes)}</td>
      <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
        {b.finishedAt ? new Date(b.finishedAt).toLocaleString() : (b.startedAt ? '(running)' : '—')}
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-1">
          <Link
            to={`/restore?bundleId=${b.id}&tenantId=${b.tenantId}`}
            className="rounded p-1.5 text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/30"
            title="Restore from this bundle"
          >
            <RotateCcw size={14} />
          </Link>
          <button
            type="button"
            onClick={onVerify}
            disabled={verifying}
            className="rounded p-1.5 text-amber-600 hover:bg-amber-50 disabled:opacity-50 dark:hover:bg-amber-900/30"
            title="Verify integrity"
          >
            {verifying ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
          </button>
          {b.exportMode === 'data_export' && (
            <button
              type="button"
              onClick={onDataExport}
              className="rounded p-1.5 text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/30"
              title="Download GDPR data export"
            >
              <Download size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={onExportForRegion}
            className="rounded p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30"
            title="Download bundle (Tar or Zip; optional password on Tar)"
          >
            <FileDown size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
            title="Delete bundle"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}

function DeleteConfirmModal({ bundleId, onCancel, onConfirm, isDeleting, error }: {
  bundleId: string; onCancel: () => void; onConfirm: () => void; isDeleting: boolean; error: string | null;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-bundle-title"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl dark:bg-gray-800">
        <h3 id="delete-bundle-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Delete bundle?</h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          This permanently removes the bundle from the off-site target and the database. This cannot be undone.
        </p>
        <p className="mt-2 font-mono text-xs text-gray-500">{bundleId}</p>
        {error && (
          <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
            <AlertCircle className="mr-1 inline h-4 w-4" />
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:text-gray-100">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={isDeleting} className="rounded-md bg-red-600 px-3 py-2 text-sm text-white hover:bg-red-700 disabled:opacity-50">
            {isDeleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Schedules Tab ──────────────────────────────────────────────────

function SchedulesTab() {
  const { data, isLoading } = useAllBackupSchedules();
  const [search, setSearch] = useState('');
  const [editTenantId, setEditTenantId] = useState<string | null>(null);

  // API envelope: { data: { data: [...] } }. Outer .data is the
  // success() wrapper; inner .data is our list payload.
  const schedules: ReadonlyArray<BackupScheduleSummary> = data?.data?.data ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return schedules;
    return schedules.filter((s) =>
      (s.businessName ?? '').toLowerCase().includes(q) || s.tenantId.toLowerCase().includes(q),
    );
  }, [schedules, search]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative grow sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search schedules by tenant name…"
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            data-testid="schedule-search"
          />
        </div>
        <span className="ml-auto text-sm text-gray-500 dark:text-gray-400">
          {filtered.length} of {schedules.length}
        </span>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-500 dark:text-gray-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading schedules…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
          No schedules configured yet. Open a tenant and toggle "Enable scheduled bundles" to create one.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                {['Client', 'Enabled', 'Frequency', 'Hour (UTC)', 'Retention', 'Last Run', 'Actions'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {filtered.map((s) => (
                <ScheduleRow key={s.tenantId} schedule={s} onEdit={() => setEditTenantId(s.tenantId)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editTenantId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-schedule-title"
        >
          <div className="w-full max-w-2xl rounded-lg bg-white p-1 shadow-xl dark:bg-gray-800">
            <div className="flex items-center justify-between px-4 py-2">
              <span id="edit-schedule-title" className="text-sm text-gray-500 dark:text-gray-400">
                Editing schedule for tenant <code className="font-mono text-xs">{editTenantId.slice(0, 8)}…</code>
              </span>
              <button type="button" onClick={() => setEditTenantId(null)} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600" aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <BackupScheduleEditor tenantId={editTenantId} />
          </div>
        </div>
      )}
    </div>
  );
}

function ScheduleRow({ schedule: s, onEdit }: { schedule: BackupScheduleSummary; onEdit: () => void }) {
  const runNow = useRunBackupScheduleNow(s.tenantId);
  const handleRunNow = () => { runNow.mutate(); };

  return (
    <tr className="text-sm">
      <td className="px-4 py-2">
        <Link to={`/tenants/${s.tenantId}`} className="text-gray-700 hover:text-brand-600 hover:underline dark:text-gray-200">
          {s.businessName ?? <span className="italic text-red-500">(deleted)</span>}
        </Link>
        <div className="font-mono text-[11px] text-gray-500">{s.tenantId.slice(0, 8)}…</div>
      </td>
      <td className="px-4 py-2">
        {s.enabled ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
            <CheckCircle2 size={12} /> Enabled
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
            <Pause size={12} /> Paused
          </span>
        )}
      </td>
      <td className="px-4 py-2 capitalize text-gray-700 dark:text-gray-200">{s.frequency}</td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{String(s.hourOfDayUtc).padStart(2, '0')}:00</td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{s.retentionDays}d</td>
      <td className="px-4 py-2 text-xs">
        {s.lastRunAt ? (
          <>
            <div className="text-gray-700 dark:text-gray-200">{new Date(s.lastRunAt).toLocaleString()}</div>
            {s.lastRunStatus && <div><StatusBadge status={s.lastRunStatus} /></div>}
          </>
        ) : (
          <span className="text-gray-400">never</span>
        )}
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleRunNow}
            disabled={!s.enabled || runNow.isPending}
            className="inline-flex items-center gap-1 rounded p-1.5 text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:hover:bg-brand-900/30"
            title={s.enabled ? 'Trigger next tick to run now' : 'Enable schedule first'}
          >
            {runNow.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded p-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            title="Edit schedule"
          >
            <Pencil size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Restore Carts Tab ──────────────────────────────────────────────

function CartsTab() {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const { data, isLoading, error } = useRestoreCarts(statusFilter ? { status: statusFilter } : {});
  // API envelope is {data: {data: [...]}} — see CartListResponse in
  // hooks/use-restore-carts.ts.
  const carts: ReadonlyArray<RestoreJobSummary> = data?.data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {CART_STATUSES.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setStatusFilter(key)}
            className={
              statusFilter === key
                ? 'rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white'
                : 'rounded-full border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700'
            }
          >
            {label}
          </button>
        ))}
        <Link
          to="/restore"
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          <RotateCcw size={14} /> New restore
        </Link>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-500 dark:text-gray-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading carts…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          <AlertCircle className="mr-2 inline h-4 w-4" />
          Failed to load carts: {error instanceof Error ? error.message : String(error)}
        </div>
      ) : carts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
          No restore carts {statusFilter ? `with status "${statusFilter}"` : 'yet'}.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                {['Cart', 'Status', 'Created', 'Description', 'Actions'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {carts.map((c) => (
                <tr key={c.id} className="text-sm">
                  <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-300">{c.id}</td>
                  <td className="px-4 py-2"><StatusBadge status={c.status} /></td>
                  <td className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400">{new Date(c.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{c.description ?? '—'}</td>
                  <td className="px-4 py-2">
                    {c.status === 'failed' || c.status === 'paused' ? (
                      <Link
                        to={`/restore?cartId=${c.id}`}
                        className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300"
                      >
                        <Play size={12} /> Resume
                      </Link>
                    ) : (
                      <Link
                        to={`/restore?cartId=${c.id}`}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                      >
                        <FileText size={12} /> Open
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Targets Tab ────────────────────────────────────────────────────
//
// Off-site config (S3 / SSH-SFTP) — surfaces a quick summary +
// deep-link to the existing /settings/backups for the form-based
// CRUD. Keeping the heavy form on its own page avoids duplicating
// the `useBackupConfigs` mutation set + secret-handling here.

function TargetsTab() {
  const { data, isLoading } = useBackupConfigs();
  const configs = data?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Off-site storage destinations for tenant bundles. At least one active target is required to capture bundles.
        </p>
        <Link
          to="/settings/backups"
          className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          <Server size={14} /> Manage targets
        </Link>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-500 dark:text-gray-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading targets…
        </div>
      ) : configs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
          No off-site targets yet.{' '}
          <Link to="/settings/backups" className="text-brand-600 underline">Add one</Link> to start capturing bundles.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                {['Name', 'Kind', 'Endpoint', 'Active', 'Retention'].map((h) => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white dark:divide-gray-700 dark:bg-gray-900">
              {configs.map((c) => (
                <tr key={c.id} className="text-sm">
                  <td className="px-4 py-2 font-medium text-gray-700 dark:text-gray-200">{c.name}</td>
                  <td className="px-4 py-2"><span className="font-mono text-xs">{c.storageType}</span></td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-300">
                    {c.storageType === 's3'
                      ? `${c.s3Endpoint ?? ''}/${c.s3Bucket ?? ''}`
                      : `${c.sshUser ?? ''}@${c.sshHost ?? ''}:${c.sshPath ?? ''}`}
                  </td>
                  <td className="px-4 py-2">
                    {c.active ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300">
                        <CheckCircle2 size={12} /> Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                        Inactive
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-700 dark:text-gray-200">{c.retentionDays}d</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}
