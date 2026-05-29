/**
 * WAL Archive tab — Phase 7c rewrite (2026-05-24).
 *
 * Two independent feature sections:
 *   1. WAL Streaming        — continuous archiver, archive_timeout, retention
 *   2. Scheduled Backups    — periodic base backups (cron)
 * Plus a read-only status panel sourced from the cluster CR's
 * .status.conditions.
 *
 * Each section has its own enable/disable toggle. Fields are EDITABLE
 * at all times — clicking "Save changes" re-invokes the enable endpoint
 * (idempotent on the backend) so operators can adjust archive_timeout,
 * cron, retention without disable+re-enable.
 *
 * The "target" for both sections is the SYSTEM shim binding (read-only
 * display + link to Routing tab). No per-cluster picker.
 */

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArchiveRestore, RefreshCw, AlertCircle, CheckCircle2,
  Power, PowerOff, Cloud, Link as LinkIcon, Info, PauseCircle,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  useWalArchiveClusters,
  useEnableWalStreaming,
  useDisableWalStreaming,
  useEnableScheduledBackups,
  useDisableScheduledBackups,
} from '@/hooks/use-system-wal-archive';
import { useShimAssignments } from '@/hooks/use-backup-rclone-shim';
import { useCnpgBackupHealth } from '@/hooks/use-cnpg-backup-health';
import { apiFetch } from '@/lib/api-client';
import type { WalArchiveCluster, CnpgBackupCatalogueResponse } from '@insula/api-contracts';

// 6-field cron validation: matches CNPG's robfig/cron/v3 parser. The
// backend's baseBackupScheduleSchema applies the SAME regex
// (packages/api-contracts/src/system-wal-archive.ts).
const CRON6_RE = /^(\S+\s+){5}\S+$/;
function isValidCron6(s: string): boolean {
  return CRON6_RE.test(s.trim());
}

/**
 * Phase 8 (2026-05-25) — retention safety check.
 *
 * CNPG's barman-cloud ObjectStore has ONE retention value that applies to
 * both WAL files AND base backups. If the operator sets retention shorter
 * than the base-backup cadence, base files get deleted BEFORE the next
 * scheduled base = WAL has nothing to replay onto = no DR. Compute the
 * minimum-safe retention (2 × cadence) from the chosen cron and warn
 * inline when the current retention falls below it.
 *
 * Cadence-in-days for known presets. Returns null for custom crons —
 * operator's responsibility (we fall back to a safe 14-day default).
 */
function estimateCadenceDays(cron: string | null | undefined): number | null {
  if (!cron) return null;
  if (cron === '0 0 */6 * * *') return 0.25;
  if (cron === '0 0 3 * * *') return 1;
  if (cron === '0 0 3 * * 0') return 7;
  if (cron === '0 0 3 1 * *') return 30;
  return null;
}
function minSafeRetentionDays(cron: string | null | undefined): number {
  if (!cron) return 1;
  const cadence = estimateCadenceDays(cron);
  // 14-day fallback for unrecognised custom crons — covers weekly safely
  // and is the operator's safety net when they roll their own schedule.
  if (cadence === null) return 14;
  return Math.max(1, Math.ceil(cadence * 2));
}

const ARCHIVE_TIMEOUT_PRESETS: Array<{ value: string; label: string }> = [
  { value: '30s',   label: '30 sec (RPO ~30s)' },
  { value: '1min',  label: '1 min (RPO ~1m)' },
  { value: '5min',  label: '5 min (CNPG default)' },
  { value: '15min', label: '15 min' },
  { value: '1h',    label: '1 hour' },
];

const CRON_PRESETS: Array<{ value: string; label: string }> = [
  { value: '0 0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 0 3 * * *',   label: 'Daily at 03:00' },
  { value: '0 0 3 * * 0',   label: 'Weekly Sun 03:00' },
  { value: '0 0 3 1 * *',   label: 'Monthly 1st 03:00' },
];

