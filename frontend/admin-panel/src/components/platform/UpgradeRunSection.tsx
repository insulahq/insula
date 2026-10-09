import { useState, type ReactElement } from 'react';
import { CheckCircle, Loader2, AlertTriangle, Clock, MinusCircle, XCircle } from 'lucide-react';
import type { UpgradeRun } from '@insula/api-contracts';
import { useCancelUpgradeRun } from '@/hooks/use-platform-upgrade';
import NodeName from '@/components/nodes/NodeName';

/**
 * ADR-064 — the three steps of an upgrade run and where each node stands.
 * Rendered inside the progress modal; the services' own roll (per-Deployment
 * rows, convergence gates) stays where it was.
 */

type RunNode = UpgradeRun['nodes'][number];

const STEPS = [
  { id: 'prepare-nodes', label: 'Update the nodes' },
  { id: 'update-services', label: 'Roll the services' },
  { id: 'finish', label: 'Finish host changes' },
] as const;
const ORDER = ['prepare-nodes', 'update-services', 'finish', 'done'] as const;

const NODE_STATE: Record<RunNode['state'], { text: string; cls: string; icon: ReactElement }> = {
  queued: { text: 'Queued', cls: 'text-gray-600 dark:text-gray-300', icon: <Clock size={13} className="text-gray-500 dark:text-gray-400" /> },
  updating: { text: 'Updating', cls: 'text-blue-600 dark:text-blue-400', icon: <Loader2 size={13} className="animate-spin text-blue-500" /> },
  ready: { text: 'Ready', cls: 'text-green-700 dark:text-green-400', icon: <CheckCircle size={13} className="text-green-600 dark:text-green-400" /> },
  waiting: { text: 'Waiting for node', cls: 'text-amber-700 dark:text-amber-300', icon: <AlertTriangle size={13} className="text-amber-500" /> },
  excluded: { text: 'Upgraded without', cls: 'text-gray-600 dark:text-gray-300', icon: <MinusCircle size={13} className="text-gray-500 dark:text-gray-400" /> },
  failed: { text: 'Failed', cls: 'text-red-600 dark:text-red-400', icon: <XCircle size={13} className="text-red-500" /> },
};

/** Pure: overall percent of a run. The services' third follows their live roll. */
export function runPercent(run: UpgradeRun, servicesPercent: number | null): number {
  if (run.status === 'succeeded') return 100;
  const included = run.nodes.filter((n) => n.state !== 'excluded');
  const share = included.length > 0 ? included.filter((n) => n.state === 'ready').length / included.length : 0;
  if (run.step === 'prepare-nodes') return Math.round(share * 33);
  if (run.step === 'update-services') return 33 + Math.round((servicesPercent ?? 0) / 3);
  if (run.step === 'finish') return 67 + Math.round(share * 33);
  return 100;
}

/** Pure: the one-line status of a run. */
export function runStatusLine(run: UpgradeRun, target: string): string {
  if (run.status === 'succeeded') return `Done — the services and every node run ${target}.`;
  if (run.status === 'cancelled') return run.message ?? 'Cancelled before the services changed.';
  if (run.status === 'rolled-back') return run.message ?? 'Rolled back.';
  if (run.status === 'failed') return run.message ?? 'The upgrade stopped.';
  const included = run.nodes.filter((n) => n.state !== 'excluded');
  const ready = included.filter((n) => n.state === 'ready').length;
  if (run.step === 'prepare-nodes') {
    return `Updating the nodes to ${target} (${ready}/${included.length}) — the services keep running the current release.`;
  }
  if (run.step === 'update-services') return `Rolling the services to ${target}…`;
  return `Finishing host changes on the nodes (${ready}/${included.length})…`;
}

export default function UpgradeRunSection({ run }: { readonly run: UpgradeRun }) {
  const cancel = useCancelUpgradeRun();
  const [confirming, setConfirming] = useState(false);
  const at = ORDER.indexOf(run.step);
  const cancelError = cancel.error as Error | null;

  return (
    <div className="space-y-3" data-testid="upgrade-run">
      <ol className="space-y-1">
        {STEPS.map((s, i) => {
          const isDone = run.status === 'succeeded' || i < at;
          const isCurrent = i === at && run.status === 'running';
          const isFailed = i === at && run.status === 'failed';
          const isStopped = i === at && (run.status === 'cancelled' || run.status === 'rolled-back');
          return (
            <li key={s.id} className="flex items-center gap-2 text-sm" data-testid={`run-step-${s.id}`}>
              {isDone ? <CheckCircle size={14} className="text-green-600 dark:text-green-400" />
                : isCurrent ? <Loader2 size={14} className="animate-spin text-blue-500" />
                  : isFailed ? <XCircle size={14} className="text-red-500" />
                    : isStopped ? <MinusCircle size={14} className="text-gray-500 dark:text-gray-400" />
                      : <Clock size={14} className="text-gray-400 dark:text-gray-500" />}
              <span className={isCurrent ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-400'}>
                {i + 1}. {s.label}
              </span>
            </li>
          );
        })}
      </ol>

      {run.nodes.length > 0 && (
        <ul className="space-y-1.5 rounded-md border border-gray-200 p-2 dark:border-gray-700">
          {run.nodes.map((n) => {
            const st = NODE_STATE[n.state];
            return (
              <li key={n.node} className="text-sm" data-testid={`run-node-${n.node}`}>
                <div className="flex items-center justify-between gap-2">
                  <NodeName name={n.node} className="font-mono text-gray-800 dark:text-gray-200" />
                  <span className="flex items-center gap-1.5 text-xs">
                    {st.icon}
                    <span className={`font-medium ${st.cls}`} data-testid={`run-node-${n.node}-state`}>{st.text}</span>
                    {n.cliVersion && <span className="font-mono text-gray-400 dark:text-gray-500">CLI {n.cliVersion}</span>}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{n.detail}</p>
              </li>
            );
          })}
        </ul>
      )}

      {run.status === 'running' && run.step === 'prepare-nodes' && (
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
          {cancelError && <span className="mr-auto text-red-700 dark:text-red-400">{cancelError.message}</span>}
          {confirming ? (
            <>
              <span className="text-gray-600 dark:text-gray-300">Stop the upgrade? The services keep running the current release.</span>
              <button type="button" onClick={() => setConfirming(false)} className="rounded px-2 py-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">Keep going</button>
              <button
                type="button"
                data-testid="cancel-upgrade-confirm"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(undefined, { onSettled: () => setConfirming(false) })}
                className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {cancel.isPending && <Loader2 size={12} className="animate-spin" />} Stop the upgrade
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="cancel-upgrade-btn"
              onClick={() => setConfirming(true)}
              className="rounded border border-gray-300 px-2 py-1 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Cancel upgrade
            </button>
          )}
        </div>
      )}
    </div>
  );
}
