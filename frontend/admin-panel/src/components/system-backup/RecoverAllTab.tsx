/**
 * Batch DR recover-all (S3): after a cluster rebuild, restore every LOST tenant
 * (has a completed off-site bundle + namespace absent) in one operation.
 *
 * Two-step, deliberately: PREVIEW (dry-run) resolves the target set — tenant +
 * newest bundle + namespace presence — so the operator confirms exactly which
 * tenants will be recovered; only then does RECOVER execute (per-tenant,
 * sequentially). `scope: 'missing'` never touches a live tenant; `'all'` is an
 * explicit disruptive opt-in that also restores over live tenants.
 */

import { useState } from 'react';
import {
  LifeBuoy, RefreshCw, Play, CheckCircle2, XCircle, Loader2, AlertTriangle,
} from 'lucide-react';
import { useDrRecoverAllPreview, useDrRecoverAll } from '@/hooks/use-dr-recover';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import type { DrRecoverAllTarget, DrRecoverAllResult } from '@insula/api-contracts';

type Scope = 'missing' | 'all';

export default function RecoverAllTab() {
  const [scope, setScope] = useState<Scope>('missing');
  const [confirming, setConfirming] = useState(false);
  const preview = useDrRecoverAllPreview();
  const recover = useDrRecoverAll();

  const targets: readonly DrRecoverAllTarget[] = preview.data?.data.targets ?? [];
  const results: readonly DrRecoverAllResult[] = recover.data?.data.results ?? [];
  const summary = recover.data?.data;

  const runPreview = () => {
    setConfirming(false);
    recover.reset();
    preview.mutate({ scope });
  };
  const runRecover = () => {
    setConfirming(false);
    recover.mutate({ scope });
  };

  return (
    <div className="space-y-5">
      <header className="flex items-start gap-3">
        <LifeBuoy size={22} className="mt-0.5 flex-shrink-0 text-gray-700 dark:text-gray-300" />
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Recover all lost tenants</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-600 dark:text-gray-400">
            After a cluster rebuild, restore every tenant whose namespace is gone but which still has a
            completed off-site bundle — in one operation. Each tenant is re-provisioned and restored from its
            newest bundle. Always <span className="font-medium">preview</span> first to confirm the set.
          </p>
        </div>
      </header>

      {/* scope */}
      <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="radio"
            name="recover-all-scope"
            checked={scope === 'missing'}
            onChange={() => setScope('missing')}
            className="accent-blue-600"
          />
          <span><span className="font-medium">Lost tenants only</span> (recommended) — namespace absent; never touches a live tenant.</span>
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
          <input
            type="radio"
            name="recover-all-scope"
            checked={scope === 'all'}
            onChange={() => setScope('all')}
            className="accent-amber-600"
          />
          <span><AlertTriangle size={13} className="mr-1 inline" /><span className="font-medium">All tenants with a bundle</span> — DISRUPTIVE: also restores over live tenants.</span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={runPreview}
          disabled={preview.isPending || recover.isPending}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          {preview.isPending ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
          Preview lost tenants
        </button>
        {preview.data && targets.length > 0 && !recover.data && (
          confirming ? (
            <span className="inline-flex items-center gap-2 text-sm">
              <span className="text-gray-700 dark:text-gray-300">Recover {targets.length} tenant(s){scope === 'all' ? ' (incl. live)' : ''}?</span>
              <button
                type="button"
                onClick={runRecover}
                disabled={recover.isPending}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${scope === 'all' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700'}`}
              >
                {recover.isPending ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} Confirm recover
              </button>
              <button type="button" onClick={() => setConfirming(false)} className="text-sm text-gray-500 hover:underline dark:text-gray-400">Cancel</button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={recover.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Play size={15} /> Recover {targets.length} tenant(s)
            </button>
          )
        )}
      </div>

      {preview.isError && <ErrorPanel error={extractOperatorError(preview.error)} severity="error" onRetry={runPreview} />}
      {recover.isError && <ErrorPanel error={extractOperatorError(recover.error)} severity="error" />}

      {/* preview target set */}
      {preview.data && !recover.data && (
        targets.length === 0 ? (
          <p className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
            No lost tenants to recover — every tenant with a bundle {scope === 'missing' ? 'has a live namespace.' : 'is accounted for.'}
          </p>
        ) : (
          <TargetTable rows={targets} />
        )
      )}

      {/* execution results */}
      {summary && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium text-gray-900 dark:text-gray-100">
              Recovered {summary.recovered}/{summary.total}
            </span>
            {summary.failed > 0 && <span className="text-red-600 dark:text-red-400">{summary.failed} failed</span>}
          </div>
          <ResultTable rows={results} />
        </div>
      )}
    </div>
  );
}

function TargetTable({ rows }: { rows: readonly DrRecoverAllTarget[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
            <th className="px-3 py-2">Tenant</th><th className="px-3 py-2">Bundle</th><th className="px-3 py-2">Namespace</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.tenantId} className="border-b border-gray-100 dark:border-gray-700/50">
              <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{t.tenantName ?? <span className="font-mono text-xs">{t.tenantId.slice(0, 8)}…</span>}</td>
              <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{t.bundleId.slice(0, 16)}…</td>
              <td className="px-3 py-2">
                {t.namespacePresent
                  ? <span className="text-amber-700 dark:text-amber-300">present (live)</span>
                  : <span className="text-gray-500 dark:text-gray-400">absent (lost)</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultTable({ rows }: { rows: readonly DrRecoverAllResult[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
            <th className="px-3 py-2">Tenant</th><th className="px-3 py-2">Result</th><th className="px-3 py-2">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tenantId} className="border-b border-gray-100 dark:border-gray-700/50">
              <td className="px-3 py-2 text-gray-900 dark:text-gray-100">{r.tenantName ?? <span className="font-mono text-xs">{r.tenantId.slice(0, 8)}…</span>}</td>
              <td className="px-3 py-2">
                {r.ok && r.status === 'done'
                  ? <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={14} /> recovered{r.recreated ? ' (re-created)' : ''}</span>
                  : <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400"><XCircle size={14} /> {r.status ?? 'failed'}</span>}
              </td>
              <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400" title={r.error ?? undefined}>{r.error ? r.error.slice(0, 80) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