export default function WalArchiveTab() {
  const clustersQ = useWalArchiveClusters();
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          <ArchiveRestore size={20} /> Postgres Backups (WAL Streaming + Scheduled Base Backups)
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Single source of truth for continuous WAL streaming and periodic
          base backups. The target is the SYSTEM backup binding configured
          under{' '}
          <Link to="/backups/system?tab=routing" className="font-medium text-brand-600 hover:underline dark:text-brand-300">
            Routing
          </Link>{' '}— any storage type (S3, CIFS, NFS, SFTP) works because
          writes go through the internal S3 shim.
        </p>
      </header>

      {clustersQ.isLoading && (
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading…</div>
      )}
      {!clustersQ.isLoading && clustersQ.data?.map((c) => (
        <ClusterCard key={`${c.clusterNamespace}/${c.clusterName}`} cluster={c} />
      ))}
    </div>
  );
}

function ClusterCard({ cluster }: { cluster: WalArchiveCluster }) {
  // Phase 7a (2026-05-24): two independent feature toggles inferred
  // from the saved state — `archiveTimeout` means streaming is on;
  // `baseBackupSchedule` means scheduled backups are on.
  const streamingActive = !!cluster.state?.archiveTimeout;
  const scheduleActive = !!cluster.state?.baseBackupSchedule;

  const { data: assignResp } = useShimAssignments();
  const systemAssignment = assignResp?.data?.assignments?.find((a) => a.className === 'system');
  const systemTargetBound = !!systemAssignment?.targetId;

  return (
    <section className="space-y-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
      <header className="flex items-start justify-between gap-3">
        <h3 className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100">
          {cluster.clusterNamespace}/{cluster.clusterName}
        </h3>
        <TargetBoundIndicator
          name={systemAssignment?.targetName ?? null}
          storageType={systemAssignment?.targetStorageType ?? null}
          bound={systemTargetBound}
        />
      </header>

      <WalStreamingSection
        cluster={cluster}
        active={streamingActive}
        canEnable={systemTargetBound}
      />
      <ScheduledBackupsSection
        cluster={cluster}
        active={scheduleActive}
        canEnable={systemTargetBound}
      />
      <StatusPanel cluster={cluster} />
    </section>
  );
}

// ── WAL Streaming section ──────────────────────────────────────────

