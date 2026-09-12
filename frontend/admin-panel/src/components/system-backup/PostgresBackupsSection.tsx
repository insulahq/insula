/**
 * Platform-database offsite backups — ONE card, ONE switch, three settings.
 *
 * Replaces the two-toggle "WAL Streaming" + "Scheduled Base Backups" layout
 * (2026-09-11, operator request). That layout modelled WAL archiving and base
 * backups as independent features an operator could mix and match. They are
 * not: a base backup is only restorable together with the WAL written while it
 * ran, and the barman-cloud plugin that ships one ships the other. Offering a
 * "Disable WAL Streaming" button therefore offered something the platform
 * cannot do — it left archiving running and the panel then had to explain, in
 * an amber banner, why the thing you just turned off was still on.
 *
 * So: offsite backups are on or off, and when they are on you choose how often
 * a base backup runs, how often WAL is shipped, and how long both are kept.
 * Everything else on this card is read-only fact about what the archive
 * currently holds.
 */

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Database, RefreshCw, AlertCircle, CheckCircle2, Power, PowerOff,
  Loader2, History, HardDrive, Clock, Activity,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  useWalArchiveClusters,
  useEnableWalArchive,
  useDisableWalArchive,
} from '@/hooks/use-system-wal-archive';
import { useShimAssignments } from '@/hooks/use-backup-rclone-shim';
import { useCnpgBackupHealth } from '@/hooks/use-cnpg-backup-health';
import { apiFetch } from '@/lib/api-client';
import { formatBytes } from '@/hooks/use-platform-storage';
import type { WalArchiveCluster, CnpgBackupCatalogueResponse, WalArchiveSummary } from '@insula/api-contracts';

// ── Setting vocabularies ───────────────────────────────────────────

const CADENCE_PRESETS: Array<{ value: string; label: string }> = [
  { value: '0 0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 0 3 * * *', label: 'Daily at 03:00' },
  { value: '0 0 3 * * 0', label: 'Weekly, Sunday 03:00' },
  { value: '0 0 3 1 * *', label: 'Monthly, 1st at 03:00' },
];

const ARCHIVE_TIMEOUT_PRESETS: Array<{ value: string; label: string }> = [
  { value: '30s', label: 'Every 30 seconds' },
  { value: '1min', label: 'Every minute' },
  { value: '5min', label: 'Every 5 minutes' },
  { value: '15min', label: 'Every 15 minutes' },
  { value: '1h', label: 'Every hour' },
];

const DEFAULT_CADENCE = '0 0 3 * * *';
const DEFAULT_ARCHIVE_TIMEOUT = '5min';
const DEFAULT_RETENTION = 30;

const CRON6_RE = /^(\S+\s+){5}\S+$/;
const isValidCron6 = (s: string): boolean => CRON6_RE.test(s.trim());

/**
 * Retention covers WAL **and** base backups with one number. Set it below the
 * base-backup cadence and the platform deletes the base a restore would replay
 * onto — WAL with nothing underneath it restores nothing.
 */
function cadenceDays(cron: string | null | undefined): number | null {
  if (!cron) return null;
  if (cron === '0 0 */6 * * *') return 0.25;
  if (cron === '0 0 3 * * *') return 1;
  if (cron === '0 0 3 * * 0') return 7;
  if (cron === '0 0 3 1 * *') return 30;
  return null;
}
function minSafeRetentionDays(cron: string | null | undefined): number {
  const c = cadenceDays(cron);
  if (c === null) return 14; // unrecognised custom cron — safe for weekly
  return Math.max(1, Math.ceil(c * 2));
}

// ── Entry point ────────────────────────────────────────────────────

export default function PostgresBackupsSection() {
  const clustersQ = useWalArchiveClusters();

  if (clustersQ.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-5 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
        <Loader2 size={14} className="animate-spin" /> Loading database backup settings…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {clustersQ.data?.map((c) => (
        <ClusterCard key={`${c.clusterNamespace}/${c.clusterName}`} cluster={c} />
      ))}
    </div>
  );
}

// ── The card ───────────────────────────────────────────────────────

