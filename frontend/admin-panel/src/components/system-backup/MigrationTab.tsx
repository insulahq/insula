/**
 * R20 cross-cluster tenant migration — guided "Migrate Tenants" flow.
 *
 * Modeled on RecoverAllTab: a source-target picker → list (scan) →
 * per-tenant selection → dry-run PREVIEW → confirm → real import, with a
 * per-tenant results table.
 *
 * The operator first registers cluster A's tenant backup target as a
 * backup config on THIS cluster (Backups → Targets). This tab mounts that
 * target READ-ONLY, scans it for tenants, and imports the selected (or all
 * discovered) tenants — re-creating each from its newest bundle's meta and
 * restoring components straight from A's store. Nothing on A is changed.
 */

import { useState } from 'react';
import {
  ArrowRightLeft, RefreshCw, Play, Loader2, CheckCircle2, XCircle,
  AlertTriangle, Lock, ListChecks,
} from 'lucide-react';
import { useMigrationListTenants, useMigrationImport } from '@/hooks/use-migration';
import { useBackupConfigs } from '@/hooks/use-backup-config';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import type {
  MigrationTenant, MigrationImportResult, MigrationImportRequest,
} from '@insula/api-contracts';

type Scope = 'selected' | 'all';

function humanizeBytes(n: number): string {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value).toString() : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

