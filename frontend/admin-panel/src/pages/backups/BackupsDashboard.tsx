/**
 * `/backups` — Backups Dashboard.
 *
 * Single-screen overview across the three backup classes (system,
 * tenants, mail). Health banner + stat cards + recent-activity table.
 * No per-class drill happens here — that's what the sidebar entries
 * are for; the dashboard exists to answer "is anything on fire?" in
 * one glance, with deep-links to the affected class.
 */

import { Link } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle,
  Cloud,
  Database,
  HardDrive,
  KeyRound,
  LifeBuoy,
  Mail,
  Package,
  Snowflake,
} from 'lucide-react';
import type { BackupHealthSummary } from '@insula/api-contracts';
import BackupHealthBanner from '@/components/BackupHealthBanner';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { useBackupHealth } from '@/hooks/use-backup-health';
import { useBackupConfigs } from '@/hooks/use-backup-config';

interface ClassRow {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof KeyRound;
  /** Predicate to match the BackupHealthSummary rows that belong to this class. */
  readonly match: (s: BackupHealthSummary) => boolean;
  /** Hover text: what the card counts, where that is not obvious. */
  readonly hint?: string;
}

// `BackupCategory` only has the values dr / tenant / audit / custom, so
// the System/Mail split is derived from category + a heuristic on
// namespace / groupKey. Tenants are their own category: one row per tenant,
// built by the backend from the bundle ledger — never matched by the mail
// heuristic, whatever a tenant's key contains.
const isMail = (s: BackupHealthSummary): boolean =>
  s.namespace === 'mail'
  || s.groupKey.toLowerCase().includes('mail')
  || s.groupKey.toLowerCase().includes('stalwart');

const CLASSES: readonly ClassRow[] = [
  { to: '/backups/system',  label: 'System',  icon: KeyRound, match: (s) => s.category === 'dr' && !isMail(s) },
  {
    to: '/backups/tenants', label: 'Tenants', icon: Package, match: (s) => s.category === 'tenant',
    hint: 'Each tenant by its newest finished bundle, plus every tenant in the nightly bundle run that has none yet. '
      + 'A tenant opted out of scheduled bundles with no bundle at all is not counted.',
  },
  { to: '/backups/mail',    label: 'Mail',    icon: Mail,     match: (s) => s.category !== 'tenant' && isMail(s) },
];

/**
 * DR safety: when any backup target carries read_only=true, show an
 * amber banner across the Backups dashboard naming each frozen target.
 * The freeze is the operator's signal that a DR restore is in progress
 * and they need to confirm data integrity before allowing writes again.
 * Each row deep-links to Remote Storage Targets where the operator can
 * use the Mark Read-Write modal.
 */
