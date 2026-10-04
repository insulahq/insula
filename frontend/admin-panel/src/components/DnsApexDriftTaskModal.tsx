import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RouteDnsDomainResult } from '@insula/api-contracts';
import { DriftRecordLine } from '@/components/dns-drift/DriftRecordLine';
import { DNS_APEX_DRIFT_QUERY_KEY } from '@/hooks/use-dns-apex-drift';
import { X, Loader2, CheckCircle2, AlertTriangle, Circle } from 'lucide-react';
import { useTaskCenter } from '@/hooks/use-task-center';
import type { TaskRow } from '@insula/api-contracts';

/**
 * Progress and results of a route ("apex") DNS repair.
 *
 * Reads state from `useTaskCenter()` (already polled every 3 s while anything
 * is running) and filters to this task. Also reachable by clicking the
 * task-center chip — the task's target is
 * `{ type: 'modal', modal: 'dns-apex-drift-fix' }`, so closing the modal does
 * not abandon the operation.
 *
 * The per-domain checklist comes from `details.steps[]`, written by the
 * backend as each domain is processed. A failed domain keeps its `note` (the
 * provider's error) so a partial run says exactly which zone refused and why,
 * rather than a single opaque "failed". `details.results[]` lists, per domain,
 * every address added and removed with the server it belongs to.
 */

interface Props {
  readonly taskId: string;
  readonly onClose: () => void;
}

interface ProgressStep {
  readonly name: string;
  readonly state: 'pending' | 'running' | 'done' | 'failed';
  readonly note?: string;
}

export default function DnsApexDriftTaskModal({ taskId, onClose }: Props) {
  const { data, isLoading, isError } = useTaskCenter();
  const [dismissed, setDismissed] = useState(false);

  const task: TaskRow | undefined = useMemo(() => {
    const tasks = data?.data?.tasks ?? [];
    return tasks.find((t) => t.id === taskId);
  }, [data, taskId]);

  if (dismissed) return null;

  const handleClose = () => {
    setDismissed(true);
    onClose();
  };

  const details = task?.details as { steps?: ProgressStep[]; results?: RouteDnsDomainResult[] } | undefined;
  const steps = details?.steps ?? [];
  const results = details?.results ?? [];
  const isTerminal = task?.status === 'succeeded' || task?.status === 'failed';
  const added = results.reduce((n, r) => n + r.added.length, 0);
  const removed = results.reduce((n, r) => n + r.removed.length, 0);

  // The backend rescans when the repair ends; pick that report up, and the
  // domains' DNS record lists the repair changed.
  const qc = useQueryClient();
  useEffect(() => {
    if (!isTerminal) return;
    void qc.invalidateQueries({ queryKey: DNS_APEX_DRIFT_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: ['dns-records'] });
  }, [isTerminal, qc]);

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dns-apex-drift-task-title"
      data-testid="dns-apex-drift-task-modal"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3 dark:border-gray-700">
          <h3
            id="dns-apex-drift-task-title"
            className="text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            {task?.label ?? 'Repair route DNS records'}
          </h3>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
            data-testid="dns-apex-drift-task-close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          {isLoading && !task && (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" /> Loading task state…
            </div>
          )}

          {isError && (
            <div className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                Could not read task state. The repair may still be running — check the task-center
                chip.
              </span>
            </div>
          )}

          {task && (
            <>
              <div>
                <div className="mb-1 flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
                  <span>{task.progressText ?? ''}</span>
                  <span>{task.progressPct ?? 0}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                  <div
                    className={`h-full transition-all ${task.status === 'failed' ? 'bg-red-500' : 'bg-brand-500'}`}
                    style={{ width: `${task.progressPct ?? 0}%` }}
                  />
                </div>
              </div>

              {steps.length > 0 && (
                <ul className="max-h-64 space-y-1 overflow-y-auto" data-testid="dns-apex-drift-task-steps">
                  {steps.map((s) => (
                    <li
                      key={s.name}
                      className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300"
                    >
                      <StepIcon state={s.state} />
                      <div className="min-w-0 flex-1">
                        <span className={s.state === 'failed' ? 'text-red-600 dark:text-red-400' : ''}>
                          {s.name}
                        </span>
                        {s.note && (
                          <p className="text-xs text-gray-500 dark:text-gray-400">{s.note}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {results.some((r) => r.added.length + r.removed.length + r.failures.length > 0) && (
                <section data-testid="dns-apex-drift-task-results">
                  <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Changes</h4>
                  <ul className="space-y-2">
                    {results.map((r) => (
                      <li key={r.domainId} className="rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-700" data-testid={`dns-apex-drift-result-${r.domainName}`}>
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{r.domainName}</div>
                        <ul className="mt-1 space-y-0.5">
                          {r.added.map((c) => (
                            <DriftRecordLine key={`+${c.hostname}${c.type}${c.content}`} kind="add" type={c.type} content={`${c.content} at ${c.hostname}`} servers={c.servers} testId="dns-apex-drift-result-added" />
                          ))}
                          {r.removed.map((c) => (
                            <DriftRecordLine key={`-${c.hostname}${c.type}${c.content}`} kind="remove" type={c.type} content={`${c.content} at ${c.hostname}`} servers={c.servers} reason={c.reason} testId="dns-apex-drift-result-removed" />
                          ))}
                        </ul>
                        {r.failures.map((f) => (
                          <p key={`${f.hostname}${f.detail}`} className="mt-1 text-xs text-red-600 dark:text-red-400">{f.hostname}: {f.detail}</p>
                        ))}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {isTerminal && task.errorMessage && (
                <div className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>{task.errorMessage}</span>
                </div>
              )}

              {task.status === 'succeeded' && (
                <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-700 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300">
                  <CheckCircle2 size={14} /> Repair complete: {added} record{added === 1 ? '' : 's'} added, {removed} removed.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StepIcon({ state }: { readonly state: ProgressStep['state'] }) {
  if (state === 'done') return <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-green-500" />;
  if (state === 'failed') return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" />;
  if (state === 'running') return <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-brand-500" />;
  return <Circle size={14} className="mt-0.5 shrink-0 text-gray-300 dark:text-gray-600" />;
}
