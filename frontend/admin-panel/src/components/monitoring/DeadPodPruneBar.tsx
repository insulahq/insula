import { useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import {
  usePodPrunePolicy,
  useSetPodPrunePolicy,
  usePrunePods,
} from '@/hooks/use-pod-prune';
import { MAX_AUTO_PRUNE_DAYS } from '@insula/api-contracts';

/**
 * Dead-pod housekeeping for the Pods tab.
 *
 * A pod in a terminal phase keeps its whole record. Kubernetes garbage-collects
 * terminal pods only past --terminated-pod-gc-threshold (12500 by default), so
 * in practice they accumulate until someone removes them. They hold no CPU,
 * memory or scheduling capacity — but they do pin their container logs on the
 * node, and anything reading the pod list sees a workload that is not running.
 */
export default function DeadPodPruneBar({ deadCount }: { readonly deadCount: number }) {
  const policy = usePodPrunePolicy();
  const setPolicy = useSetPodPrunePolicy();
  const prune = usePrunePods();

  const stored = policy.data?.data.autoPruneDays;
  const [days, setDays] = useState<string>('');

  // Seed the input once the stored value arrives, without clobbering an edit
  // in progress.
  useEffect(() => {
    if (stored !== undefined && days === '') setDays(String(stored));
  }, [stored, days]);

  const parsed = Number(days);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_AUTO_PRUNE_DAYS;
  const dirty = valid && stored !== undefined && parsed !== stored;

  return (
    <section
      className="rounded-lg border border-gray-200 bg-gray-50/60 p-3 dark:border-gray-700 dark:bg-gray-900/40"
      data-testid="dead-pod-prune-bar"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            Dead pod records
          </h3>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
            {deadCount === 0
              ? 'None right now. Completed and failed pods are kept as a record after the workload stops; Kubernetes does not remove them on its own.'
              : `${deadCount} completed or failed pod${deadCount === 1 ? '' : 's'} still on the cluster. They use no CPU or memory, but they hold their container logs on the node.`}
          </p>
        </div>

        <button
          type="button"
          onClick={() => prune.mutate()}
          disabled={prune.isPending || deadCount === 0}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="prune-dead-pods"
        >
          {prune.isPending ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          {prune.isPending ? 'Pruning…' : 'Prune Dead Pods'}
        </button>

        <div className="flex shrink-0 items-center gap-2">
          <label
            htmlFor="auto-prune-days"
            className="text-xs font-medium text-gray-700 dark:text-gray-300"
          >
            Auto-prune after
          </label>
          <input
            id="auto-prune-days"
            type="number"
            min={0}
            max={MAX_AUTO_PRUNE_DAYS}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            disabled={policy.isLoading}
            className="w-20 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            data-testid="auto-prune-days"
          />
          <span className="text-xs text-gray-600 dark:text-gray-400">days</span>
          {dirty && (
            <button
              type="button"
              onClick={() => setPolicy.mutate(parsed)}
              disabled={setPolicy.isPending}
              className="inline-flex items-center gap-1 rounded-lg bg-brand-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="save-auto-prune"
            >
              {setPolicy.isPending && <Loader2 size={12} className="animate-spin" />}
              Save
            </button>
          )}
        </div>
      </div>

      {/* 0 is a real choice, not an empty field — say what it does. */}
      {valid && parsed === 0 && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400" data-testid="auto-prune-off">
          Automatic pruning is off. Records are kept until you prune them here.
        </p>
      )}
      {days !== '' && !valid && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400" data-testid="auto-prune-invalid">
          Enter a whole number of days between 0 and {MAX_AUTO_PRUNE_DAYS}.
        </p>
      )}

      {prune.data && (
        <p className="mt-2 text-xs text-gray-700 dark:text-gray-300" data-testid="prune-result">
          {prune.data.data.message}
        </p>
      )}
      {prune.isError && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400" data-testid="prune-error">
          {(prune.error as Error).message}
        </p>
      )}
      {setPolicy.isError && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400" data-testid="policy-error">
          {(setPolicy.error as Error).message}
        </p>
      )}
    </section>
  );
}
