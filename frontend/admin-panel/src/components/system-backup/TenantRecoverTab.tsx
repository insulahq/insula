/**
 * Tenant DR Recover tab (gap G3).
 *
 * The operator-visible, one-button tenant recovery: starts
 * `POST /api/v1/admin/dr/tenants/:tenantId/recover` in the background, which
 * orchestrates provision → create cart → add items → execute → reconcile on
 * the server as a `dr.recover` task-center task.
 *
 * The progress is NOT on this page: starting opens `DrRecoverProgressModal`
 * (step timeline, the restore cart's per-item progress, the final result —
 * `recreated`, the reconcile report, `residualGaps` — or the OperatorError).
 * Closing the modal leaves the recovery running; the task-center chip
 * re-opens it. This page is only the form.
 *
 * This is the tenant-DATA DR path (cluster loss / cross-cluster copy /
 * accidental deletion) — distinct from the cluster-wide bundle/drill
 * runbooks in the sibling tabs.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LifeBuoy, Loader2, RotateCcw, ShieldAlert } from 'lucide-react';
import type {
  DrRecoverComponent,
  DrRecoverRequest,
  MailboxRestoreMode,
} from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import DrRecoverProgressModal from '@/components/DrRecoverProgressModal';
import { extractOperatorError } from '@/lib/extract-operator-error';
import {
  useRecoverableTenants,
  useRecoveryInfo,
  useStartTenantRecovery,
} from '@/hooks/use-dr-recover';
import SearchablePicker from '@/components/ui/SearchablePicker';
import { BundleChooser, TenantFacts } from './RecoverTenantPickers';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import { useNodeLabel } from '@/hooks/use-node-labels';

// ── Static option data ────────────────────────────────────────────────

const ALL_COMPONENTS: ReadonlyArray<{ id: DrRecoverComponent; label: string; hint: string }> = [
  { id: 'config', label: 'Config', hint: 'Tenant config tables (domains, deployments, settings)' },
  { id: 'files', label: 'Files', hint: 'Tenant PVC file tree + add-on DB dumps' },
  { id: 'mailboxes', label: 'Mailboxes', hint: 'Mail messages restored via IMAP merge' },
];

const MAILBOX_MODES: ReadonlyArray<{ id: MailboxRestoreMode; label: string }> = [
  { id: 'merge-skip-duplicates', label: 'Merge — skip duplicates (safe, default)' },
  { id: 'merge-overwrite', label: 'Merge — keep duplicates' },
  { id: 'replace', label: 'Replace — wipe then restore (destructive)' },
];

// ── Component ─────────────────────────────────────────────────────────

export default function TenantRecoverTab() {
  // Deep link from Backups → Tenants / the "Tenant was deleted" banner.
  const [params] = useSearchParams();
  const [tenantId, setTenantId] = useState(params.get('tenant') ?? '');
  // Recovery is driven by NAME, not by a UUID an operator has to find and
  // paste. The candidates are every tenant with restorable bundles — a tenant
  // that has already been DELETED (the case this tab exists for) included,
  // by the name it had, for as long as its bundles are kept.
  const [manualTenantId, setManualTenantId] = useState(false);
  const recoverable = useRecoverableTenants();
  const tenantChoices = recoverable.data?.data ?? [];
  // '' = the newest completed bundle — what the recover uses when none is chosen.
  const [bundleId, setBundleId] = useState('');
  // A different tenant means a different bundle list: never carry one over.
  // (Not while typing ids for a foreign target — those are entered together.)
  useEffect(() => { if (!manualTenantId) setBundleId(''); }, [tenantId, manualTenantId]);
  const infoQuery = useRecoveryInfo(manualTenantId ? '' : tenantId, bundleId);
  const info = infoQuery.data?.data ?? null;
  const nodesQuery = useClusterNodes();
  const nodeLabel = useNodeLabel();
  const nodeOptions = (nodesQuery.data?.data ?? [])
    .filter((n) => n.canHostTenantWorkloads)
    .map((n) => ({
      key: n.name,
      label: nodeLabel(n.name),
      meta: `${n.role}${n.statusConditions?.find((c) => c.type === 'Ready')?.status === 'True' ? '' : ' · NotReady'}${nodeLabel(n.name) !== n.name ? ` · ${n.name}` : ''}`,
    }));
  const [targetNode, setTargetNode] = useState('');
  const [components, setComponents] = useState<ReadonlySet<DrRecoverComponent>>(
    new Set<DrRecoverComponent>(['config', 'files', 'mailboxes']),
  );
  const [mailboxMode, setMailboxMode] = useState<MailboxRestoreMode>('merge-skip-duplicates');
  const [provision, setProvision] = useState(true);
  // Force the post-restore reconcile for an EXISTING tenant that lost its
  // namespace (node loss). Auto-runs on a re-create regardless of this toggle.
  const [forceReconcile, setForceReconcile] = useState(false);

  const recover = useStartTenantRecovery();
  // The running recovery's task — its progress modal is open while set.
  const [progressTaskId, setProgressTaskId] = useState<string | null>(null);

  const mailboxesSelected = components.has('mailboxes');
  const allThreeSelected = components.size === ALL_COMPONENTS.length;
  const canSubmit = tenantId.trim().length > 0 && components.size > 0 && !recover.isPending;

  const toggleComponent = (id: DrRecoverComponent): void => {
    setComponents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    // "omit → all present in the bundle" is the safe default, so only send
    // an explicit `components` list when the operator narrowed the set.
    const selected = ALL_COMPONENTS.map((c) => c.id).filter((id) => components.has(id));
    const input: Omit<DrRecoverRequest, 'background'> = {
      provision,
      ...(bundleId.trim() ? { bundleId: bundleId.trim() } : {}),
      ...(targetNode.trim() ? { targetNode: targetNode.trim() } : {}),
      ...(allThreeSelected ? {} : { components: selected }),
      ...(mailboxesSelected ? { mailboxMode } : {}),
      ...(forceReconcile ? { reconcile: true } : {}),
    };
    try {
      const started = await recover.mutateAsync({ tenantId: tenantId.trim(), input });
      setProgressTaskId(started.data.taskId);
    } catch {
      /* a refusal (no such tenant, already recovering) — surfaced via <ErrorPanel> below */
    }
  };

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          <LifeBuoy size={20} /> Recover Tenant from Bundle
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Tenant-data disaster recovery — restore a tenant from its off-site bundle after cluster
          loss, when copying to another cluster, or after accidental deletion. Re-provisions the
          namespace, then restores the selected components in apply order.
        </p>
      </header>

      {/* ── Recover form ─────────────────────────────────────────────── */}
      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="space-y-4">
          {manualTenantId ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Tenant ID <span className="text-red-600 dark:text-red-400">*</span>
                </span>
                <input
                  type="text"
                  value={tenantId}
                  onChange={(e) => setTenantId(e.target.value)}
                  placeholder="tenant UUID"
                  disabled={recover.isPending}
                  data-testid="dr-recover-tenant-id"
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Bundle ID</span>
                <input
                  type="text"
                  value={bundleId}
                  onChange={(e) => setBundleId(e.target.value)}
                  placeholder="the bundle on the foreign target"
                  disabled={recover.isPending}
                  data-testid="dr-recover-bundle-id"
                  className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
                />
              </label>
            </div>
          ) : (
            <div data-testid="dr-recover-tenant-picker">
              <SearchablePicker
                id="dr-recover-tenant"
                label="Tenant"
                value={tenantId || null}
                placeholder="Search tenants…"
                loading={recoverable.isLoading}
                disabled={recover.isPending}
                options={tenantChoices.map((t) => ({
                  key: t.tenantId,
                  label: t.name,
                  meta: `${t.deleted ? `DELETED${t.deletedAt ? ` ${t.deletedAt.slice(0, 10)}` : ''} · ` : ''}${t.bundleCount} bundle${t.bundleCount === 1 ? '' : 's'}${t.keptUntil ? ` · until ${t.keptUntil.slice(0, 10)}` : ''}`,
                }))}
                onChange={(k) => setTenantId(k ?? '')}
              />
            </div>
          )}
          <button
            type="button"
            onClick={() => { setManualTenantId((v) => !v); setTenantId(''); setBundleId(''); }}
            className="cursor-pointer text-xs text-gray-500 underline hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            {manualTenantId
              ? 'Pick from the tenants that have bundles'
              : 'Enter a tenant ID instead (bundle on a foreign target)'}
          </button>

          {!manualTenantId && tenantId && (
            <>
              <TenantFacts info={info} loading={infoQuery.isLoading} />
              <div>
                <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Bundle</span>
                {info
                  ? <BundleChooser bundles={info.bundles} value={bundleId} onChange={setBundleId} disabled={recover.isPending} />
                  : infoQuery.isError && (
                    <ErrorPanel error={extractOperatorError(infoQuery.error)} severity="error" testId="dr-recover-info-error" />
                  )}
              </div>
            </>
          )}

          <div data-testid="dr-recover-target-node">
            <SearchablePicker
              id="dr-recover-node"
              label="Target node"
              value={targetNode || null}
              placeholder="Search nodes…"
              allLabel="Automatic — the tenant's primary node, else the scheduler"
              loading={nodesQuery.isLoading}
              disabled={recover.isPending}
              options={nodeOptions}
              onChange={(k) => setTargetNode(k ?? '')}
            />
          </div>
        </div>

        {/* Components */}
        <fieldset className="mt-5">
          <legend className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">Components</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {ALL_COMPONENTS.map((c) => {
              const checked = components.has(c.id);
              return (
                <label
                  key={c.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm ${
                    checked
                      ? 'border-brand-400 bg-brand-50 dark:border-brand-600 dark:bg-brand-900/20'
                      : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleComponent(c.id)}
                    disabled={recover.isPending}
                    data-testid={`dr-recover-component-${c.id}`}
                    className="mt-0.5 rounded disabled:opacity-50"
                  />
                  <span>
                    <span className="block font-medium text-gray-900 dark:text-gray-100">{c.label}</span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">{c.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
            All selected recovers every component present in the bundle. Uncheck to restrict.
          </p>
        </fieldset>

        {/* Mailbox mode — only relevant when mailboxes are recovered */}
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Mailbox mode</span>
            <select
              value={mailboxMode}
              onChange={(e) => setMailboxMode(e.target.value as MailboxRestoreMode)}
              disabled={recover.isPending || !mailboxesSelected}
              data-testid="dr-recover-mailbox-mode"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            >
              {MAILBOX_MODES.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            {mailboxesSelected && mailboxMode === 'replace' && (
              <span className="mt-1 flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                <ShieldAlert size={12} /> Replace wipes existing mailbox contents before restoring.
              </span>
            )}
          </label>

          <label className="flex items-center gap-2 self-end pb-2">
            <input
              type="checkbox"
              checked={provision}
              onChange={(e) => setProvision(e.target.checked)}
              disabled={recover.isPending}
              data-testid="dr-recover-provision"
              className="rounded disabled:opacity-50"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Re-provision namespace / PVC before restoring
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                Required after cluster loss or deletion; safe to leave on.
              </span>
            </span>
          </label>

          <label className="flex items-center gap-2 self-end pb-2 sm:col-span-2">
            <input
              type="checkbox"
              checked={forceReconcile}
              onChange={(e) => setForceReconcile(e.target.checked)}
              disabled={recover.isPending}
              data-testid="dr-recover-force-reconcile"
              className="rounded disabled:opacity-50"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Re-establish services after restore (ingress, mail signing, workloads)
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                Auto-runs when re-creating a deleted tenant. Check this to also reconcile an
                <span className="font-medium"> existing </span>
                tenant that lost its namespace to a dead node — it redeploys workloads, so leave it
                OFF when restoring data into a healthy, running tenant.
              </span>
            </span>
          </label>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            data-testid="dr-recover-submit"
            className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-600 dark:hover:bg-brand-500"
          >
            {recover.isPending ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}
            {recover.isPending ? 'Starting…' : 'Recover'}
          </button>
          {!tenantId.trim()
            ? <span className="text-xs text-gray-500 dark:text-gray-400">Enter a Tenant ID to enable.</span>
            : (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                Runs on the server — its progress opens in a window and stays in the task center.
              </span>
            )}
        </div>

        {recover.error && (
          <div className="mt-4">
            <ErrorPanel
              error={extractOperatorError(recover.error)}
              severity="error"
              onRetry={() => void onSubmit()}
              retryPending={recover.isPending}
              testId="dr-recover-error"
            />
          </div>
        )}
      </section>

      {progressTaskId && (
        <DrRecoverProgressModal taskId={progressTaskId} onClose={() => setProgressTaskId(null)} />
      )}
    </div>
  );
}