export default function MigrationTab() {
  const [targetConfigId, setTargetConfigId] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [scope, setScope] = useState<Scope>('selected');

  const configsQuery = useBackupConfigs();
  const list = useMigrationListTenants();
  const dryRun = useMigrationImport();
  const importReal = useMigrationImport();

  const configs = configsQuery.data?.data ?? [];
  const selectValue = configs.some((c) => c.id === targetConfigId) ? targetConfigId : '';

  const listData = list.data?.data;
  const tenants: readonly MigrationTenant[] = listData?.tenants ?? [];
  const importable = tenants.filter((t) => !t.alreadyPresent);

  const dryRunData = dryRun.data?.data;
  const importData = importReal.data?.data;

  const anyPending = list.isPending || dryRun.isPending || importReal.isPending;

  // Once a target changes / a re-scan happens, everything downstream is stale.
  const resetImport = () => {
    dryRun.reset();
    importReal.reset();
  };
  const resetDownstream = () => {
    setSelected(new Set());
    setScope('selected');
    list.reset();
    resetImport();
  };

  const onTargetChange = (id: string) => {
    setTargetConfigId(id);
    resetDownstream();
  };

  const runList = () => {
    setSelected(new Set());
    resetImport();
    list.mutate({ targetConfigId: targetConfigId.trim() });
  };

  const toggleRow = (tenantId: string) => {
    resetImport();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tenantId)) next.delete(tenantId);
      else next.add(tenantId);
      return next;
    });
  };

  const allImportableSelected = importable.length > 0 && importable.every((t) => selected.has(t.tenantId));
  const toggleSelectAll = () => {
    resetImport();
    setSelected(allImportableSelected ? new Set() : new Set(importable.map((t) => t.tenantId)));
  };

  const changeScope = (next: Scope) => {
    resetImport();
    setScope(next);
  };

  const importInput = (isDryRun: boolean): MigrationImportRequest => ({
    targetConfigId: targetConfigId.trim(),
    scope,
    ...(scope === 'selected' ? { tenantIds: Array.from(selected) } : {}),
    dryRun: isDryRun,
  });

  // How many tenants THIS run will attempt (already-present ones are skipped).
  const targetCount = scope === 'all' ? importable.length : selected.size;
  const canImport = targetCount > 0;

  const runDryRun = () => {
    importReal.reset();
    dryRun.mutate(importInput(true));
  };
  const runImport = () => {
    importReal.mutate(importInput(false));
  };

  return (
    <div className="space-y-5">
      <header className="flex items-start gap-3">
        <ArrowRightLeft size={22} className="mt-0.5 flex-shrink-0 text-gray-700 dark:text-gray-300" />
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Migrate tenants from another cluster</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-600 dark:text-gray-400">
            Import tenants from another cluster&apos;s off-site backup target. First register that
            cluster&apos;s tenant backup target as a backup config here (Backups → Targets), then pick it
            below. This scans it, then re-creates &amp; restores each selected tenant from its newest
            bundle. Always <span className="font-medium">preview</span> (dry-run) before importing.
          </p>
        </div>
      </header>

      {/* Step 1 — source target */}
      <section className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-gray-200 text-xs dark:bg-gray-700">1</span>
          Choose the source backup target
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-gray-700 dark:text-gray-300">Registered backup target</span>
            <select
              value={selectValue}
              onChange={(e) => onTargetChange(e.target.value)}
              disabled={configsQuery.isLoading || anyPending}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            >
              <option value="">
                {configsQuery.isLoading ? 'Loading targets…' : '— select a backup target —'}
              </option>
              {configs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.storageType}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-gray-700 dark:text-gray-300">…or enter a target config id</span>
            <input
              type="text"
              value={targetConfigId}
              onChange={(e) => onTargetChange(e.target.value)}
              placeholder="backup-config UUID"
              disabled={anyPending}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 font-mono text-xs text-gray-900 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            />
          </label>
        </div>

        <p className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-2.5 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200">
          <Lock size={13} className="mt-0.5 flex-shrink-0" />
          <span>The source target is mounted <span className="font-medium">read-only</span> — no changes are made to it. Scanning and importing only read from the source; all writes happen on this cluster.</span>
        </p>

        {configsQuery.isError && (
          <ErrorPanel error={extractOperatorError(configsQuery.error)} severity="warn" />
        )}

        <button
          type="button"
          onClick={runList}
          disabled={!targetConfigId.trim() || anyPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          {list.isPending ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          List tenants
        </button>
      </section>

      {list.isError && <ErrorPanel error={extractOperatorError(list.error)} severity="error" onRetry={runList} />}

      {/* Step 2 + 3 — discovered tenants + selection */}
      {listData && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-gray-200 text-xs dark:bg-gray-700">2</span>
              Discovered tenants
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {listData.tenants.length} tenant(s) · {importable.length} importable · scanned {listData.scanned}, skipped {listData.skipped}
            </span>
          </div>

          {tenants.length === 0 ? (
            <p className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
              No tenants with a completed bundle were found on this target.
            </p>
          ) : (
            <TenantTable
              rows={tenants}
              selected={selected}
              onToggleRow={toggleRow}
              allImportableSelected={allImportableSelected}
              onToggleSelectAll={toggleSelectAll}
              hasImportable={importable.length > 0}
            />
          )}

          {/* scope */}
          {tenants.length > 0 && (
            <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-gray-200 text-xs dark:bg-gray-700">3</span>
                What to import
              </div>
              <label className="mt-2 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="radio"
                  name="migration-scope"
                  checked={scope === 'selected'}
                  onChange={() => changeScope('selected')}
                  className="accent-blue-600"
                />
                <span><span className="font-medium">Selected tenants</span> — import the {selected.size} checked above.</span>
              </label>
              <label className="mt-2 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="radio"
                  name="migration-scope"
                  checked={scope === 'all'}
                  onChange={() => changeScope('all')}
                  className="accent-blue-600"
                />
                <span><span className="font-medium">All discovered</span> — import every importable tenant ({importable.length}); already-present tenants are skipped.</span>
              </label>
            </div>
          )}

          {/* Step 4 — preview / import controls */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runDryRun}
              disabled={!canImport || anyPending}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              {dryRun.isPending ? <Loader2 size={15} className="animate-spin" /> : <ListChecks size={15} />}
              Preview import (dry-run){canImport ? ` · ${targetCount}` : ''}
            </button>

            {dryRunData && !importData && (
              <button
                type="button"
                onClick={runImport}
                disabled={importReal.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {importReal.isPending ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
                Import {dryRunData.total} tenant(s) for real
              </button>
            )}
          </div>
        </section>
      )}

      {dryRun.isError && <ErrorPanel error={extractOperatorError(dryRun.error)} severity="error" onRetry={runDryRun} />}
      {importReal.isError && <ErrorPanel error={extractOperatorError(importReal.error)} severity="error" />}

      {/* Dry-run preview (what WOULD be imported) */}
      {dryRunData && !importData && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <AlertTriangle size={14} className="text-amber-600 dark:text-amber-400" />
            <span className="text-gray-700 dark:text-gray-300">
              Dry-run preview — <span className="font-medium">{dryRunData.total}</span> would be imported,
              {' '}{dryRunData.skipped} skipped. Nothing has been changed yet.
            </span>
          </div>
          <ResultTable rows={dryRunData.results} dryRun />
        </div>
      )}

      {/* Real import results */}
      {importData && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-gray-900 dark:text-gray-100">
              Imported {importData.imported}/{importData.total}
            </span>
            {importData.failed > 0 && <span className="text-red-600 dark:text-red-400">{importData.failed} failed</span>}
            {importData.skipped > 0 && <span className="text-gray-500 dark:text-gray-400">{importData.skipped} skipped</span>}
          </div>
          <ResultTable rows={importData.results} />
        </div>
      )}
    </div>
  );
}

interface TenantTableProps {
  readonly rows: readonly MigrationTenant[];
  readonly selected: ReadonlySet<string>;
  readonly onToggleRow: (tenantId: string) => void;
  readonly allImportableSelected: boolean;
  readonly onToggleSelectAll: () => void;
  readonly hasImportable: boolean;
}

