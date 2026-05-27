import { useMemo, useState } from 'react';
import { Loader2, RefreshCw, RotateCw, Zap } from 'lucide-react';
import {
  useLifecycleTransitions,
  useRetryHookRun,
  useResetHookBreaker,
  summariseHookStats,
  type LifecycleHookRunRow,
  type LifecycleTransitionRow,
} from '@/hooks/use-lifecycle';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

const STATE_BADGE: Record<LifecycleHookRunRow['state'], string> = {
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  noop: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

const TRANSITION_BADGE: Record<LifecycleTransitionRow['state'], string> = {
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  failed_partial: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  failed_blocking: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

export default function LifecycleHooksSettings() {
  const [refresh, setRefresh] = useState(0);
  const list = useLifecycleTransitions({ limit: 50, refetchInterval: refresh > 0 ? 5000 : undefined });
  const retry = useRetryHookRun();
  const reset = useResetHookBreaker();
  const stats = useMemo(() => summariseHookStats(list.data?.data), [list.data]);

  const onRetry = async (runId: string): Promise<void> => {
    try { await retry.mutateAsync(runId); } catch { /* surfaced */ }
  };
  const onResetBreaker = async (hookName: string): Promise<void> => {
    try { await reset.mutateAsync(hookName); } catch { /* surfaced */ }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Lifecycle Hooks</h1>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              checked={refresh > 0}
              onChange={(e) => setRefresh(e.target.checked ? Date.now() : 0)}
              className="rounded"
            />
            Auto-refresh (5s)
          </label>
          <button
            type="button"
            onClick={() => list.refetch()}
            disabled={list.isFetching}
            className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700"
          >
            {list.isFetching ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Refresh
          </button>
        </div>
      </div>

      {list.error && (
        <ErrorPanel error={extractOperatorError(list.error)} severity="error" testId="lifecycle-hooks-list-error" />
      )}

      {/* ─── Per-hook stats ─────────────────────────────────────────── */}
      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="border-b border-gray-200 px-4 py-2 dark:border-gray-700">
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">Hook Performance (last {list.data?.data.transitions.length ?? 0} transitions)</h2>
        </div>
        <table className="w-full text-xs">
          <thead className="text-gray-500 dark:text-gray-400">
            <tr className="border-b border-gray-200/60 dark:border-gray-700/40">
              <th className="text-left px-4 py-2">Hook</th>
              <th className="text-right px-4 py-2">Total</th>
              <th className="text-right px-4 py-2">OK</th>
              <th className="text-right px-4 py-2">Failed</th>
              <th className="text-right px-4 py-2">Success</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {stats.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-3 text-center text-gray-500">No hook runs in the loaded window.</td></tr>
            )}
            {stats.map((s) => (
              <tr key={s.hookName} className="border-t border-gray-200/60 dark:border-gray-700/40">
                <td className="px-4 py-2 font-mono text-gray-900 dark:text-gray-100">{s.hookName}</td>
                <td className="px-4 py-2 text-right tabular-nums">{s.total}</td>
                <td className="px-4 py-2 text-right tabular-nums text-green-700 dark:text-green-300">{s.ok}</td>
                <td className="px-4 py-2 text-right tabular-nums text-red-700 dark:text-red-300">{s.failed}</td>
                <td className={`px-4 py-2 text-right tabular-nums font-medium ${s.successRatePct < 90 ? 'text-amber-700 dark:text-amber-300' : 'text-gray-700 dark:text-gray-200'}`}>
                  {s.successRatePct}%
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => onResetBreaker(s.hookName)}
                    disabled={reset.isPending}
                    className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-[11px] hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700"
                    title="Clear circuit breaker for this hook"
                  >
                    <Zap size={10} /> Reset breaker
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ─── Recent transitions with per-hook detail ────────────────── */}
      <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="border-b border-gray-200 px-4 py-2 dark:border-gray-700">
          <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">Recent Transitions</h2>
        </div>
        <div className="divide-y divide-gray-200 dark:divide-gray-700">
          {(list.data?.data.transitions ?? []).map((t) => {
            const runs = list.data?.data.hookRuns[t.id] ?? [];
            return (
              <details key={t.id} className="group">
                <summary className="flex cursor-pointer items-center gap-3 px-4 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-700/40">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${TRANSITION_BADGE[t.state]}`}>{t.state}</span>
                  <span className="font-mono text-gray-700 dark:text-gray-200">{t.transitionKind}</span>
                  <span className="text-gray-500 dark:text-gray-400">tenant {t.tenantId.slice(0, 8)}…</span>
                  {t.namespace && <span className="text-gray-400 dark:text-gray-500">ns {t.namespace}</span>}
                  <span className="ml-auto text-gray-500 dark:text-gray-400">{new Date(t.startedAt).toLocaleString()}</span>
                  <span className="text-gray-500 dark:text-gray-400">{runs.length} hook{runs.length === 1 ? '' : 's'}</span>
                </summary>
                <div className="bg-gray-50 px-4 py-2 dark:bg-gray-900/30">
                  <table className="w-full text-xs">
                    <thead className="text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="text-left py-1">#</th>
                        <th className="text-left py-1">Hook</th>
                        <th className="text-left py-1">Blocking</th>
                        <th className="text-right py-1">Attempts</th>
                        <th className="text-left py-1">State</th>
                        <th className="text-right py-1">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.sort((a, b) => a.hookOrder - b.hookOrder).map((r) => (
                        <tr key={r.id} className="border-t border-gray-200/60 dark:border-gray-700/40">
                          <td className="py-1 tabular-nums text-gray-500">{r.hookOrder}</td>
                          <td className="py-1 font-mono">{r.hookName}</td>
                          <td className="py-1 text-gray-500">{r.blocking}</td>
                          <td className="py-1 text-right tabular-nums">{r.attempts}/{r.maxAttempts}</td>
                          <td className="py-1">
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATE_BADGE[r.state]}`}>{r.state}</span>
                          </td>
                          <td className="py-1 text-right">
                            {r.state === 'failed' && (
                              <button
                                type="button"
                                onClick={() => onRetry(r.id)}
                                disabled={retry.isPending}
                                className="inline-flex items-center gap-1 rounded bg-blue-600 px-2 py-0.5 text-[10px] text-white hover:bg-blue-700 disabled:opacity-50"
                              >
                                <RotateCw size={10} /> Retry
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                      {runs.some((r) => r.state === 'failed' && r.lastError) && (
                        <tr>
                          <td colSpan={6} className="pt-2">
                            {runs.filter((r) => r.state === 'failed' && r.lastError).map((r) => {
                              const env = r.lastError;
                              return (
                                <div key={r.id} className="mb-2 rounded border border-red-300 bg-red-50 p-2 dark:border-red-700/60 dark:bg-red-900/30">
                                  <div className="font-medium text-red-800 dark:text-red-200">
                                    {r.hookName}: {env?.title ?? 'failure'}
                                  </div>
                                  {env?.detail && <div className="mt-0.5 text-red-700 dark:text-red-300">{env.detail}</div>}
                                  {env?.remediation && env.remediation.length > 0 && (
                                    <ul className="mt-1 list-disc pl-4 text-[11px] text-red-700 dark:text-red-300">
                                      {env.remediation.map((step, i) => <li key={i}>{step}</li>)}
                                    </ul>
                                  )}
                                  {env?.raw && (
                                    <details className="mt-1">
                                      <summary className="cursor-pointer text-[11px] text-red-600 dark:text-red-400">raw</summary>
                                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[10px] text-red-800 dark:text-red-300">{env.raw}</pre>
                                    </details>
                                  )}
                                </div>
                              );
                            })}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </details>
            );
          })}
        </div>
      </section>
    </div>
  );
}
