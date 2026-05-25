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
import type { BackupHealthSummary } from '@k8s-hosting/api-contracts';
import BackupHealthBanner from '@/components/BackupHealthBanner';
import { useBackupHealth } from '@/hooks/use-backup-health';
import { useBackupConfigs } from '@/hooks/use-backup-config';

interface ClassRow {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof KeyRound;
  /** Predicate to match the BackupHealthSummary rows that belong to this class. */
  readonly match: (s: BackupHealthSummary) => boolean;
}

// `BackupCategory` only has the values dr / tenant / audit / custom, so
// the System/Tenants/Mail split is derived from category + a heuristic
// on namespace / groupKey. Phase 3 may add a dedicated `mail` category
// label to backup-health if the heuristic proves brittle.
const isMail = (s: BackupHealthSummary): boolean =>
  s.namespace === 'mail'
  || s.groupKey.toLowerCase().includes('mail')
  || s.groupKey.toLowerCase().includes('stalwart');

const CLASSES: readonly ClassRow[] = [
  { to: '/backups/system',  label: 'System',  icon: KeyRound, match: (s) => s.category === 'dr' && !isMail(s) },
  { to: '/backups/tenants', label: 'Tenants', icon: Package,  match: (s) => s.category === 'tenant' },
  { to: '/backups/mail',    label: 'Mail',    icon: Mail,     match: (s) => isMail(s) },
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
}: {
  readonly icon: typeof KeyRound;
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly to: string;
  readonly tone: 'ok' | 'warn' | 'fail' | 'idle';
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
): { tone: Tone; value: string; detail: string } {
  if (!rows) return { tone: 'idle', value: '—', detail: 'loading…' };
  const mine = rows.filter(match);
  if (mine.length === 0) return { tone: 'idle', value: '0', detail: 'no jobs registered' };
  const failing = mine.filter((s) => s.state === 'failing');
  const lastSuccess = mine
    .map((s) => s.lastSuccessAt)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1) ?? null;
  if (failing.length > 0) {
    const tone: Tone = failing.some((s) => s.severity === 'critical') ? 'fail' : 'warn';
    return {
      tone,
      value: `${failing.length} failing`,
      detail: lastSuccess ? `last success ${timeAgo(lastSuccess)}` : 'never succeeded',
    };
  }
  return {
    tone: 'ok',
    value: `${mine.length} healthy`,
    detail: lastSuccess ? `last success ${timeAgo(lastSuccess)}` : 'never succeeded',
  };
}

export default function BackupsDashboard() {
  const { data: rows } = useBackupHealth();
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

      <BackupHealthBanner summaries={summaries} />

      <FrozenTargetsBanner configs={configs} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {CLASSES.map((c) => {
          const cls = classifyRows(summaries, c.match);
          return (
            <StatCard
              key={c.to}
              icon={c.icon}
              label={c.label}
              value={cls.value}
              detail={cls.detail}
              to={c.to}
              tone={cls.tone}
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
        {summaries.length === 0 ? (
          <p className="rounded border border-dashed border-gray-300 bg-gray-50 px-3 py-6 text-center text-sm text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400">
            No backup jobs reporting yet. Bind a backup class to a Remote Storage Target to get started.
          </p>
        ) : (
          <ul
            className="divide-y divide-gray-100 dark:divide-gray-700"
            data-testid="backups-dashboard-recent"
            aria-label="Recent backup activity"
          >
            {summaries.slice(0, 10).map((s) => {
              const isFail = s.state === 'failing';
              const Icon = isFail ? AlertCircle : CheckCircle;
              const iconTone = isFail
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
