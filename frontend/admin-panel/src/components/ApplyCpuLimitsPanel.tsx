/**
 * Apply a tenant's saved CPU settings to its namespace.
 *
 * ★ Saving and applying are different acts, on purpose.
 *
 * A changed burst ceiling replaces every pod in the namespace — a
 * LimitRange stamps its default at ADMISSION, so nothing already running
 * picks up a new ceiling. That must not happen as a side effect of pressing
 * Save on a form that also edits memory, storage and mailbox counts. So the
 * form writes the value and this applies it, and the panel says which of
 * the two it is about to do.
 *
 * A changed TIER, by contrast, replaces nothing: it rewrites the
 * LimitRange's default request and the deployments' own requests, which
 * roll the normal way.
 *
 * Only for a tenant already on the tier model. A legacy tenant is not
 * "pending" — it is un-migrated, which is a different act with a different
 * button, on Cluster → CPU Scheduling.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Cpu, Loader2 } from 'lucide-react';
import { useCpuMigrationPreview } from '@/hooks/use-cpu-migration';
import { useApplyCpuMigration } from '@/hooks/use-cpu-migration-actions';

const TIER_LABEL: Record<'normal' | 'high' | 'highest', string> = {
  normal: 'Normal', high: 'High', highest: 'Highest',
};

export default function ApplyCpuLimitsPanel({
  tenantId,
  schedulingMode,
}: {
  readonly tenantId: string;
  readonly schedulingMode: string | null | undefined;
}) {
  const { data } = useCpuMigrationPreview();
  const apply = useApplyCpuMigration();
  const [acknowledged, setAcknowledged] = useState(false);

  if (schedulingMode !== 'tiered') return null;

  const t = data?.data.tenants.find((x) => x.tenantId === tenantId);
  // Server-side truth, so the button is right after a reload or for a
  // second admin — not just in the tab that pressed it.
  const running = t?.migrationRunning || apply.isPending;
  const pending = t?.pendingCpuChange ?? false;
  const needsReview = t ? !t.migratesCleanly : false;
  const ceilingMoves = t != null && t.appliedCeilingCores !== t.proposedCeilingCores;

  const run = apply.data?.data;
  const outcome = run
    ? {
      bad: run.status !== 'completed',
      text: run.status === 'completed'
        ? 'Applied — this namespace now matches its saved CPU settings'
        : `${run.status}: ${run.reason ?? run.step ?? 'see the task list'}`,
    }
    : apply.isError
      ? { bad: true, text: apply.error instanceof Error ? apply.error.message : 'The request failed.' }
      : null;

  return (
    <div
      className="mt-4 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
      data-testid="apply-cpu-limits"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Cpu size={16} className="shrink-0 text-gray-400 dark:text-gray-500" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {pending ? 'CPU settings not yet applied' : 'CPU settings are applied'}
          </div>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400" data-testid="apply-cpu-limits-detail">
            {!t ? (
              'Reading what this namespace enforces…'
            ) : pending ? (
              <>
                Saved: <span className="font-medium">{TIER_LABEL[t.proposedTier]}</span> share,{' '}
                <span className="font-medium">{t.proposedCeilingCores.toFixed(2)}</span> core ceiling.
                {' '}Running: <span className="font-medium">{t.appliedTier ? TIER_LABEL[t.appliedTier] : 'unknown'}</span>{' '}
                share, <span className="font-medium">{t.appliedCeilingCores?.toFixed(2) ?? '—'}</span>.
                {ceilingMoves
                  ? ' Applying replaces this tenant’s applications, one at a time.'
                  : ' Applying replaces no running application.'}
              </>
            ) : (
              <>
                <span className="font-medium">{TIER_LABEL[t.proposedTier]}</span> share, bursting to{' '}
                <span className="font-medium">{t.proposedCeilingCores.toFixed(2)}</span> cores. Re-applying
                is safe and changes nothing.
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          disabled={running || (needsReview && !acknowledged)}
          onClick={() => apply.mutate({ tenantId, acknowledgeBlockers: acknowledged })}
          data-testid="apply-cpu-limits-button"
          className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50 ${
            pending
              ? 'bg-brand-600 text-white hover:bg-brand-700 dark:bg-brand-500 dark:hover:bg-brand-600'
              : 'border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700/50'
          }`}
        >
          {running ? (
            <span className="flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> Applying…</span>
          ) : 'Apply new limits'}
        </button>
      </div>

      {/* ★ The flag must BIND the button. The server refuses a flagged
          tenant without an acknowledgement (409), so a caption beside a
          still-clickable button would just produce an error the operator
          cannot get past. */}
      {needsReview && (
        <label className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            data-testid="apply-cpu-limits-ack"
            className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
          />
          This tenant needs review —{' '}
          <Link to="/cluster/cpu-scheduling" className="underline">see why</Link>
          {' '}— apply anyway
        </label>
      )}

      {outcome && (
        <p
          data-testid="apply-cpu-limits-outcome"
          className={`mt-2 text-xs ${outcome.bad ? 'text-red-600 dark:text-red-400' : 'text-teal-700 dark:text-teal-300'}`}
        >
          {outcome.text}
        </p>
      )}
    </div>
  );
}
