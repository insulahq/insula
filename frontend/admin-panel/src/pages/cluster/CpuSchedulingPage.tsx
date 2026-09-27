import { useMemo, useState } from 'react';
import { Loader2, Cpu, ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import type { CpuMigrationBlocker, CpuMigrationTenant, CpuTier } from '@insula/api-contracts';
import { useCpuMigrationPreview } from '@/hooks/use-cpu-migration';
import {
  useApplyCpuMigration, useRevertCpuMigration, useStopCpuMigration,
} from '@/hooks/use-cpu-migration-actions';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

/**
 * Cluster → CPU scheduling (ADR-062 R1).
 *
 * A dry run. Nothing on this page changes anything — the mechanism that would
 * act on it ships separately, and this exists first on purpose: an operator
 * cannot be asked to adopt a scheduling model they have never seen applied to
 * their own numbers.
 *
 * Reachable unconditionally from the nav rather than only from the alert. The
 * alert fires on reserved-full-and-idle, which is right for urgency and wrong
 * for discovery — a cluster wasting four cores at 40% reservation is not in
 * pain yet and would otherwise never find this.
 */

const TIER_LABEL: Record<CpuTier, string> = {
  normal: 'Normal',
  high: 'High',
  highest: 'Highest',
};

/** Why a tenant needs a human, in the operator's words rather than an enum. */
const BLOCKER_TEXT: Record<CpuMigrationBlocker, string> = {
  custom_resources:
    'A custom container pins its own CPU. Those are your numbers, not the platform’s to replace.',
  third_party_catalog:
    'Installed from a catalog repository the platform does not maintain, so its sizing cannot be vouched for.',
  usage_exceeds_ceiling:
    'Measured load already exceeds the burst ceiling this plan would grant. Raise the plan before migrating.',
  no_usage_data:
    'No usage samples in the last 7 days, so whether it fits cannot be answered yet.',
};

const cores = (millis: number): string => (millis / 1000).toFixed(2);

function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'plain' | 'good';
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
      <div className={clsx(
        'mt-1 font-mono text-2xl font-semibold tabular-nums',
        tone === 'good' ? 'text-teal-700 dark:text-teal-300' : 'text-gray-900 dark:text-gray-100',
      )}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{sub}</div>}
    </div>
  );
}

