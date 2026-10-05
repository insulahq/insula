/**
 * Recover All — the batch progress view.
 *
 * Opened by Disaster Recovery → Recover All once the batch starts, and
 * re-opened from the task-center chip (`dr-recover-all` modal key, the
 * `dr.recover-all` task). One row per tenant: waiting, the step it is on,
 * recovered, or why it failed. Each tenant is its own `dr.recover` task under
 * the batch, recovered one after another; closing this leaves the batch
 * running on the server.
 */

import { useEffect } from 'react';
import { CheckCircle2, Circle, LifeBuoy, Loader2, ShieldAlert, X, XCircle } from 'lucide-react';
import {
  drRecoverAllTaskDetailsSchema,
  type DrRecoverAllTaskDetails,
  type DrRecoverAllTenantProgress,
  type OperatorError,
  type TaskStatus,
} from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { useTaskRow } from '@/hooks/use-task-row';

interface Props {
  readonly taskId: string;
  readonly onClose: () => void;
  readonly taskStatus?: TaskStatus;
  readonly taskDetails?: Record<string, unknown> | null;
}

function parseDetails(raw: Record<string, unknown> | null): DrRecoverAllTaskDetails | null {
  if (!raw) return null;
  const parsed = drRecoverAllTaskDetailsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function fallbackError(message: string | null | undefined): OperatorError {
  return {
    code: 'DR_RECOVER_ALL_FAILED',
    title: 'Recover All did not complete',
    detail: message ?? 'The batch stopped before every tenant was recovered.',
    remediation: ['Recover each tenant listed as failed on its own, from Recover Tenant.'],
    retryable: false,
  };
}

function TenantState({ row }: { readonly row: DrRecoverAllTenantProgress }) {
  if (row.state === 'running') {
    return <span className="inline-flex items-center gap-1 text-brand-700 dark:text-brand-300"><Loader2 size={14} className="animate-spin" /> recovering</span>;
  }
  if (row.state === 'done') {
    return <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300"><CheckCircle2 size={14} /> recovered{row.recreated ? ' (re-created)' : ''}</span>;
  }
  if (row.state === 'failed') {
    return <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400"><XCircle size={14} /> failed</span>;
  }
  return <span className="inline-flex items-center gap-1 text-gray-400 dark:text-gray-500"><Circle size={14} /> waiting</span>;
}

function TenantRows({ rows }: { readonly rows: readonly DrRecoverAllTenantProgress[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="w-full text-sm" data-testid="dr-recover-all-rows">
        <thead className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
          <tr className="border-b border-gray-200 dark:border-gray-700">
            <th className="px-3 py-2">Tenant</th><th className="px-3 py-2">State</th><th className="px-3 py-2">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tenantId} className="border-b border-gray-100 dark:border-gray-700/50" data-testid={`dr-recover-all-row-${r.tenantId}`}>
              <td className="px-3 py-2 text-gray-900 dark:text-gray-100">
                {r.tenantName ?? <span className="font-mono text-xs">{r.tenantId.slice(0, 8)}…</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-2"><TenantState row={r} /></td>
              <td className={`px-3 py-2 text-xs ${r.state === 'failed' ? 'text-red-700 dark:text-red-300' : 'text-gray-500 dark:text-gray-400'}`}>
                {r.state === 'running' ? (r.step ?? 'Starting…') : r.error ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function DrRecoverAllProgressModal({ taskId, onClose, taskStatus, taskDetails }: Props) {
  const { task, status, details: rawDetails, running } = useTaskRow(taskId, { taskStatus, taskDetails });
  const details = parseDetails(rawDetails);
  const failed = status === 'failed' || status === 'cancelled';
  const succeeded = status === 'succeeded';
  const pct = Math.min(100, Math.max(0, succeeded ? 100 : task?.progressPct ?? 0));
  const notRecovered = (details?.skipped ?? []).filter((s) => s.reason !== 'namespace_present');

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="dr-recover-all-title">
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800"
        data-testid="dr-recover-all-modal"
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-3 dark:border-gray-700">
          <h2 id="dr-recover-all-title" className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <LifeBuoy size={18} className="text-brand-600 dark:text-brand-400" /> Recovering lost tenants
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="text-gray-700 dark:text-gray-300" data-testid="dr-recover-all-msg">
                {details
                  ? `${details.recovered + details.failed} of ${details.total} tenants${details.failed > 0 ? ` · ${details.failed} failed` : ''}`
                  : 'Starting…'}
              </span>
              <span className="font-mono text-xs tabular-nums text-gray-500 dark:text-gray-400">{pct}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className={`h-full rounded-full transition-all ${failed ? 'bg-red-500 dark:bg-red-400' : succeeded ? 'bg-green-500 dark:bg-green-400' : 'bg-brand-500 dark:bg-brand-400'}`}
                style={{ width: `${pct}%` }}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
          </div>

          {details?.encryptionKey?.verdict === 'mismatch' && (
            <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200" data-testid="dr-recover-all-key-override">
              <ShieldAlert size={14} className="mt-0.5 flex-shrink-0" />
              Started despite an encryption-key mismatch — every credential this cluster could not decrypt must be re-entered by hand.
            </p>
          )}

          {details && details.tenants.length > 0 && <TenantRows rows={details.tenants} />}

          {succeeded && details && (
            <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm font-medium text-green-800 dark:border-green-800/60 dark:bg-green-900/20 dark:text-green-300" data-testid="dr-recover-all-done">
              <CheckCircle2 size={16} className="flex-shrink-0" /> Recovered {details.recovered} of {details.total} tenants.
            </div>
          )}
          {failed && <ErrorPanel error={details?.error ?? fallbackError(task?.errorMessage)} testId="dr-recover-all-failed" />}

          {notRecovered.length > 0 && (
            <div className="rounded-lg border border-gray-200 p-3 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300" data-testid="dr-recover-all-skipped">
              <p className="font-medium text-gray-800 dark:text-gray-200">Not part of this run</p>
              <ul className="mt-1 space-y-0.5">
                {notRecovered.map((s) => (
                  <li key={s.tenantId}>
                    {s.tenantName ?? s.tenantId.slice(0, 8)} —{' '}
                    {s.reason === 'deleted' ? 'deleted on purpose (recover it from Recover Tenant)' : `no completed bundle${s.latestBundleStatus ? ` (newest is ${s.latestBundleStatus})` : ''}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end border-t border-gray-100 px-5 py-3 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            data-testid="dr-recover-all-close"
          >
            {running ? 'Run in background' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}
