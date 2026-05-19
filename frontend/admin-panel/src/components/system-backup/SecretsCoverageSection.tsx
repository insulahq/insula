/**
 * Coverage audit panel (DR-bundle bundle-everything redesign).
 *
 * Rendered inside SecretsBundleTab. Under bundle-everything semantics
 * EVERY non-denied Secret in the cluster ends up in the bundle — so
 * there's no "uncovered/red-banner" state. The panel is informational:
 *   - Top neutral banner with the bundle-everything tagline
 *   - Five chips (denied / tier-1-platform / tier-2-tenant /
 *     unclassified / skip-at-restore)
 *   - Per-Secret table (all entries, sortable by category) with a
 *     "Skip at restore" action for entries the operator wants to
 *     exclude at restore time. Replaces yesterday's "Add to allowlist".
 *   - Collapsible "Skip-at-restore" list of operator-marked entries
 *     with a "Remove" button.
 */

import { useMemo, useState } from 'react';
import { Info, RefreshCw, Shield, Plus, Trash2 } from 'lucide-react';
import type { AuditedSecret, SecretCoverageCategory } from '@k8s-hosting/api-contracts';
import {
  useAddAllowlistEntry,
  useRefreshSecretsAudit,
  useRemoveAllowlistEntry,
  useSecretsAudit,
  useSecretsAuditAllowlist,
} from '@/hooks/use-system-backup';

