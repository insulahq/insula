/**
 * Tenant DR Recover tab (gap G3).
 *
 * The operator-visible, one-button tenant recovery: drives
 * `POST /api/v1/admin/dr/tenants/:tenantId/recover`, which orchestrates
 * provision → create cart → add items → execute in a single admin call,
 * then polls the resulting restore cart's per-item progress until it
 * reaches a terminal state.
 *
 * This is the tenant-DATA DR path (cluster loss / cross-cluster copy /
 * accidental deletion) — distinct from the cluster-wide bundle/drill
 * runbooks in the sibling tabs. On success it surfaces `recreated` (a
 * deleted tenant was re-created from the bundle) and `residualGaps` (the
 * manual steps the recover route could not close on its own).
 */

import { useState } from 'react';
import { LifeBuoy, Loader2, RotateCcw, ShieldAlert, ArrowRight } from 'lucide-react';
import type {
  DrRecoverComponent,
  DrRecoverRequest,
  MailboxRestoreMode,
  RestoreItemStatus,
  RestoreItemType,
  RestoreJobStatus,
} from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import {
  useRecoverTenantFromBundle,
  useLiveRestoreCart,
  isTerminalCartStatus,
} from '@/hooks/use-dr-recover';

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

const ITEM_TYPE_LABEL: Record<RestoreItemType, string> = {
  'files-paths': 'Files',
  'mailboxes-by-address': 'Mailboxes',
  'deployments-by-id': 'Deployments',
  'databases-by-id': 'Databases',
  'domains-by-id': 'Domains',
  'config-tables': 'Config',
};

const ITEM_STATUS_BADGE: Record<RestoreItemStatus, string> = {
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  applying: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  done: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  skipped: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
};