function ClusterCard({ cluster }: { readonly cluster: WalArchiveCluster }) {
  // ONE state. The plugin entry being attached is what makes the platform
  // archive, so it is also what "offsite backups are on" means.
  const enabled = cluster.walArchivingActive;

  const { data: assignResp } = useShimAssignments();
  const systemAssignment = assignResp?.data?.assignments?.find((a) => a.className === 'system');
  const targetBound = !!systemAssignment?.targetId;

  return (
    <section
      className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      data-testid={`pg-backups-${cluster.clusterName}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            <Database size={18} /> Platform database backups
          </h3>
          <p className="mt-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">
            {cluster.clusterNamespace}/{cluster.clusterName}
          </p>
        </div>
        <StatePill enabled={enabled} targetBound={targetBound} />
      </header>

      <p className="max-w-3xl text-sm leading-relaxed text-gray-600 dark:text-gray-300">
        A <strong>base backup</strong> is a full copy of the database, taken on the
        cadence you choose. Between base backups the platform uploads the
        database&apos;s <strong>write-ahead log</strong> — the running record of every
        change — so a restore can replay forward to any moment, not just to the
        last full copy. Both go to the{' '}
        <Link to="/backups/system?tab=routing" className="font-medium text-brand-600 hover:underline dark:text-brand-300">
          bound system target
        </Link>{' '}
        and both are deleted once they pass the retention age.
      </p>

      <SettingsForm cluster={cluster} enabled={enabled} targetBound={targetBound} />

      {enabled && <StatusGrid cluster={cluster} />}
    </section>
  );
}

function StatePill({ enabled, targetBound }: { readonly enabled: boolean; readonly targetBound: boolean }) {
  if (enabled) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
        data-testid="pg-backups-state"
      >
        <CheckCircle2 size={12} /> Offsite backups on
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
      data-testid="pg-backups-state"
    >
      <PowerOff size={12} /> {targetBound ? 'Offsite backups off' : 'No storage target bound'}
    </span>
  );
}

// ── Settings: the only four things an operator sets ────────────────

function SettingsForm({
  cluster, enabled, targetBound,
}: {
  readonly cluster: WalArchiveCluster;
  readonly enabled: boolean;
  readonly targetBound: boolean;
}) {
  const savedCadence = cluster.state?.baseBackupSchedule ?? DEFAULT_CADENCE;
  const savedTimeout = cluster.state?.archiveTimeout ?? DEFAULT_ARCHIVE_TIMEOUT;
  const savedRetention = cluster.state?.retentionDays ?? DEFAULT_RETENTION;

  const [cadence, setCadence] = useState(savedCadence);
  const [customCadence, setCustomCadence] = useState(
    CADENCE_PRESETS.some((p) => p.value === savedCadence) ? '' : savedCadence,
  );
  const [archiveTimeout, setArchiveTimeout] = useState(savedTimeout);
  const [retentionDays, setRetentionDays] = useState(savedRetention);

  const enable = useEnableWalArchive();
  const disable = useDisableWalArchive();

  const usingCustom = cadence === 'CUSTOM';
  const effectiveCadence = usingCustom ? customCadence.trim() : cadence;
  const cadenceInvalid = usingCustom && !isValidCron6(customCadence);

  const minRetention = minSafeRetentionDays(effectiveCadence);
  const retentionTooShort = retentionDays < minRetention;

  const dirty = enabled && (
    effectiveCadence !== savedCadence
    || archiveTimeout !== savedTimeout
    || retentionDays !== savedRetention
  );

  const busy = enable.isPending || disable.isPending;
  const blocked = cadenceInvalid || retentionTooShort;

  const apply = (): void => {
    if (!enabled && !window.confirm(
      'Turn on offsite backups for the platform database?\n\n'
      + 'Postgres is reconfigured to archive its write-ahead log, which restarts '
      + 'the database instance once. A base backup runs on the cadence you chose.',
    )) return;
    void enable.mutateAsync({
      clusterNamespace: cluster.clusterNamespace,
      clusterName: cluster.clusterName,
      retentionDays,
      archiveTimeout,
      baseBackupSchedule: effectiveCadence,
    }).catch(() => undefined);
  };

  const turnOff = (): void => {
    if (!window.confirm(
      `Turn OFF offsite backups for ${cluster.clusterNamespace}/${cluster.clusterName}?\n\n`
      + 'The platform stops taking base backups AND stops uploading the write-ahead '
      + 'log, so the database becomes unrecoverable from anything newer than the last '
      + 'backup already at the target. Existing backups are left where they are.',
    )) return;
    void disable.mutateAsync({
      clusterNamespace: cluster.clusterNamespace,
      clusterName: cluster.clusterName,
    }).catch(() => undefined);
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/30">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Setting
          label="Base backup cadence"
          hint="How often a full copy is taken."
        >
          <select
            value={usingCustom || CADENCE_PRESETS.some((p) => p.value === cadence) ? cadence : 'CUSTOM'}
            onChange={(e) => setCadence(e.target.value)}
            disabled={busy}
            className={selectCls}
            data-testid={`pg-cadence-${cluster.clusterName}`}
          >
            {CADENCE_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            <option value="CUSTOM">Custom schedule…</option>
          </select>
          {usingCustom && (
            <>
              <input
                type="text"
                value={customCadence}
                onChange={(e) => setCustomCadence(e.target.value)}
                placeholder="0 0 3 * * *"
                disabled={busy}
                aria-invalid={cadenceInvalid}
                className={`mt-1 w-full rounded-lg border bg-white px-2 py-1.5 font-mono text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 ${
                  cadenceInvalid ? 'border-rose-400 dark:border-rose-600' : 'border-gray-300 dark:border-gray-600'
                }`}
                data-testid={`pg-cadence-custom-${cluster.clusterName}`}
              />
              <p className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
                Six fields: second minute hour day month weekday.
              </p>
            </>
          )}
        </Setting>

        <Setting
          label="Archive timeout"
          hint="How often the write-ahead log is shipped. This is your recovery-point target: lose the server and you lose at most this much work."
        >
          <select
            value={archiveTimeout}
            onChange={(e) => setArchiveTimeout(e.target.value)}
            disabled={busy}
            className={selectCls}
            data-testid={`pg-archive-timeout-${cluster.clusterName}`}
          >
            {ARCHIVE_TIMEOUT_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </Setting>

        <Setting
          label="Retention"
          hint="Applies to base backups and write-ahead log alike."
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={3650}
              value={retentionDays}
              onChange={(e) => setRetentionDays(parseInt(e.target.value, 10) || 1)}
              disabled={busy}
              aria-invalid={retentionTooShort}
              className={`w-24 rounded-lg border bg-white px-2 py-1.5 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 ${
                retentionTooShort ? 'border-rose-400 dark:border-rose-600' : 'border-gray-300 dark:border-gray-600'
              }`}
              data-testid={`pg-retention-${cluster.clusterName}`}
            />
            <span className="text-sm text-gray-600 dark:text-gray-300">days</span>
          </div>
          {retentionTooShort && (
            <p
              className="mt-1 text-[11px] leading-snug text-rose-700 dark:text-rose-300"
              data-testid={`pg-retention-error-${cluster.clusterName}`}
            >
              Too short for this cadence — keep at least {minRetention} days, or the
              last full copy is deleted before the next one is taken and there is
              nothing to restore onto.
            </p>
          )}
        </Setting>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {(enable.isError || disable.isError) && (
          <span className="mr-auto flex items-center gap-1 text-xs text-rose-700 dark:text-rose-300">
            <AlertCircle size={12} />
            {((enable.error ?? disable.error) as Error | undefined)?.message}
          </span>
        )}
        {!targetBound && !enabled && (
          <span className="mr-auto text-xs text-gray-600 dark:text-gray-400">
            Bind a system storage target above first — there is nowhere to upload to.
          </span>
        )}
        {enabled ? (
          <>
            <button
              type="button"
              onClick={apply}
              disabled={!dirty || busy || blocked}
              className="inline-flex items-center gap-1.5 rounded-md border border-brand-300 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-600 dark:text-brand-300 dark:hover:bg-brand-900/30"
              data-testid={`pg-save-${cluster.clusterName}`}
            >
              {enable.isPending ? <RefreshCw size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
              Save changes
            </button>
            <button
              type="button"
              onClick={turnOff}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              data-testid={`pg-disable-${cluster.clusterName}`}
            >
              {disable.isPending ? <RefreshCw size={13} className="animate-spin" /> : <PowerOff size={13} />}
              Turn off offsite backups
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={apply}
            disabled={!targetBound || busy || blocked}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            data-testid={`pg-enable-${cluster.clusterName}`}
          >
            {enable.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Power size={13} />}
            Turn on offsite backups
          </button>
        )}
      </div>
    </div>
  );
}

// ── Status: what the archive actually holds ────────────────────────

function StatusGrid({ cluster }: { readonly cluster: WalArchiveCluster }) {
  const archive = useArchiveContents(cluster);

  const lastWal = cluster.status?.lastArchivedWalTime ?? null;
  const archived = cluster.status?.archivedCount ?? null;
  const failed = cluster.status?.failedCount ?? null;
  const successRate = archived !== null && failed !== null && archived + failed > 0
    ? (archived / (archived + failed)) * 100
    : null;

  // The floor of the restorable range: CNPG's own figure, else the oldest thing
  // actually in the archive. Reported as a RANGE because "which moments can I
  // restore to" is the operator's question and no single timestamp answers it.
  const floor = cluster.status?.firstRecoverabilityPoint
    ?? archive.earliestBackupAt
    ?? archive.walSummary?.oldestAt
    ?? null;
  const windowDays = floor ? Math.max(0, Math.floor((Date.now() - new Date(floor).getTime()) / 86_400_000)) : null;

  const baseBytes = archive.baseBytes;
  const walBytes = archive.walSummary?.totalBytes ?? null;
  const totalBytes = baseBytes !== null || walBytes !== null ? (baseBytes ?? 0) + (walBytes ?? 0) : null;

  const lastBase = cluster.state?.baseBackupStatus?.lastScheduleTime ?? null;
  const nextBase = cluster.state?.baseBackupStatus?.nextScheduleTime ?? null;

  // Every cell must end on a definite statement. "Measuring…" that never
  // resolves is the failure this replaces, so a failed read SAYS so.
  const windowValue = floor
    ? `${new Date(floor).toLocaleString()} → now${windowDays !== null ? ` · ${windowDays} day${windowDays === 1 ? '' : 's'}` : ''}`
    : archive.baseState === 'loading'
      ? 'reading the archive…'
      : archive.baseState === 'error'
        ? 'could not read the archive — check the storage target'
        : 'nothing restorable yet — the first base backup has not run';

  const storageValue = totalBytes !== null
    ? `${formatBytes(totalBytes)}${archive.walSummary?.truncated || archive.basePartial ? ' or more' : ''}`
    : archive.baseState === 'loading' || archive.walState === 'loading'
      ? 'measuring…'
      : 'could not measure — check the storage target';

  const storageSub = totalBytes !== null
    ? `${baseBytes !== null ? formatBytes(baseBytes) : (archive.baseState === 'error' ? 'unreadable' : '—')} base copies · ${
      walBytes !== null ? formatBytes(walBytes) : (archive.walState === 'error' ? 'unreadable' : '—')} log${
      archive.walSummary ? ` (${archive.walSummary.segmentCount}${archive.walSummary.truncated ? '+' : ''} segments)` : ''}`
    : undefined;

  return (
    <div
      className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border border-gray-200 bg-white p-4 text-sm dark:border-gray-700 dark:bg-gray-800 sm:grid-cols-2"
      data-testid={`pg-status-${cluster.clusterName}`}
    >
      <Stat
        icon={<History size={14} />}
        label="Can restore to any point in"
        testid={`pg-window-${cluster.clusterName}`}
        value={windowValue}
        tone={archive.baseState === 'error' ? 'bad' : 'normal'}
      />
      <Stat
        icon={<Clock size={14} />}
        label="Base backups"
        testid={`pg-base-${cluster.clusterName}`}
        value={lastBase
          ? `last ${formatAgo(lastBase)}${nextBase ? ` · next ${new Date(nextBase).toLocaleString()}` : ''}`
          : (nextBase ? `first one due ${new Date(nextBase).toLocaleString()}` : 'none taken yet')}
        sub={archive.backupCount !== null
          ? `${archive.backupCount}${archive.basePartial ? '+' : ''} kept offsite`
          : (archive.baseState === 'error' ? 'count unavailable' : undefined)}
      />
      <Stat
        icon={<Activity size={14} />}
        label="Write-ahead log"
        testid={`pg-wal-${cluster.clusterName}`}
        value={lastWal ? `last upload ${formatAgo(lastWal)}` : 'no segment uploaded yet'}
        sub={successRate !== null
          ? `${successRate.toFixed(successRate >= 99.95 ? 2 : 1)}% uploaded first try · ${archived} ok, ${failed} retried since counters reset`
          : undefined}
        tone={cluster.status?.lastFailedArchiveTime ? 'bad' : 'normal'}
      />
      <Stat
        icon={<HardDrive size={14} />}
        label="Offsite storage used"
        testid={`pg-storage-${cluster.clusterName}`}
        value={storageValue}
        sub={storageSub}
        tone={totalBytes === null && archive.walState === 'error' && archive.baseState === 'error' ? 'bad' : 'normal'}
      />
    </div>
  );
}

function Stat({
  icon, label, value, sub, testid, tone = 'normal',
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
  readonly testid?: string;
  readonly tone?: 'normal' | 'bad';
}) {
  return (
    <div data-testid={testid}>
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {icon}{label}
      </div>
      <div className={`mt-0.5 font-medium ${tone === 'bad' ? 'text-rose-700 dark:text-rose-300' : 'text-gray-900 dark:text-gray-100'}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-gray-500 dark:text-gray-400">{sub}</div>}
    </div>
  );
}

// ── Data ───────────────────────────────────────────────────────────

/**
 * What is actually sitting at the target: base backups (count + bytes) and the
 * WAL summary. Read from the object store through the shim, so it survives a
 * CNPG operator outage and reports the archive rather than the intent.
 */
function useArchiveContents(cluster: WalArchiveCluster): {
  readonly earliestBackupAt: string | null;
  readonly backupCount: number | null;
  readonly baseBytes: number | null;
  readonly basePartial: boolean;
  readonly walSummary: WalArchiveSummary | null;
  readonly baseState: 'loading' | 'ready' | 'error';
  readonly walState: 'loading' | 'ready' | 'error';
} {
  const { data: healthResp, isLoading: healthLoading } = useCnpgBackupHealth();
  const objectStoreName = healthResp?.data?.find(
    (c) => c.namespace === cluster.clusterNamespace && c.clusterName === cluster.clusterName,
  )?.objectStoreName ?? null;

  const base = `/api/v1/admin/cnpg-backup-catalogue/${encodeURIComponent(cluster.clusterNamespace)}/${encodeURIComponent(objectStoreName ?? '')}`;

  // TWO queries on purpose. Enumerating base backups costs a GET + a HEAD per
  // backup through the storage shim and can take minutes; the WAL summary is
  // paginated LISTs and answers in seconds. Sharing one query made the storage
  // figure wait on the slow half and the cell never resolved.
  const catalogueQ = useQuery({
    queryKey: ['cnpg-backup-catalogue', cluster.clusterNamespace, objectStoreName],
    queryFn: () => apiFetch<{ data: CnpgBackupCatalogueResponse }>(base),
    staleTime: 60_000,
    retry: false,
    enabled: !!objectStoreName,
  });

  const walQ = useQuery({
    queryKey: ['cnpg-wal-summary', cluster.clusterNamespace, objectStoreName],
    // Naming the cluster lets the backend skip a bucket-wide discovery LIST.
    queryFn: () => apiFetch<{ data: WalArchiveSummary }>(
      `${base}/wal-summary?cluster=${encodeURIComponent(cluster.clusterName)}`,
    ),
    staleTime: 5 * 60_000,
    retry: false,
    enabled: !!objectStoreName,
  });

  return useMemo(() => {
    const cat = catalogueQ.data?.data;
    const baseState: 'loading' | 'ready' | 'error' =
      catalogueQ.isError || (cat && cat.source !== 'object-store') ? 'error'
        : (healthLoading || (objectStoreName !== null && catalogueQ.isLoading) ? 'loading' : 'ready');

    const wal = walQ.data?.data ?? null;
    const walState: 'loading' | 'ready' | 'error' =
      walQ.isError || (wal?.readError != null) ? 'error'
        : (healthLoading || (objectStoreName !== null && walQ.isLoading) ? 'loading' : 'ready');

    const sorted = cat && cat.source === 'object-store'
      ? [...cat.backups].sort((a, b) => (a.startedAt ?? a.uploadedAt ?? '').localeCompare(b.startedAt ?? b.uploadedAt ?? ''))
      : [];
    const sized = sorted.filter((b) => typeof b.dataSizeBytes === 'number');

    return {
      earliestBackupAt: sorted[0]?.startedAt ?? sorted[0]?.uploadedAt ?? null,
      backupCount: cat && cat.source === 'object-store' ? cat.backups.length : null,
      baseBytes: sized.length > 0 ? sized.reduce((n, b) => n + (b.dataSizeBytes ?? 0), 0) : null,
      basePartial: Boolean(cat?.partial),
      walSummary: wal && wal.readError == null ? wal : null,
      baseState,
      walState,
    } as const;
  }, [catalogueQ.data, catalogueQ.isError, catalogueQ.isLoading, walQ.data, walQ.isError, walQ.isLoading, healthLoading, objectStoreName]);
}

// ── bits ───────────────────────────────────────────────────────────

const selectCls = 'w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100';

function Setting({
  label, hint, children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-900 dark:text-gray-100">{label}</label>
      <p className="mb-1.5 text-xs leading-snug text-gray-500 dark:text-gray-400">{hint}</p>
      {children}
    </div>
  );
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'unknown';
  if (ms < 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'seconds ago';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