function FrozenTargetsBanner({
  configs,
}: {
  readonly configs: ReadonlyArray<{ id: string; name: string; readOnly: boolean }>;
}) {
  const frozen = configs.filter((c) => c.readOnly);
  if (frozen.length === 0) return null;
  return (
    <div
      className="rounded-xl border border-sky-300 dark:border-sky-700 bg-sky-50/70 dark:bg-sky-900/20 px-4 py-3 text-sm text-sky-800 dark:text-sky-200"
      data-testid="frozen-targets-banner"
    >
      <div className="flex items-start gap-2">
        <Snowflake size={16} className="mt-0.5 flex-none text-sky-500" />
        <div className="flex-1">
          <div className="font-medium">
            DR restore in progress — {frozen.length} backup target
            {frozen.length === 1 ? ' is' : 's are'} read-only.
          </div>
          <p className="mt-1 text-xs">
            Verify data integrity from each target before allowing writes.
            Until you mark them read-write, retention prunes and new
            backups against these targets are refused.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {frozen.map((t) => (
              <Link
                key={t.id}
                to="/backups/targets"
                className="inline-flex items-center gap-1 rounded bg-sky-100 dark:bg-sky-800/40 px-2 py-0.5 text-xs font-medium text-sky-700 dark:text-sky-200 hover:bg-sky-200 dark:hover:bg-sky-800/70"
              >
                <Snowflake size={10} />
                {t.name}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  to,
  tone,
  hint,
}: {
  readonly icon: typeof KeyRound;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly to: string;
  readonly tone: 'ok' | 'warn' | 'fail' | 'idle';
  readonly hint?: string;
}) {
  const toneRing = {
    ok:   'border-emerald-200 dark:border-emerald-800',
    warn: 'border-amber-300 dark:border-amber-700',
    fail: 'border-red-300 dark:border-red-700',
    idle: 'border-gray-200 dark:border-gray-700',
  }[tone];
  const toneIcon = {
    ok:   'text-emerald-600 dark:text-emerald-300',
    warn: 'text-amber-600 dark:text-amber-300',
    fail: 'text-red-600 dark:text-red-300',
    idle: 'text-gray-400 dark:text-gray-500',
  }[tone];
  return (
    <Link
      to={to}
      className={`block rounded-lg border bg-white p-4 shadow-sm transition hover:shadow-md dark:bg-gray-800 ${toneRing}`}
      data-testid={`backups-dashboard-stat-${label.toLowerCase()}`}
      title={hint}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</div>
          <div className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</div>
          <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">{detail}</div>
        </div>
        <Icon size={20} className={toneIcon} />
      </div>
    </Link>
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

type Tone = 'ok' | 'warn' | 'fail' | 'idle';

function classifyRows(
  rows: ReadonlyArray<BackupHealthSummary> | undefined,
  match: ClassRow['match'],
  failed: boolean,
): { tone: Tone; value: string; detail: string } {
  // No roll-up yet: say why. "0 · no jobs registered" here would claim the
  // class has no backups when the page simply has not heard back (or failed).
  if (!rows) return { tone: 'idle', value: '—', detail: failed ? 'unavailable' : 'loading…' };
  const mine = rows.filter(match);
  if (mine.length === 0) return { tone: 'idle', value: '0', detail: 'no jobs registered' };
  const failing = mine.filter((s) => s.state === 'failing');
  // Only `healthy` rows are healthy: a never-run row (for tenants, one the
  // nightly wave covers with no bundle yet) has nothing to its name.
  const healthy = mine.filter((s) => s.state === 'healthy').length;
  const neverRunRows = mine.filter((s) => s.state === 'never_run');
  const neverRun = neverRunRows.length;
  // Red when a problem row is critical. A never-run row only counts when
  // nothing has run for it at all (a tenant the nightly run has missed for
  // two days): a Job group whose first run is still in flight is amber.
  const critical = [...failing, ...neverRunRows.filter((s) => s.recentRuns === 0)]
    .some((s) => s.severity === 'critical');
  const lastSuccess = mine
    .map((s) => s.lastSuccessAt)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1) ?? null;
  const since = lastSuccess ? `last success ${timeAgo(lastSuccess)}` : 'never succeeded';
  const detail = [
    ...(failing.length > 0 ? [`${healthy} healthy`] : []),
    ...(neverRun > 0 ? [`${neverRun} never run`] : []),
    since,
  ].join(' · ');
  const problemTone: Tone = critical ? 'fail' : 'warn';
  if (failing.length > 0) return { tone: problemTone, value: `${failing.length} failing`, detail };
  return { tone: neverRun > 0 ? problemTone : 'ok', value: `${healthy} healthy`, detail };
}

const epochMs = (iso: string | null): number => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
};

/** The newest thing that happened to a row — its last success or failure. */
const lastActivity = (s: BackupHealthSummary): number =>
  Math.max(epochMs(s.lastSuccessAt), epochMs(s.lastFailedAt));

/**
 * "Recent backup activity": failures first, then by the newest run. The
 * roll-up's own order is by name, which — with a row per tenant — would let
 * tenants early in the alphabet push every other backup off the list.
 */
function recentActivity(rows: ReadonlyArray<BackupHealthSummary>): BackupHealthSummary[] {
  return [...rows].sort((a, b) => {
    const fa = a.state === 'failing' ? 0 : 1;
    const fb = b.state === 'failing' ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return lastActivity(b) - lastActivity(a);
  });
}

export default function BackupsDashboard() {
  const { data: rows, error: healthError, refetch, isFetching } = useBackupHealth();
  const { data: configsResponse } = useBackupConfigs();
  const configs = configsResponse?.data ?? [];
  // `BackupConfig.enabled` is typed as `number` (legacy 0/1 integer
  // pattern); `!== 0` keeps this resilient if the backend ever returns
  // a proper boolean or any truthy non-1 integer.
  const enabledTargets = configs.filter((c) => c.enabled !== 0);
  const totalTargets = configs.length;

  const summaries = rows ?? [];

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Backups</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Overview of system, tenant, and mail protection. Drill into a class for snapshots, backups, schedules, and retention.
        </p>
      </header>

      {healthError && (
        <ErrorPanel
          error={extractOperatorError(healthError)}
          severity="error"
          compact
          onRetry={() => { void refetch(); }}
          retryPending={isFetching}
          testId="backup-health-error"
        />
      )}

      <BackupHealthBanner summaries={summaries} />

      <FrozenTargetsBanner configs={configs} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {CLASSES.map((c) => {
          const cls = classifyRows(rows, c.match, !!healthError);
          return (
            <StatCard
              key={c.to}
              icon={c.icon}
              label={c.label}
              value={cls.value}
              detail={cls.detail}
              to={c.to}
              tone={cls.tone}
              hint={c.hint}
            />
          );
        })}
        <StatCard
          icon={Cloud}
          label="Remote Storage Targets"
          value={`${enabledTargets.length} / ${totalTargets}`}
          detail={enabledTargets.length === 0 ? 'no enabled target — bind one below' : 'enabled / total'}
          to="/backups/targets"
          tone={enabledTargets.length === 0 ? 'warn' : 'ok'}
        />
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <Database size={16} />
            Recent backup activity
          </h2>
        </div>
        {!rows ? (
          <p className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {healthError ? 'Backup health is unavailable.' : 'Loading…'}
          </p>
        ) : summaries.length === 0 ? (
          <p className="rounded border border-dashed border-gray-300 bg-gray-50 px-3 py-6 text-center text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400">
            No backup jobs reporting yet. Bind a backup class to a Remote Storage Target to get started.
          </p>
        ) : (
          <ul
            className="divide-y divide-gray-100 dark:divide-gray-700"
            data-testid="backups-dashboard-recent"
            aria-label="Recent backup activity"
          >
            {recentActivity(summaries).slice(0, 10).map((s) => {
              const isFail = s.state === 'failing';
              // A never-run row (e.g. a tenant with no bundle yet) is a problem
              // too — never a green check beside "last success never".
              const isNeverRun = s.state === 'never_run';
              const Icon = isFail || isNeverRun ? AlertCircle : CheckCircle;
              const iconTone = isFail || isNeverRun
                ? (s.severity === 'critical' ? 'text-red-600 dark:text-red-300' : 'text-amber-600 dark:text-amber-300')
                : 'text-emerald-600 dark:text-emerald-300';
              return (
                <li key={s.groupKey} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon size={14} className={`flex-shrink-0 ${iconTone}`} />
                    <span className="truncate font-medium text-gray-900 dark:text-gray-100">{s.displayName}</span>
                    <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                      {s.category}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {isFail
                      ? <>failed {timeAgo(s.lastFailedAt)}</>
                      : isNeverRun
                        ? <>never run</>
                        : <>last success {timeAgo(s.lastSuccessAt)}</>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
        <div className="flex items-start gap-2">
          <HardDrive size={16} className="mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-semibold">Snapshots vs backups</p>
            <p className="mt-1">
              <strong>Snapshots</strong> are in-cluster, point-in-time block copies (Longhorn CSI). Cheap, fast, survive
              accidental delete but not cluster loss. <strong>Backups</strong> are uploaded artifacts at an off-cluster
              Remote Storage Target (S3, SFTP, CIFS). Survive cluster loss.
            </p>
            <p className="mt-2">
              For disaster-recovery posture (Secrets bundle, DR drill, restore instructions) see{' '}
              <Link to="/backups/disaster-recovery" className="inline-flex items-center gap-1 underline">
                <LifeBuoy size={12} />
                Disaster Recovery
              </Link>.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