const CART_STATUS_BADGE: Record<RestoreJobStatus, string> = {
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  executing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  done: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

const RECONCILE_BADGE: Record<'ok' | 'bad' | 'muted', string> = {
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  bad: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  muted: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
};

function reconcileBadgeClass(kind: 'ok' | 'bad' | 'muted'): string {
  return `inline-block rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${RECONCILE_BADGE[kind]}`;
}

// ── Component ─────────────────────────────────────────────────────────

export default function TenantRecoverTab() {
  const [tenantId, setTenantId] = useState('');
  const [bundleId, setBundleId] = useState('');
  const [targetNode, setTargetNode] = useState('');
  const [components, setComponents] = useState<ReadonlySet<DrRecoverComponent>>(
    new Set<DrRecoverComponent>(['config', 'files', 'mailboxes']),
  );
  const [mailboxMode, setMailboxMode] = useState<MailboxRestoreMode>('merge-skip-duplicates');
  const [provision, setProvision] = useState(true);

  const recover = useRecoverTenantFromBundle();
  const result = recover.data?.data ?? null;
  const live = useLiveRestoreCart(result?.cartId ?? null);
  const liveCart = live.data?.data ?? null;

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
    const input: DrRecoverRequest = {
      provision,
      ...(bundleId.trim() ? { bundleId: bundleId.trim() } : {}),
      ...(targetNode.trim() ? { targetNode: targetNode.trim() } : {}),
      ...(allThreeSelected ? {} : { components: selected }),
      ...(mailboxesSelected ? { mailboxMode } : {}),
    };
    try {
      await recover.mutateAsync({ tenantId: tenantId.trim(), input });
    } catch {
      /* surfaced via <ErrorPanel> below */
    }
  };

  const polling = liveCart != null && !isTerminalCartStatus(liveCart.status);

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
            <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Bundle ID <span className="text-gray-400 dark:text-gray-500">(optional)</span>
            </span>
            <input
              type="text"
              value={bundleId}
              onChange={(e) => setBundleId(e.target.value)}
              placeholder="empty = newest completed bundle"
              disabled={recover.isPending}
              data-testid="dr-recover-bundle-id"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
            />
          </label>

          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Target node <span className="text-gray-400 dark:text-gray-500">(optional — pin recovered resources to a node)</span>
            </span>
            <input
              type="text"
              value={targetNode}
              onChange={(e) => setTargetNode(e.target.value)}
              placeholder="empty = auto-placement"
              disabled={recover.isPending}
              data-testid="dr-recover-target-node"
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
            />
          </label>
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
            {recover.isPending ? 'Recovering…' : 'Recover'}
          </button>
          {!tenantId.trim() && (
            <span className="text-xs text-gray-500 dark:text-gray-400">Enter a Tenant ID to enable.</span>
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

      {/* ── Recover result summary ───────────────────────────────────── */}
      {result && (
        <section
          className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
          data-testid="dr-recover-result"
        >
          <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Recover triggered</h3>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Cart ID</dt>
              <dd className="font-mono text-xs text-gray-900 dark:text-gray-100" data-testid="dr-recover-cart-id">{result.cartId}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Bundle</dt>
              <dd className="font-mono text-xs text-gray-900 dark:text-gray-100">{result.bundleId}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Status</dt>
              <dd>
                <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${CART_STATUS_BADGE[result.status]}`}>
                  {result.status}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Provisioned</dt>
              <dd className="text-sm text-gray-900 dark:text-gray-100">{result.provisioned ? 'yes' : 'no'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Components</dt>
              <dd className="text-sm text-gray-900 dark:text-gray-100">{result.components.join(' → ') || '—'}</dd>
            </div>
          </dl>

          {result.recreated && (
            <div
              className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
              data-testid="dr-recover-recreated"
            >
              <ShieldAlert size={16} className="mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-semibold">Tenant re-created from the bundle</p>
                <p className="mt-0.5">
                  The tenant row was absent — it was re-created (original tenant ID + namespace
                  preserved) before restore. Review the remaining manual steps below.
                </p>
              </div>
            </div>
          )}

          {result.reconcile && (
            <div
              className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40"
              data-testid="dr-recover-reconcile"
            >
              <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Auto-reconcile (post-restore)</h4>
              <ul className="mt-1.5 space-y-1 text-sm text-gray-700 dark:text-gray-300">
                <li className="flex items-center gap-2">
                  <span className={reconcileBadgeClass(
                    result.reconcile.ingress === 'reconciled' ? 'ok' : result.reconcile.ingress === 'failed' ? 'bad' : 'muted',
                  )}>{result.reconcile.ingress}</span>
                  Ingress routes rebuilt
                </li>
                <li className="flex items-center gap-2">
                  <span className={reconcileBadgeClass(result.reconcile.mail.failed > 0 ? 'bad' : 'ok')}>
                    {result.reconcile.mail.dkimRegenerated}/{result.reconcile.mail.domainsTotal}
                  </span>
                  Mail domains DKIM-resigned{result.reconcile.mail.failed > 0 ? ` — ${result.reconcile.mail.failed} failed` : ''}
                </li>
                <li className="flex items-center gap-2">
                  <span className={reconcileBadgeClass(result.reconcile.workloads.failed > 0 ? 'bad' : 'ok')}>
                    {result.reconcile.workloads.redeployed}/{result.reconcile.workloads.total}
                  </span>
                  Workloads redeployed{result.reconcile.workloads.failed > 0 ? ` — ${result.reconcile.workloads.failed} failed` : ''}
                </li>
              </ul>
            </div>
          )}

          {result.residualGaps.length > 0 && (
            <div className="mt-4" data-testid="dr-recover-residual-gaps">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
                <ArrowRight size={14} /> Remaining manual steps
              </h4>
              <ul className="mt-1.5 list-disc space-y-1 pl-6 text-sm text-gray-700 dark:text-gray-300">
                {result.residualGaps.map((gap, i) => (
                  <li key={i}>{gap}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* ── Live restore progress ────────────────────────────────────── */}
      {result && (
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Restore progress</h3>
            <div className="flex items-center gap-2">
              {liveCart && (
                <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${CART_STATUS_BADGE[liveCart.status]}`}>
                  {liveCart.status}
                </span>
              )}
              {polling && <Loader2 size={14} className="animate-spin text-gray-400 dark:text-gray-500" />}
            </div>
          </div>

          {live.error && (
            <ErrorPanel error={extractOperatorError(live.error)} severity="error" testId="dr-recover-progress-error" />
          )}

          {!live.error && !liveCart && (
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading cart…</p>
          )}

          {liveCart && liveCart.items.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">No restore items on this cart.</p>
          )}

          {liveCart && liveCart.items.length > 0 && (
            <table className="w-full text-sm" data-testid="dr-recover-progress-table">
              <thead className="text-gray-500 dark:text-gray-400">
                <tr className="border-b border-gray-200/60 dark:border-gray-700/40">
                  <th className="px-2 py-2 text-left">#</th>
                  <th className="px-2 py-2 text-left">Type</th>
                  <th className="px-2 py-2 text-left">Status</th>
                  <th className="px-2 py-2 text-left">Progress</th>
                </tr>
              </thead>
              <tbody>
                {[...liveCart.items].sort((a, b) => a.seq - b.seq).map((item) => (
                  <tr key={item.id} className="border-t border-gray-200/60 dark:border-gray-700/40">
                    <td className="px-2 py-2 tabular-nums text-gray-500 dark:text-gray-400">{item.seq}</td>
                    <td className="px-2 py-2 text-gray-900 dark:text-gray-100">{ITEM_TYPE_LABEL[item.type]}</td>
                    <td className="px-2 py-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${ITEM_STATUS_BADGE[item.status]}`}>
                        {item.status}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-gray-600 dark:text-gray-400">
                      {item.progressMessage ?? (item.lastError ? item.lastError : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