function TenantTable({
  rows, selected, onToggleRow, allImportableSelected, onToggleSelectAll, hasImportable,
}: TenantTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
            <th className="px-3 py-2">
              <input
                type="checkbox"
                aria-label="Select all importable tenants"
                checked={allImportableSelected}
                onChange={onToggleSelectAll}
                disabled={!hasImportable}
                className="accent-blue-600 disabled:opacity-40"
              />
            </th>
            <th className="px-3 py-2">Tenant</th>
            <th className="px-3 py-2">Primary email</th>
            <th className="px-3 py-2">Latest bundle</th>
            <th className="px-3 py-2">Bundles</th>
            <th className="px-3 py-2">Size</th>
            <th className="px-3 py-2">Components</th>
            <th className="px-3 py-2">Resources</th>
            <th className="px-3 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const isSelected = selected.has(t.tenantId);
            return (
              <tr
                key={t.tenantId}
                className={`border-b border-gray-100 dark:border-gray-700/50 ${t.alreadyPresent ? 'opacity-60' : ''}`}
              >
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${t.tenantName}`}
                    checked={isSelected}
                    disabled={t.alreadyPresent}
                    onChange={() => onToggleRow(t.tenantId)}
                    className="accent-blue-600 disabled:opacity-40"
                  />
                </td>
                <td className="px-3 py-2 text-gray-900 dark:text-gray-100">
                  <div className="font-medium">{t.tenantName}</div>
                  <div className="font-mono text-[10px] text-gray-400 dark:text-gray-500">{t.tenantId.slice(0, 8)}…</div>
                </td>
                <td className="px-3 py-2 text-gray-600 dark:text-gray-300">
                  {t.primaryEmail ?? <span className="text-gray-400 dark:text-gray-500">—</span>}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{t.latestBundleId.slice(0, 12)}…</td>
                <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{t.bundleCount}</td>
                <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{humanizeBytes(t.totalSizeBytes)}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {t.components.length === 0
                      ? <span className="text-gray-400 dark:text-gray-500">—</span>
                      : t.components.map((c) => (
                        <span
                          key={c}
                          className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                        >
                          {c}
                        </span>
                      ))}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <ResourceCell resources={t.effectiveResources} />
                </td>
                <td className="px-3 py-2">
                  {t.alreadyPresent
                    ? <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">already present</span>
                    : <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">importable</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Compact display of a tenant's EFFECTIVE resource limits (override ?? plan
 * baseline) captured in its newest bundle — so the operator sees the real
 * customized quotas before importing. Legacy bundles have none → muted hint.
 * Units mirror the plan-editor conventions (cores / GB / counts).
 */
function ResourceCell({ resources }: { resources: MigrationTenant['effectiveResources'] }) {
  if (!resources) {
    return (
      <span
        className="text-xs text-gray-400 dark:text-gray-500"
        title="No effective resources captured (legacy bundle) — the destination plan's defaults apply on import."
      >
        — plan defaults
      </span>
    );
  }

  const chips: readonly { readonly label: string; readonly value: string; readonly title: string }[] = [
    { label: 'CPU', value: `${resources.cpuLimit}`, title: `${resources.cpuLimit} CPU core(s)` },
    { label: 'RAM', value: `${resources.memoryLimit} GB`, title: `${resources.memoryLimit} GB memory` },
    { label: 'Disk', value: `${resources.storageLimit} GB`, title: `${resources.storageLimit} GB storage` },
    { label: 'Mbx', value: `${resources.maxMailboxes}`, title: `${resources.maxMailboxes} mailboxes` },
    { label: 'Users', value: `${resources.maxSubUsers}`, title: `${resources.maxSubUsers} sub-users` },
  ];

  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c.label}
          title={c.title}
          className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300"
        >
          <span className="text-gray-400 dark:text-gray-500">{c.label}</span>
          <span>{c.value}</span>
        </span>
      ))}
    </div>
  );
}

function ResultTable({ rows, dryRun = false }: { rows: readonly MigrationImportResult[]; dryRun?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
            <th className="px-3 py-2">Tenant</th>
            <th className="px-3 py-2">Result</th>
            <th className="px-3 py-2">Residual gaps</th>
            <th className="px-3 py-2">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.tenantId}:${r.bundleId}`} className="border-b border-gray-100 dark:border-gray-700/50">
              <td className="px-3 py-2 text-gray-900 dark:text-gray-100">
                {r.tenantName ?? <span className="font-mono text-xs">{r.tenantId.slice(0, 8)}…</span>}
              </td>
              <td className="px-3 py-2">
                {dryRun
                  ? (r.alreadyPresent
                    ? <span className="text-gray-500 dark:text-gray-400">would skip (present)</span>
                    : <span className="text-blue-700 dark:text-blue-300">would import</span>)
                  : (r.ok
                    ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={14} /> {r.status ?? 'done'}{r.recreated ? ' (re-created)' : ''}</span>
                    : <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400"><XCircle size={14} /> {r.status ?? 'failed'}</span>)}
              </td>
              <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">
                {r.residualGaps.length === 0
                  ? <span className="text-gray-400 dark:text-gray-500">none</span>
                  : (
                    <div className="flex flex-wrap gap-1">
                      {r.residualGaps.map((g) => (
                        <span key={g} className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{g}</span>
                      ))}
                    </div>
                  )}
              </td>
              <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400" title={r.error ?? undefined}>
                {r.error ? r.error.slice(0, 80) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