function WalStreamingSection({
  cluster, active, canEnable,
}: {
  cluster: WalArchiveCluster;
  active: boolean;
  canEnable: boolean;
}) {
  const enable = useEnableWalStreaming();
  const disable = useDisableWalStreaming();
  const [archiveTimeout, setArchiveTimeout] = useState<string>(
    cluster.state?.archiveTimeout ?? '5min',
  );
  const [retentionDays, setRetentionDays] = useState<number>(
    cluster.state?.retentionDays ?? 30,
  );

  const savedSettings = useMemo(() => ({
    archiveTimeout: cluster.state?.archiveTimeout ?? null,
    retentionDays: cluster.state?.retentionDays ?? null,
  }), [cluster.state]);

  const hasUnsavedChanges = active && (
    archiveTimeout !== savedSettings.archiveTimeout
    || retentionDays !== savedSettings.retentionDays
  );

  // Phase 8 (2026-05-25): warn when retention is shorter than the
  // base-backup cadence requires. CNPG's retentionPolicy applies to
  // both WAL + base together, so a too-short retention deletes base
  // files before the next base = no DR. See minSafeRetentionDays.
  const savedCron = cluster.state?.baseBackupSchedule ?? null;
  const minRetention = minSafeRetentionDays(savedCron);
  const retentionTooShort = !!savedCron && retentionDays < minRetention;

  const onEnable = (): void => {
    void enable.mutateAsync({
      clusterNamespace: cluster.clusterNamespace,
      clusterName: cluster.clusterName,
      archiveTimeout,
      retentionDays,
    }).catch(() => undefined);
  };
  const onDisable = (): void => {
    if (!window.confirm(
      `Disable WAL streaming for ${cluster.clusterNamespace}/${cluster.clusterName}? Existing WAL files at the target are kept. Scheduled backups (if enabled) stay on.`,
    )) return;
    void disable.mutateAsync({
      clusterNamespace: cluster.clusterNamespace,
      clusterName: cluster.clusterName,
    }).catch(() => undefined);
  };

  return (
    <div
      className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/30"
      data-testid={`wal-streaming-section-${cluster.clusterName}`}
    >
      <SectionHeader
        title="WAL Streaming"
        tooltip="Continuous Postgres WAL streaming via the barman-cloud plugin. Required for PITR — without WAL streaming you can only recover to base-backup points in time. RPO = archive_timeout. WAL files are pushed continuously to the SYSTEM backup target's bucket via the internal S3 shim."
        active={active}
      />
      <div className="mt-3 grid grid-cols-1 gap-3 text-xs md:grid-cols-2">
        <Setting label="archive_timeout (RPO)">
          <select
            value={archiveTimeout}
            onChange={(e) => setArchiveTimeout(e.target.value)}
            disabled={enable.isPending || disable.isPending}
            className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            data-testid={`wal-archive-timeout-${cluster.clusterName}`}
          >
            {ARCHIVE_TIMEOUT_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </Setting>
        <Setting label="Retention (days, applies to WAL + base backups)">
          <input
            type="number"
            min={1}
            max={3650}
            value={retentionDays}
            onChange={(e) => setRetentionDays(parseInt(e.target.value, 10) || 30)}
            disabled={enable.isPending || disable.isPending}
            aria-invalid={retentionTooShort}
            className={`w-full rounded-lg border bg-white px-2 py-1.5 text-sm text-gray-900 disabled:opacity-60 dark:bg-gray-700 dark:text-gray-100 ${
              retentionTooShort
                ? 'border-rose-400 dark:border-rose-600'
                : 'border-gray-300 dark:border-gray-600'
            }`}
            data-testid={`wal-retention-${cluster.clusterName}`}
          />
          {retentionTooShort && (
            <p
              className="mt-0.5 text-[10px] text-rose-700 dark:text-rose-300"
              data-testid={`wal-retention-error-${cluster.clusterName}`}
            >
              Retention {retentionDays}d is shorter than the base-backup
              cadence requires (need ≥{minRetention}d for current schedule
              <code className="ml-1">{savedCron}</code>). Risk: base backups
              deleted before next base = no DR.
            </p>
          )}
        </Setting>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {enable.isError && (
          <span className="mr-auto flex items-center gap-1 text-xs text-rose-700 dark:text-rose-300">
            <AlertCircle size={12} />{(enable.error as Error).message}
          </span>
        )}
        {disable.isError && (
          <span className="mr-auto flex items-center gap-1 text-xs text-rose-700 dark:text-rose-300">
            <AlertCircle size={12} />{(disable.error as Error).message}
          </span>
        )}
        {active ? (
          <>
            <button
              type="button"
              onClick={onEnable}
              disabled={!hasUnsavedChanges || enable.isPending || retentionTooShort}
              className="inline-flex items-center gap-1 rounded-md border border-brand-300 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-600 dark:text-brand-300 dark:hover:bg-brand-900/30"
              data-testid={`wal-streaming-save-${cluster.clusterName}`}
            >
              {enable.isPending ? <RefreshCw size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              Save changes
            </button>
            <button
              type="button"
              onClick={onDisable}
              disabled={disable.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              data-testid={`wal-streaming-disable-${cluster.clusterName}`}
            >
              {disable.isPending ? <RefreshCw size={12} className="animate-spin" /> : <PowerOff size={12} />}
              Disable WAL Streaming
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onEnable}
            disabled={!canEnable || enable.isPending}
            title={!canEnable ? 'Bind a SYSTEM target on the Routing tab first.' : ''}
            className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            data-testid={`wal-streaming-enable-${cluster.clusterName}`}
          >
            {enable.isPending ? <RefreshCw size={12} className="animate-spin" /> : <Power size={12} />}
            Enable WAL Streaming
          </button>
        )}
      </div>
    </div>
  );
}

// ── Scheduled Base Backups section ─────────────────────────────────

function ScheduledBackupsSection({
  cluster, active, canEnable,
}: {
  cluster: WalArchiveCluster;
  active: boolean;
  canEnable: boolean;
}) {
  const enable = useEnableScheduledBackups();
  const disable = useDisableScheduledBackups();
  const [cron, setCron] = useState<string>(
    cluster.state?.baseBackupSchedule ?? '0 0 3 * * *',
  );
  // Phase 7c v2 (2026-05-24) — explicit "user picked Custom" state so the
  // text input mounts even when `cron` happens to match a preset value.
  // Without this, selecting "Custom 6-field cron…" did nothing because
  // the select would snap back to the preset on the next render.
  // Browser-walkthrough caught the bug.
  const initialIsCustom = !CRON_PRESETS.find((p) => p.value === (cluster.state?.baseBackupSchedule ?? '0 0 3 * * *'));
  const [customMode, setCustomMode] = useState<boolean>(initialIsCustom);
  const [cronError, setCronError] = useState<string | null>(null);

  const savedCron = cluster.state?.baseBackupSchedule ?? null;
  const hasUnsavedChanges = active && cron !== savedCron;
  const cronValid = isValidCron6(cron);

  // Phase 8 (2026-05-25): same retention-vs-cadence safety check as
  // WAL Streaming section, but evaluated from THIS section's editable
  // cron against the saved retention. Warns operators picking a long
  // cadence when retention isn't long enough to cover 2 × intervals.
  const savedRetention = cluster.state?.retentionDays ?? null;
  const minRetentionForNewCron = minSafeRetentionDays(cron);
  const retentionUnsafe = savedRetention !== null && savedRetention < minRetentionForNewCron;

  const onEnable = (): void => {
    if (!cronValid) {
      setCronError('Must be a 6-field cron (seconds minutes hours dom month dow). Example: 0 0 3 * * *');
      return;
    }
    setCronError(null);
    void enable.mutateAsync({
      clusterNamespace: cluster.clusterNamespace,
      clusterName: cluster.clusterName,
      cron,
    }).catch(() => undefined);
  };
  const onDisable = (): void => {
    if (!window.confirm(
      `Disable scheduled base backups for ${cluster.clusterNamespace}/${cluster.clusterName}? WAL streaming (if enabled) stays on. Existing base backups at the target are kept.`,
    )) return;
    void disable.mutateAsync({
      clusterNamespace: cluster.clusterNamespace,
      clusterName: cluster.clusterName,
    }).catch(() => undefined);
  };

  return (
    <div
      className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/30"
      data-testid={`scheduled-backups-section-${cluster.clusterName}`}
    >
      <SectionHeader
        title="Scheduled Base Backups"
        tooltip="Periodic full Postgres base backups via the CNPG ScheduledBackup CR. Base backups are the foundation for PITR — WAL replay needs a base to replay onto. Without a schedule, you'd need to click 'Backup Now' on the page top whenever you want a fresh base."
        active={active}
      />
      <div className="mt-3 grid grid-cols-1 gap-3 text-xs">
        <Setting label="Cadence">
          <select
            value={customMode ? 'CUSTOM' : (CRON_PRESETS.find((p) => p.value === cron) ? cron : 'CUSTOM')}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'CUSTOM') {
                setCustomMode(true);
                // Keep current cron value as a starting template; user
                // edits it in the text input below.
              } else {
                setCustomMode(false);
                setCron(v);
                setCronError(null);
              }
            }}
            disabled={enable.isPending || disable.isPending}
            className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            data-testid={`schedule-cadence-${cluster.clusterName}`}
          >
            {CRON_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
            <option value="CUSTOM">Custom 6-field cron…</option>
          </select>
          {(customMode || !CRON_PRESETS.find((p) => p.value === cron)) && (
            <>
              <input
                type="text"
                value={cron}
                onChange={(e) => {
                  setCron(e.target.value);
                  if (cronError) setCronError(null);
                }}
                placeholder="0 0 3 * * *"
                aria-invalid={!!cronError || !cronValid}
                className={`mt-1 w-full rounded-lg border bg-white px-2 py-1.5 font-mono text-xs text-gray-900 dark:bg-gray-700 dark:text-gray-100 ${
                  cronError || !cronValid
                    ? 'border-rose-400 dark:border-rose-600'
                    : 'border-gray-300 dark:border-gray-600'
                }`}
                data-testid={`schedule-cadence-custom-${cluster.clusterName}`}
              />
              <p className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
                6 fields: seconds minutes hours dom month dow. Example: <code>0 0 3 * * *</code> = daily 03:00:00.
              </p>
              {cronError && (
                <p className="mt-0.5 text-[10px] text-rose-700 dark:text-rose-300" data-testid={`schedule-cron-error-${cluster.clusterName}`}>
                  {cronError}
                </p>
              )}
            </>
          )}
        </Setting>
        {retentionUnsafe && (
          <div
            className="rounded border border-rose-300 bg-rose-50 p-2 text-[10px] text-rose-800 dark:border-rose-700 dark:bg-rose-900/20 dark:text-rose-200"
            data-testid={`schedule-retention-warning-${cluster.clusterName}`}
          >
            Current retention <strong>{savedRetention}d</strong> is shorter
            than this cadence requires (need ≥{minRetentionForNewCron}d).
            Either pick a shorter cadence or raise retention in the WAL
            Streaming section first — otherwise base backups will be
            deleted before the next one runs (no DR).
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {enable.isError && (
          <span className="mr-auto flex items-center gap-1 text-xs text-rose-700 dark:text-rose-300">
            <AlertCircle size={12} />{(enable.error as Error).message}
          </span>
        )}
        {disable.isError && (
          <span className="mr-auto flex items-center gap-1 text-xs text-rose-700 dark:text-rose-300">
            <AlertCircle size={12} />{(disable.error as Error).message}
          </span>
        )}
        {active ? (
          <>
            <button
              type="button"
              onClick={onEnable}
              disabled={!hasUnsavedChanges || enable.isPending || !cronValid || retentionUnsafe}
              className="inline-flex items-center gap-1 rounded-md border border-brand-300 px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-600 dark:text-brand-300 dark:hover:bg-brand-900/30"
              data-testid={`schedule-save-${cluster.clusterName}`}
            >
              {enable.isPending ? <RefreshCw size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              Save changes
            </button>
            <button
              type="button"
              onClick={onDisable}
              disabled={disable.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              data-testid={`schedule-disable-${cluster.clusterName}`}
            >
              {disable.isPending ? <RefreshCw size={12} className="animate-spin" /> : <PowerOff size={12} />}
              Disable Scheduled Backups
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onEnable}
            disabled={!canEnable || enable.isPending || !cronValid || retentionUnsafe}
            title={!canEnable ? 'Bind a SYSTEM target on the Routing tab first.' : ''}
            className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            data-testid={`schedule-enable-${cluster.clusterName}`}
          >
            {enable.isPending ? <RefreshCw size={12} className="animate-spin" /> : <Power size={12} />}
            Enable Scheduled Backups
          </button>
        )}
      </div>
    </div>
  );
}

// ── Status panel (read-only) ───────────────────────────────────────

function StatusPanel({ cluster }: { cluster: WalArchiveCluster }) {
  const archivingHealthy = cluster.status?.lastArchivedWalTime
    && !cluster.status?.lastFailedArchiveTime;
  const archivingSinceLabel = cluster.status?.lastArchivedWalTime
    ? `${new Date(cluster.status.lastArchivedWalTime).toLocaleString()} (${formatAgoFromIso(cluster.status.lastArchivedWalTime)} ago)`
    : '—';

  // Fallback for the "first recoverability point" cell when CNPG hasn't
  // populated cluster.status.firstRecoverabilityPoint (lags by minutes
  // after a fresh enable or CR churn). The barman catalogue IS the
  // authoritative listing of what's actually upstream — use the
  // earliest catalogue entry's startedAt as the recoverability floor.
  const recovFallback = useRecoverabilityFallback(cluster);

  const firstRecoverabilityValue = cluster.status?.firstRecoverabilityPoint
    ?? recovFallback.earliestStartedAt;
  const firstRecoverabilitySource = cluster.status?.firstRecoverabilityPoint
    ? 'cnpg'
    : (recovFallback.earliestStartedAt ? 'catalogue' : 'none');

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-700 dark:bg-gray-900/30">
      <SectionHeader title="Cluster archiver status" tooltip={null} />
      <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
        <Field label="Continuous archiving since">
          {archivingHealthy ? archivingSinceLabel : (cluster.status?.lastArchivedWalTime ? 'unhealthy' : 'not archiving')}
        </Field>
        <Field label="First recoverability point">
          {firstRecoverabilityValue ? (
            <span
              title={
                firstRecoverabilitySource === 'cnpg'
                  ? 'Reported by CNPG (cluster.status.firstRecoverabilityPoint).'
                  : `CNPG's status field is null (lag after recent enable / CR churn). Falling back to the earliest entry in the barman catalogue (${recovFallback.count} backups visible). The actual recoverability floor is whatever's in the catalogue, regardless of CNPG's status lag.`
              }
            >
              {new Date(firstRecoverabilityValue).toLocaleString()}
              {firstRecoverabilitySource === 'catalogue' && (
                <span className="ml-1 text-[10px] text-gray-500 dark:text-gray-400">
                  (from catalogue · {recovFallback.count} backups)
                </span>
              )}
            </span>
          ) : recovFallback.state === 'loading' ? (
            <span className="italic text-gray-500">checking catalogue…</span>
          ) : (
            <span
              className="italic text-gray-500"
              title="No backups visible yet — neither CNPG's status nor the barman catalogue has an entry. Run 'Backup Now' on the page top to seed the archive."
            >
              no backups yet
            </span>
          )}
        </Field>
        {cluster.state?.baseBackupStatus?.lastScheduleTime && (
          <Field label="Last scheduled backup">
            {new Date(cluster.state.baseBackupStatus.lastScheduleTime).toLocaleString()}
          </Field>
        )}
        {cluster.state?.baseBackupStatus?.nextScheduleTime && (
          <Field label="Next scheduled backup">
            {new Date(cluster.state.baseBackupStatus.nextScheduleTime).toLocaleString()}
          </Field>
        )}
      </div>
      {cluster.status?.lastFailedArchiveError && (
        <div className="mt-2 rounded border border-rose-300 bg-rose-50 p-2 text-rose-800 dark:border-rose-700 dark:bg-rose-900/20 dark:text-rose-200">
          <div className="font-medium">Last archive error:</div>
          <div className="mt-0.5 break-all font-mono">{cluster.status.lastFailedArchiveError}</div>
          {cluster.status.lastFailedArchiveTime && (
            <div className="mt-0.5 text-rose-700 dark:text-rose-300">
              at {new Date(cluster.status.lastFailedArchiveTime).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Small primitives ───────────────────────────────────────────────

function SectionHeader({
  title, tooltip, active,
}: {
  title: string;
  tooltip: string | null;
  active?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</h4>
      {tooltip && (
        <span className="group relative inline-flex" aria-describedby={`tt-${title}`}>
          <Info size={12} className="cursor-help text-gray-400 hover:text-gray-600" />
          <span
            role="tooltip"
            id={`tt-${title}`}
            className="pointer-events-none absolute left-5 top-0 z-10 hidden w-72 rounded border border-gray-300 bg-white p-2 text-xs font-normal text-gray-700 shadow-lg group-hover:block dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
          >
            {tooltip}
          </span>
        </span>
      )}
      {active !== undefined && (
        active ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
            <CheckCircle2 size={10} /> enabled
          </span>
        ) : (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
            <PauseCircle size={10} /> disabled
          </span>
        )
      )}
    </div>
  );
}

function TargetBoundIndicator({
  name, storageType, bound,
}: {
  name: string | null;
  storageType: string | null;
  bound: boolean;
}) {
  if (!bound) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
        <Cloud size={10} /> no SYSTEM target bound
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-900/40 dark:text-gray-300"
      data-testid="wal-target-bound"
    >
      <Cloud size={10} />
      <span className="font-mono">{name}</span>
      <span className="ml-1 rounded bg-gray-200 px-1 py-0 text-[10px] font-normal dark:bg-gray-700">
        {(storageType ?? '?').toUpperCase()}
      </span>
      <Link
        to="/backups/system?tab=routing"
        className="ml-1 inline-flex items-center gap-0.5 text-brand-600 hover:underline dark:text-brand-300"
        title="Change target on the Routing tab"
      >
        <LinkIcon size={9} />
      </Link>
    </span>
  );
}

function Setting({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-gray-600 dark:text-gray-400">{label}</span>
      {children}
    </label>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-gray-500 dark:text-gray-400">{label}:</span>
      <span className="truncate text-right font-mono text-gray-900 dark:text-gray-100">{children}</span>
    </div>
  );
}

function formatAgoFromIso(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'unknown';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Phase 8d (2026-05-25): when CNPG's `cluster.status.firstRecoverabilityPoint`
 * is null (typical lag after fresh enable / CR churn / cluster restart),
 * fall back to the barman catalogue's earliest entry. The barman archive
 * is the ACTUAL source of truth — CNPG's status is just a projection it
 * builds by reading the catalog via its plugin sidecar.
 *
 * Steps:
 *   1. Find the cluster's ObjectStore name via the cnpg-backup-health
 *      endpoint (same data the HealthCard uses).
 *   2. Fetch the catalogue via cnpg-backup-catalogue/:ns/:objectStore.
 *      Same queryKey as SystemBackupListSection + the HealthCard's
 *      BackupSizeTotal → TanStack Query dedups, no extra fetch.
 *   3. Return the earliest entry's startedAt + the total count.
 *
 * Returns null when no backups exist OR catalogue is unavailable.
 */
function useRecoverabilityFallback(cluster: WalArchiveCluster): {
  earliestStartedAt: string | null;
  count: number;
  /**
   * 'loading' = either health OR catalogue query still in flight; the
   * UI MUST NOT show "no backups yet" during loading because that
   * misleads operators when the catalogue is about to arrive with N
   * entries. 'ready' = the underlying queries have settled and the
   * returned counts/dates reflect actual state.
   */
  state: 'loading' | 'ready';
} {
  const { data: healthResp, isLoading: healthLoading } = useCnpgBackupHealth();
  const healthRow = healthResp?.data?.find(
    (c) => c.namespace === cluster.clusterNamespace && c.clusterName === cluster.clusterName,
  );
  const objectStoreName = healthRow?.objectStoreName ?? null;

  const catalogueQ = useQuery({
    queryKey: ['cnpg-backup-catalogue', cluster.clusterNamespace, objectStoreName],
    queryFn: () =>
      apiFetch<{ data: CnpgBackupCatalogueResponse }>(
        `/api/v1/admin/cnpg-backup-catalogue/${encodeURIComponent(cluster.clusterNamespace)}/${encodeURIComponent(objectStoreName ?? '')}`,
      ),
    staleTime: 60_000,
    retry: false,
    enabled: !!objectStoreName,
  });

  // While health is fetching OR objectStoreName is known but catalogue
  // is still in flight, we don't yet know whether the archive is empty.
  // Surface as 'loading' so the UI shows a spinner-equivalent string
  // instead of the misleading "no backups yet" empty-state.
  const loading = healthLoading || (objectStoreName !== null && catalogueQ.isLoading);

  const cat = catalogueQ.data?.data;
  if (!cat || cat.source !== 'object-store' || cat.backups.length === 0) {
    return { earliestStartedAt: null, count: 0, state: loading ? 'loading' : 'ready' };
  }
  // Sort by startedAt ascending; first entry is the floor.
  const sorted = [...cat.backups].sort((a, b) => {
    const at = a.startedAt ?? a.uploadedAt ?? '';
    const bt = b.startedAt ?? b.uploadedAt ?? '';
    return at.localeCompare(bt);
  });
  const earliest = sorted[0];
  return {
    earliestStartedAt: earliest.startedAt ?? earliest.uploadedAt ?? null,
    count: cat.backups.length,
    state: 'ready',
  };
}
