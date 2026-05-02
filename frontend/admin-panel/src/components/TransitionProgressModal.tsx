import { useEffect, useMemo, useState } from 'react';
import { X, Loader2, CheckCircle, AlertTriangle, RotateCw } from 'lucide-react';
import {
  useClientLifecycleTransitions,
  useRetryHookRun,
  type LifecycleTransitionRow,
  type LifecycleHookRunRow,
} from '@/hooks/use-lifecycle';

interface Props {
  readonly clientId: string;
  /** Transition kind to follow (active|suspended|archived|restored|deleted).
   *  Modal latches onto the most-recent transition of that kind started
   *  AFTER `since` so concurrent transitions don't bleed into the view. */
  readonly transition: LifecycleTransitionRow['transitionKind'];
  /** Time the operator triggered the operation (ms epoch). */
  readonly since: number;
  readonly onClose: () => void;
}

const STATE_BADGE: Record<LifecycleHookRunRow['state'], string> = {
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  noop: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

const TRANSITION_BADGE: Record<LifecycleTransitionRow['state'], { label: string; cls: string; icon: typeof Loader2 }> = {
  running: { label: 'Running', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300', icon: Loader2 },
  completed: { label: 'Completed', cls: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300', icon: CheckCircle },
  failed_partial: { label: 'Completed with retries', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300', icon: AlertTriangle },
  failed_blocking: { label: 'Failed', cls: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300', icon: AlertTriangle },
};

export default function TransitionProgressModal({ clientId, transition, since, onClose }: Props) {
  // Polling stops once we've seen the transition + all hook_runs reach
  // a terminal+drained state. Pass through to TanStack via the `paused`
  // arg so the actual HTTP requests stop, not just the visual badge.
  const [paused, setPaused] = useState(false);
  const data = useClientLifecycleTransitions(clientId, 1500, paused);
  const retry = useRetryHookRun();

  // Pick the matching transition: same kind, started AFTER `since`.
  const tx = useMemo<LifecycleTransitionRow | null>(() => {
    const rows = data.data?.data.transitions ?? [];
    const candidates = rows.filter((r) => r.transitionKind === transition
      && new Date(r.startedAt).getTime() >= since - 5000);
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
  }, [data.data, transition, since]);

  // Memoise so the effect's dep array doesn't churn on every render.
  const runs = useMemo<LifecycleHookRunRow[]>(() => {
    if (!tx) return [];
    return data.data?.data.hookRuns[tx.id] ?? [];
  }, [tx, data.data]);

  useEffect(() => {
    if (!tx) return;
    const stillActive = tx.state === 'running'
      || runs.some((r) => r.state === 'pending' || r.state === 'running' || r.state === 'failed');
    if (!stillActive) setPaused(true);
  }, [tx, runs]);

  const onRetry = (runId: string): void => {
    retry.mutate(runId);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      role="dialog"
      aria-modal="true"
      data-testid="transition-progress-modal"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-xl bg-white shadow-xl dark:bg-gray-800 max-h-[calc(100vh-4rem)] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Lifecycle: <span className="font-mono">{transition}</span>
            </h2>
            {tx && (() => {
              const b = TRANSITION_BADGE[tx.state];
              const Icon = b.icon;
              return (
                <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${b.cls}`}>
                  <Icon size={12} className={tx.state === 'running' ? 'animate-spin' : ''} /> {b.label}
                </span>
              );
            })()}
            {paused && (
              <span className="text-xs text-gray-500 dark:text-gray-400">(polling stopped)</span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4 text-sm">
          {!tx && data.isLoading && (
            <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" /> Waiting for transition row…
            </div>
          )}

          {!tx && !data.isLoading && (
            <div className="text-gray-500 dark:text-gray-400">
              No matching transition started since {new Date(since).toLocaleTimeString()}.
              The dispatcher may have failed to write the row — check platform-api logs.
            </div>
          )}

          {tx && runs.length === 0 && (
            <div className="text-gray-500 dark:text-gray-400">
              No hook_runs recorded for this transition yet.
            </div>
          )}

          {tx && runs.length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="text-left py-1">#</th>
                  <th className="text-left py-1">Hook</th>
                  <th className="text-left py-1">Blocking</th>
                  <th className="text-right py-1">Attempts</th>
                  <th className="text-left py-1">State</th>
                  <th className="text-right py-1">Action</th>
                </tr>
              </thead>
              <tbody>
                {runs.sort((a, b) => a.hookOrder - b.hookOrder).map((r) => (
                  <tr key={r.id} className="border-t border-gray-200/60 dark:border-gray-700/40">
                    <td className="py-1 tabular-nums text-gray-500">{r.hookOrder}</td>
                    <td className="py-1 font-mono text-gray-900 dark:text-gray-100">{r.hookName}</td>
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
              </tbody>
            </table>
          )}

          {tx && runs.filter((r) => r.state === 'failed' && r.lastError).map((r) => {
            const env = r.lastError!;
            return (
              <div key={r.id} className="rounded border border-red-300 bg-red-50 p-2 text-xs dark:border-red-700/60 dark:bg-red-900/30">
                <div className="font-medium text-red-800 dark:text-red-200">{r.hookName}: {env.title ?? 'failure'}</div>
                {env.detail && <div className="mt-0.5 text-red-700 dark:text-red-300">{env.detail}</div>}
                {env.remediation && env.remediation.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-[11px] text-red-700 dark:text-red-300">
                    {env.remediation.map((step, i) => <li key={i}>{step}</li>)}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