export default function SecretsCoverageSection() {
  const auditQ = useSecretsAudit();
  const allowlistQ = useSecretsAuditAllowlist();
  const refresh = useRefreshSecretsAudit();
  const removeEntry = useRemoveAllowlistEntry();
  const [modal, setModal] = useState<AuditedSecret | null>(null);
  const [filter, setFilter] = useState<SecretCoverageCategory | 'all'>('all');

  const audit = auditQ.data;
  const visibleSecrets = useMemo(() => {
    if (!audit) return [];
    return filter === 'all'
      ? audit.allSecrets
      : audit.allSecrets.filter((s) => s.category === filter);
  }, [audit, filter]);

  return (
    <section className="space-y-4" data-testid="secrets-coverage">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield size={20} className="text-brand-600 dark:text-brand-400" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Coverage</h3>
        </div>
        <button
          type="button"
          onClick={() => void refresh.mutateAsync()}
          disabled={refresh.isPending}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          data-testid="secrets-audit-refresh"
        >
          <RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : ''} />
          Re-audit
        </button>
      </header>

      <div className="rounded-md border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 p-3 text-sm text-blue-900 dark:text-blue-200 flex items-start gap-2">
        <Info size={16} className="flex-shrink-0 mt-0.5" />
        <div>
          <strong>Bundle-everything mode.</strong> Every Secret in the cluster that isn&apos;t auto-managed
          by a controller will be included in the next bundle. Use <em>Skip at restore</em> on the rows below
          to exclude specific entries from being re-applied by <code>bootstrap.sh --restore-profile=…</code>.
        </div>
      </div>

      {auditQ.isLoading && <Skeleton />}
      {auditQ.isError && (
        <div className="rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-900 dark:text-red-200">
          Failed to load audit: {auditQ.error instanceof Error ? auditQ.error.message : String(auditQ.error)}
        </div>
      )}

      {audit && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2" data-testid="audit-chips">
            <CategoryChip label="Tier-1 platform" count={audit.byCategory.tier1Platform} tone="good" active={filter === 'tier-1-platform'} onClick={() => setFilter(filter === 'tier-1-platform' ? 'all' : 'tier-1-platform')} />
            <CategoryChip label="Tier-2 tenant" count={audit.byCategory.tier2Tenant} tone="good" active={filter === 'tier-2-tenant'} onClick={() => setFilter(filter === 'tier-2-tenant' ? 'all' : 'tier-2-tenant')} />
            <CategoryChip label="Unclassified" count={audit.byCategory.unclassified} tone="info" active={filter === 'unclassified'} onClick={() => setFilter(filter === 'unclassified' ? 'all' : 'unclassified')} />
            <CategoryChip label="Skip at restore" count={audit.byCategory.skipAtRestore} tone="warn" active={filter === 'skip-at-restore'} onClick={() => setFilter(filter === 'skip-at-restore' ? 'all' : 'skip-at-restore')} />
            <CategoryChip label="Denied (auto-managed)" count={audit.byCategory.denied} tone="neutral" active={filter === 'denied'} onClick={() => setFilter(filter === 'denied' ? 'all' : 'denied')} />
          </div>

          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {filter === 'all' ? 'All Secrets' : (
                  <>Showing <code className="text-xs">{filter}</code></>
                )} ({visibleSecrets.length})
              </span>
              {filter !== 'all' && (
                <button
                  type="button"
                  onClick={() => setFilter('all')}
                  className="text-xs text-brand-600 hover:underline dark:text-brand-400"
                >
                  Clear filter
                </button>
              )}
            </div>
            <table className="min-w-full text-sm" data-testid="audit-table">
              <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">Namespace</th>
                  <th className="px-4 py-2 text-left">Name</th>
                  <th className="px-4 py-2 text-left">Category</th>
                  <th className="px-4 py-2 text-left">Reason</th>
                  <th className="px-4 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {visibleSecrets.slice(0, 200).map((s) => (
                  <tr key={`${s.namespace}/${s.name}`}>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">{s.namespace}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{s.name}</td>
                    <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200">{s.category}</td>
                    <td className="px-4 py-2 text-xs text-gray-500">{s.reason}</td>
                    <td className="px-4 py-2 text-right">
                      {s.category !== 'denied' && s.category !== 'skip-at-restore' && (
                        <button
                          type="button"
                          onClick={() => setModal(s)}
                          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-400"
                          data-testid={`skip-at-restore-${s.namespace}-${s.name}`}
                        >
                          <Plus size={12} />
                          Skip at restore…
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {visibleSecrets.length > 200 && (
                  <tr><td colSpan={5} className="px-4 py-3 text-xs text-gray-500 text-center">… {visibleSecrets.length - 200} more rows (filter or use the API for full list)</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <details className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
              Skip-at-restore entries ({allowlistQ.data?.entries.length ?? 0})
            </summary>
            <div className="px-4 pb-4">
              {(allowlistQ.data?.entries.length ?? 0) === 0 ? (
                <p className="text-sm text-gray-500 py-2">No skip-at-restore entries.</p>
              ) : (
                <table className="min-w-full text-sm" data-testid="allowlist-table">
                  <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">Secret</th>
                      <th className="px-3 py-2 text-left">Reason</th>
                      <th className="px-3 py-2 text-left">Added by</th>
                      <th className="px-3 py-2 text-left">Added at</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {(allowlistQ.data?.entries ?? []).map((e) => (
                      <tr key={`${e.namespace}/${e.name}`}>
                        <td className="px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{e.namespace}/{e.name}</td>
                        <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-200">{e.reason}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">{e.addedBy}</td>
                        <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-200">{new Date(e.addedAt).toISOString().slice(0, 19).replace('T', ' ')}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => void removeEntry.mutateAsync({ namespace: e.namespace, name: e.name })}
                            className="text-xs text-red-600 hover:underline dark:text-red-400"
                            data-testid={`allowlist-remove-${e.namespace}-${e.name}`}
                          >
                            <Trash2 size={12} className="inline" /> Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </details>
        </>
      )}

      {modal && <SkipAtRestoreModal secret={modal} onClose={() => setModal(null)} />}
    </section>
  );
}

function CategoryChip({ label, count, tone, active, onClick }: { label: string; count: number; tone: 'good' | 'bad' | 'info' | 'warn' | 'neutral'; active: boolean; onClick: () => void }) {
  const cls =
    tone === 'good'
      ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-900 dark:text-emerald-200'
      : tone === 'bad'
        ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-900 dark:text-red-200'
        : tone === 'info'
          ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 text-blue-900 dark:text-blue-200'
          : tone === 'warn'
            ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200'
            : 'border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-200';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border text-left ${cls} p-3 transition-shadow ${active ? 'ring-2 ring-brand-500 shadow-inner' : 'hover:shadow-sm'}`}
    >
      <div className="text-xs uppercase">{label}</div>
      <div className="text-2xl font-semibold">{count}</div>
    </button>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      <div className="h-12 rounded-md bg-gray-100 dark:bg-gray-800 animate-pulse" />
      <div className="h-32 rounded-md bg-gray-100 dark:bg-gray-800 animate-pulse" />
    </div>
  );
}

function SkipAtRestoreModal({ secret, onClose }: { secret: AuditedSecret; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const add = useAddAllowlistEntry();
  const valid = reason.trim().length >= 10;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Skip {secret.namespace}/{secret.name} at restore
          </h3>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-700">✕</button>
        </div>
        <div className="px-5 py-4 space-y-3 text-sm">
          <p className="text-gray-700 dark:text-gray-200">
            This Secret will STILL be included in the bundle (every non-denied Secret is bundled). The
            <code className="mx-1">conservative</code>and<code className="mx-1">full</code>restore profiles
            will refuse to apply it on a fresh cluster — unless the operator passes
            <code className="mx-1">--override-skip-at-restore</code>. Use this for ephemeral values you
            want to regenerate on restore (session cookies, temporary credentials, etc.).
          </p>
          <label className="block">
            <span className="text-xs uppercase text-gray-600 dark:text-gray-400">Reason (≥10 chars)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="e.g. session cookie — rotate on restore, do not carry old value"
              className="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
              data-testid="skip-at-restore-reason-input"
            />
          </label>
          {add.error && (
            <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-2 text-xs text-red-900 dark:text-red-200">
              {add.error instanceof Error ? add.error.message : String(add.error)}
            </div>
          )}
        </div>
        <div className="border-t border-gray-200 dark:border-gray-700 px-5 py-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
          <button
            type="button"
            disabled={!valid || add.isPending}
            onClick={async () => {
              await add.mutateAsync({ namespace: secret.namespace, name: secret.name, reason: reason.trim() });
              onClose();
            }}
            className="rounded-md px-3 py-1.5 text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            data-testid="skip-at-restore-submit"
          >
            Skip at restore
          </button>
        </div>
      </div>
    </div>
  );
}