function TenantRow({ t }: { t: CpuMigrationTenant }) {
  const [open, setOpen] = useState(false);
  // Blockers, each attributed to what caused it. A bare "a custom container
  // pins its own CPU" against a tenant with five applications tells an
  // operator the cause but not the subject, which is half an answer.
  const blockers = useMemo(() => {
    const rows: Array<{ key: string; where: string | null; blocker: CpuMigrationBlocker }> = [];
    if (t.tenantBlocker) rows.push({ key: `tenant:${t.tenantBlocker}`, where: null, blocker: t.tenantBlocker });
    for (const d of t.deployments) {
      if (d.blocker) rows.push({ key: `${d.id}:${d.blocker}`, where: d.name, blocker: d.blocker });
    }
    return rows;
  }, [t]);

  return (
    <>
      {/* A <tr> is not natively focusable or activatable, and the reason a
          tenant "needs review" is reachable ONLY by expanding this row — so
          without this a keyboard or screen-reader operator cannot get at it
          at all. */}
      <tr
        className="cursor-pointer border-t border-gray-100 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-gray-700 dark:hover:bg-gray-700/40"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); }
        }}
        tabIndex={0}
        role="button"
        aria-expanded={open}
        aria-label={`${t.tenantName} — ${t.migratesCleanly ? 'migrates cleanly' : 'needs review'}`}
        data-testid={`cpu-migration-tenant-${t.tenantId}`}
      >
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            {open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
            <span className="font-medium text-gray-900 dark:text-gray-100">{t.tenantName}</span>
          </div>
        </td>
        <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{t.planCode ?? '—'}</td>
        <td className="px-3 py-2 text-right font-mono tabular-nums text-gray-600 dark:text-gray-300">{cores(t.currentMillis)}</td>
        <td className="px-3 py-2 text-right font-mono tabular-nums text-gray-900 dark:text-gray-100">{cores(t.proposedMillis)}</td>
        {/* The backend's own figure, not a second computation of it — see
            reclaimableMillis in the contract. An increase is shown as an
            increase rather than collapsing into the same em-dash as "no
            change". */}
        <td className="px-3 py-2 text-right font-mono tabular-nums">
          {t.reclaimableMillis > 0 && (
            <span className="text-teal-700 dark:text-teal-300">−{cores(t.reclaimableMillis)}</span>
          )}
          {t.increasedMillis > 0 && (
            <span className={clsx('text-amber-700 dark:text-amber-400', t.reclaimableMillis > 0 && 'ml-2')}>
              +{cores(t.increasedMillis)}
            </span>
          )}
          {t.reclaimableMillis === 0 && t.increasedMillis === 0 && (
            <span className="text-gray-400 dark:text-gray-500">—</span>
          )}
        </td>
        <td className="px-3 py-2 text-right font-mono tabular-nums text-gray-600 dark:text-gray-300">
          {t.proposedCeilingCores.toFixed(2)}
        </td>
        <td className="px-3 py-2 text-right font-mono tabular-nums text-gray-500 dark:text-gray-400">
          {/* A measured zero is a reading. Only null means unsampled. */}
          {t.observedP95Millis === null ? '—' : cores(t.observedP95Millis)}
        </td>
        <td className="px-3 py-2">
          {t.migratesCleanly
            ? <span className="inline-flex rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-300">migrates cleanly</span>
            : <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">needs review</span>}
        </td>
      </tr>
      {open && (
        <tr className="bg-gray-50 dark:bg-gray-900/40">
          <td colSpan={8} className="px-6 py-3">
            {blockers.length > 0 && (
              <ul className="mb-3 space-y-1">
                {blockers.map((b) => (
                  <li key={b.key} className="text-xs text-amber-700 dark:text-amber-400">
                    • {b.where && <span className="font-medium">{b.where}: </span>}{BLOCKER_TEXT[b.blocker]}
                  </li>
                ))}
              </ul>
            )}
            <table className="w-full text-xs">
              <thead className="text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="py-1 text-left font-medium">Application</th>
                  <th className="py-1 text-right font-medium">Reserves now</th>
                  <th className="py-1 text-right font-medium">Would reserve</th>
                  <th className="py-1 text-left font-medium">Tier</th>
                  <th className="py-1 text-left font-medium">&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {t.deployments.map((d) => (
                  <tr key={d.id} className="border-t border-gray-200 dark:border-gray-700">
                    <td className="py-1 text-gray-800 dark:text-gray-200">{d.name}</td>
                    <td className="py-1 text-right font-mono tabular-nums">{cores(d.currentMillis)}</td>
                    <td className="py-1 text-right font-mono tabular-nums">{cores(d.proposedMillis)}</td>
                    <td className="py-1 text-gray-600 dark:text-gray-300">{TIER_LABEL[d.proposedTier]}</td>
                    <td className="py-1">
                      {d.blocker && (
                        <span className="inline-flex rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                          needs review
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {t.deployments.length === 0 && (
                  <tr><td colSpan={5} className="py-2 text-gray-500 dark:text-gray-400">No running applications.</td></tr>
                )}
              </tbody>
            </table>
            <TenantMigrationActions tenant={t} />
          </td>
        </tr>
      )}
    </>
  );
}


/**
 * The only place anything is applied. One tenant at a time, from inside that
 * tenant's own row — there is no bulk control here and no endpoint behind one,
 * because recreating every tenant's pods from a single click is the flag day
 * ADR-062 exists to avoid.
 */
function TenantMigrationActions({ tenant }: { tenant: CpuMigrationTenant }) {
  const apply = useApplyCpuMigration();
  const revert = useRevertCpuMigration();
  const stop = useStopCpuMigration();
  const [acknowledged, setAcknowledged] = useState(false);
  // Server-side truth, so the controls are right after a reload or for a
  // second admin — not just in the tab that pressed the button.
  const running = tenant.migrationRunning || apply.isPending;
  const busy = running || revert.isPending || stop.isPending;
  const tiered = tenant.schedulingMode === 'tiered';
  const needsReview = !tenant.migratesCleanly;

  // Report the server's own words. A mutation that "succeeded" can still have
  // stopped or failed partway — reading only isError would show a green tick
  // over a migration that gave up at step 4.
  const run = apply.data?.data;
  const reverted = revert.data?.data;
  const outcome = run
    ? { bad: run.status !== 'completed', text: run.status === 'completed'
        ? `Migrated — freed ${(run.freedMillis ?? 0) / 1000} cores`
        : `${run.status}: ${run.reason ?? run.step ?? 'see the task list'}` }
    : reverted
      ? { bad: reverted.status !== 'completed', text: reverted.status === 'completed'
          ? `Reverted ${reverted.restored} application(s)${reverted.unrestorable > 0 ? ` — ${reverted.unrestorable} could not be restored` : ''}`
          : `revert failed: ${reverted.reason ?? 'unknown'}` }
      : apply.isError || revert.isError
        ? { bad: true, text: 'The request failed. Check the task list for detail.' }
        : null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-700">
      {!tiered && (
        <button
          type="button"
          disabled={busy || (needsReview && !acknowledged)}
          onClick={() => apply.mutate({ tenantId: tenant.tenantId, acknowledgeBlockers: acknowledged })}
          data-testid={`cpu-migrate-${tenant.tenantId}`}
          className="rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50 dark:bg-brand-500 dark:hover:bg-brand-600"
        >
          {running ? 'Migrating…' : 'Migrate this tenant'}
        </button>
      )}
      {tiered && (
        <button
          type="button"
          disabled={busy}
          onClick={() => revert.mutate(tenant.tenantId)}
          data-testid={`cpu-revert-${tenant.tenantId}`}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          {revert.isPending ? 'Reverting…' : 'Revert to legacy'}
        </button>
      )}
      {running && (
        <button
          type="button"
          onClick={() => stop.mutate(tenant.tenantId)}
          data-testid={`cpu-stop-${tenant.tenantId}`}
          className="rounded-md border border-amber-400 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 dark:border-amber-500 dark:text-amber-300 dark:hover:bg-amber-900/30"
        >
          Stop after this step
        </button>
      )}
      {/* ★ The flag has to bind the button, not sit beside it. The server
          refuses a flagged tenant without an explicit acknowledgement, so a
          caption next to a still-clickable button would just produce a 409
          the operator cannot get past. */}
      {needsReview && !tiered && (
        <label className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            data-testid={`cpu-ack-${tenant.tenantId}`}
            className="rounded border-gray-300 dark:border-gray-600 dark:bg-gray-700"
          />
          I have reviewed the notes above and want to migrate anyway
        </label>
      )}
      {outcome && (
        <span
          data-testid={`cpu-outcome-${tenant.tenantId}`}
          className={clsx('text-xs', outcome.bad
            ? 'text-red-700 dark:text-red-400'
            : 'text-teal-700 dark:text-teal-300')}
        >
          {outcome.text}
        </span>
      )}
    </div>
  );
}

export default function CpuSchedulingPage() {
  const { data, isLoading, error } = useCpuMigrationPreview();
  const p = data?.data;

  const reservedPct = p && p.allocatableMillis > 0
    ? Math.round((p.reservedMillis / p.allocatableMillis) * 100) : null;
  const usedPct = p && p.allocatableMillis > 0 && p.usedMillis !== null
    ? Math.round((p.usedMillis / p.allocatableMillis) * 100) : null;

  return (
    <div className="space-y-6" data-testid="cpu-scheduling-page">
      <div className="flex items-center gap-2">
        <Cpu size={20} className="text-gray-600 dark:text-gray-400" />
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">CPU scheduling</h1>
        {/* This said "dry run — changes nothing" while the page was report-only.
            It now carries per-tenant Migrate/Revert buttons, so that label
            would be the page lying about itself — the figures are still a
            preview, but the page is no longer inert. */}
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">
          preview — nothing changes until you migrate a tenant
        </span>
      </div>

      <p className="max-w-3xl text-sm text-gray-600 dark:text-gray-400">
        Kubernetes places work by what pods <strong>reserve</strong>, not by what they use. When the
        two drift apart, the cluster refuses new work while running almost idle — and the refusal
        usually surfaces as something unrelated: a quota message, or a pod evicted to make room for
        a routine job. This page shows what re-sizing every tenant to a CPU <em>share</em> would
        free, and which tenants need a decision first.
      </p>

      {error && (
        <ErrorPanel error={extractOperatorError(error)} severity="error" testId="cpu-scheduling-error" />
      )}

      {isLoading && (
        <div className="flex justify-center py-12"><Loader2 size={22} className="animate-spin text-brand-500" /></div>
      )}

      {p && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Reserved"
              value={reservedPct === null ? '—' : `${reservedPct}%`}
              sub={`${cores(p.reservedMillis)} of ${cores(p.allocatableMillis)} cores`}
            />
            <Stat
              label="Actually used"
              /* Unknown is an em-dash, never 0 — a zero here would read as an
                 idle cluster and exaggerate the very gap this page reports. */
              value={usedPct === null ? '—' : `${usedPct}%`}
              sub={p.usedMillis === null ? 'not reported by every node' : `${cores(p.usedMillis)} cores`}
            />
            <Stat
              label="Would be freed"
              value={`${cores(p.reclaimableMillis)}`}
              sub="cores handed back to the scheduler"
              tone="good"
            />
            <Stat
              label="Need review"
              value={`${p.needsReviewCount}`}
              sub={`of ${p.tenants.length} tenants`}
            />
          </div>

          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900/40 dark:text-gray-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Tenant</th>
                  <th className="px-3 py-2 text-left font-medium">Plan</th>
                  <th className="px-3 py-2 text-right font-medium">Reserves now</th>
                  <th className="px-3 py-2 text-right font-medium">Would reserve</th>
                  <th className="px-3 py-2 text-right font-medium">Freed</th>
                  <th className="px-3 py-2 text-right font-medium">Burst ceiling</th>
                  <th className="px-3 py-2 text-right font-medium">Peak used (p95)</th>
                  <th className="px-3 py-2 text-left font-medium">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {p.tenants.map((t) => <TenantRow key={t.tenantId} t={t} />)}
                {p.tenants.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">No tenants.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            Peak used is the 95th percentile over the last 7 days, measured per tenant — the burst
            ceiling it is compared against is tenant-wide. Reservations shown are for running
            applications only; a stopped application holds nothing.
          </p>
        </>
      )}
    </div>
  );
}
