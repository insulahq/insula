/**
 * WAL Archive tab — Phase 4 of System Backup.
 *
 * Phase 6 (2026-05-24) rewrite:
 *  - WAL streaming target = SYSTEM shim binding (read-only, picked on
 *    Routing tab). No per-cluster target picker; the operator picks
 *    the target ONCE for all SYSTEM backups.
 *  - All upstream storage types (S3 / CIFS / NFS / SFTP) work — the
 *    shim handles upstream translation; barman-cloud always writes to
 *    the shim's local S3 endpoint.
 *  - Cron validation on the base-backup custom-cron input.
 *  - Vestigial `baseBackupRetentionDays` field removed (was stored in
 *    DB but never applied to any CR).
 */

import { useState } from 'react';
import { ArchiveRestore, RefreshCw, AlertCircle, CheckCircle2, Power, PowerOff, Copy, Cloud, Link as LinkIcon, PauseCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  useWalArchiveClusters,
  useEnableWalArchive,
  useDisableWalArchive,
} from '@/hooks/use-system-wal-archive';
import { useShimAssignments } from '@/hooks/use-backup-rclone-shim';
import type { WalArchiveCluster } from '@k8s-hosting/api-contracts';

export default function WalArchiveTab() {
  const clustersQ = useWalArchiveClusters();
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          <ArchiveRestore size={20} /> WAL Archive
        </h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Continuous Postgres WAL streaming to the SYSTEM backup target
          configured under{' '}
          <Link to="/backups/system?tab=routing" className="font-medium text-brand-600 hover:underline dark:text-brand-300">
            Routing
          </Link>. RPO ≈ archive_timeout (configurable per cluster). All
          upstream storage types (S3 / CIFS / NFS / SFTP) are supported —
          barman-cloud writes go through the internal S3 shim regardless
          of upstream protocol.
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

// Preset 6-field cron strings. Custom value lets advanced operators
// type any 6-field cron. See CNPG ScheduledBackup docs.
const SCHEDULE_PRESETS: Array<{ value: string; label: string }> = [
  { value: '',                  label: 'No base backup (WAL only)' },
  { value: '0 0 */6 * * *',     label: 'Every 6 hours' },
  { value: '0 0 3 * * *',       label: 'Daily at 03:00' },
  { value: '0 0 3 * * 0',       label: 'Weekly Sun 03:00' },
  { value: '0 0 3 1 * *',       label: 'Monthly 1st 03:00' },
];

const ARCHIVE_TIMEOUT_PRESETS: Array<{ value: string; label: string }> = [
  { value: '30s',   label: '30 sec (RPO ~30s)' },
  { value: '1min',  label: '1 min (RPO ~1m)' },
  { value: '5min',  label: '5 min (CNPG default)' },
  { value: '15min', label: '15 min' },
  { value: '1h',    label: '1 hour' },
];

// 6-field cron validation: matches CNPG's robfig/cron/v3 parser. Each
// field must be a non-whitespace token; exactly 6 fields separated by
// runs of whitespace. The backend's baseBackupScheduleSchema applies
// the SAME regex (packages/api-contracts/src/system-wal-archive.ts).
const CRON6_RE = /^(\S+\s+){5}\S+$/;
function isValidCron6(s: string): boolean {
  return CRON6_RE.test(s.trim());
}

function ClusterCard({ cluster }: { cluster: WalArchiveCluster }) {
  const enable = useEnableWalArchive();
  const disable = useDisableWalArchive();
  // Phase 6: read SYSTEM shim binding. The WAL streaming target IS
  // this binding — no separate per-cluster picker.
  const { data: assignResp } = useShimAssignments();
  const systemAssignment = assignResp?.data?.assignments?.find((a) => a.className === 'system');
  const systemTargetBound = !!systemAssignment?.targetId;

  const [retention, setRetention] = useState<number>(cluster.state?.retentionDays ?? 30);
  const [archiveTimeout, setArchiveTimeout] = useState<string>(cluster.state?.archiveTimeout ?? '5min');
  const [baseSchedule, setBaseSchedule] = useState<string>(cluster.state?.baseBackupSchedule ?? '0 0 3 * * *');
  const [cronError, setCronError] = useState<string | null>(null);

  const onEnable = (): void => {
    // Frontend validation: 6-field cron OR empty (= no base backup).
    // Empty stays valid; non-empty must parse.
    if (baseSchedule && !isValidCron6(baseSchedule)) {
      setCronError('Must be a 6-field cron (seconds minutes hours dom month dow). Example: 0 0 3 * * *');
      return;
    }
    setCronError(null);
    void (async () => {
      try {
        await enable.mutateAsync({
          clusterNamespace: cluster.clusterNamespace,
          clusterName: cluster.clusterName,
          retentionDays: retention,
          archiveTimeout,
          baseBackupSchedule: baseSchedule || null,
        });
      } catch { /* error surfaced via mutation state */ }
    })();
  };

  const onDisable = (): void => {
    if (!confirm(`Disable WAL archive for ${cluster.clusterNamespace}/${cluster.clusterName}? Existing WAL files at the target are kept (CNPG retention only deletes them at the configured retention).`)) return;
    void (async () => {
      try {
        await disable.mutateAsync({
          clusterNamespace: cluster.clusterNamespace,
          clusterName: cluster.clusterName,
        });
      } catch { /* error surfaced via mutation state */ }
    })();
  };

  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100">
            {cluster.clusterNamespace}/{cluster.clusterName}
          </h3>
          <EnabledBadge enabled={cluster.enabled} />
        </div>
        {cluster.enabled ? (
          <button
            onClick={onDisable}
            disabled={disable.isPending}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700 disabled:opacity-50"
            data-testid={`wal-disable-${cluster.clusterName}`}
          >
            {disable.isPending ? <RefreshCw size={12} className="animate-spin" /> : <PowerOff size={12} />}
            Disable
          </button>
        ) : null}
      </div>

      {!cluster.enabled && (
        <div className="space-y-3">
          {/* Phase 6: read-only display of the SYSTEM shim binding.
              No picker — operator changes the target on Routing tab. */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs">
                <Cloud size={12} className="text-gray-500" />
                <span className="text-gray-500 dark:text-gray-400">WAL target (from SYSTEM binding):</span>
                {systemTargetBound ? (
                  <span className="font-mono font-medium text-gray-900 dark:text-gray-100" data-testid={`wal-target-display-${cluster.clusterName}`}>
                    {systemAssignment?.targetName ?? systemAssignment?.targetId}{' '}
                    <span className="rounded bg-gray-200 px-1 py-0.5 text-[10px] font-normal dark:bg-gray-700">
                      {(systemAssignment?.targetStorageType ?? '?').toString().toUpperCase()}
                    </span>
                  </span>
                ) : (
                  <span className="italic text-amber-700 dark:text-amber-300">no SYSTEM target bound</span>
                )}
              </div>
              <Link
                to="/backups/system?tab=routing"
                className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-300"
              >
                <LinkIcon size={10} /> Change on Routing
              </Link>
            </div>
            {!systemTargetBound && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                Bind a target for the SYSTEM class before enabling WAL streaming.
                The shim accepts any upstream storage type — S3, CIFS, NFS, or SFTP.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <Setting label="archive_timeout (RPO)">
              <select
                value={archiveTimeout}
                onChange={(e) => setArchiveTimeout(e.target.value)}
                className="w-full text-sm rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                data-testid={`wal-archive-timeout-${cluster.clusterName}`}
              >
                {ARCHIVE_TIMEOUT_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </Setting>
            <Setting label="Retention (days, applies to both WAL + base backups)">
              <input
                type="number"
                min={1}
                max={3650}
                value={retention}
                onChange={(e) => setRetention(parseInt(e.target.value, 10) || 30)}
                className="w-full text-sm rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                data-testid={`wal-retention-${cluster.clusterName}`}
              />
            </Setting>
            <Setting label="Base backup cadence">
              <select
                value={SCHEDULE_PRESETS.find((p) => p.value === baseSchedule) ? baseSchedule : 'CUSTOM'}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v !== 'CUSTOM') {
                    setBaseSchedule(v);
                    setCronError(null);
                  }
                }}
                className="w-full text-sm rounded-lg border border-gray-300 dark:border-gray-600 px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                data-testid={`wal-base-cadence-${cluster.clusterName}`}
              >
                {SCHEDULE_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
                <option value="CUSTOM">Custom 6-field cron…</option>
              </select>
              {!SCHEDULE_PRESETS.find((p) => p.value === baseSchedule) && (
                <>
                  <input
                    type="text"
                    value={baseSchedule}
                    onChange={(e) => {
                      setBaseSchedule(e.target.value);
                      if (cronError) setCronError(null);
                    }}
                    placeholder="0 0 3 * * *"
                    aria-invalid={!!cronError || (!!baseSchedule && !isValidCron6(baseSchedule))}
                    className={`mt-1 w-full font-mono text-xs rounded-lg border px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 ${
                      cronError || (baseSchedule && !isValidCron6(baseSchedule))
                        ? 'border-rose-400 dark:border-rose-600'
                        : 'border-gray-300 dark:border-gray-600'
                    }`}
                    data-testid={`wal-base-cadence-custom-${cluster.clusterName}`}
                  />
                  <p className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
                    6 fields: seconds minutes hours dom month dow. Example: <code>0 0 3 * * *</code> = daily 03:00:00.
                  </p>
                  {cronError && (
                    <p className="mt-0.5 text-[10px] text-rose-700 dark:text-rose-300" data-testid={`wal-cron-error-${cluster.clusterName}`}>
                      {cronError}
                    </p>
                  )}
                </>
              )}
            </Setting>
            <div className="md:col-span-2 flex justify-end pt-1">
              <button
                onClick={onEnable}
                disabled={enable.isPending || !systemTargetBound || (!!baseSchedule && !isValidCron6(baseSchedule))}
                className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-brand-600 text-white text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
                data-testid={`wal-enable-${cluster.clusterName}`}
              >
                {enable.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Power size={14} />}
                Enable WAL archive
              </button>
            </div>
          </div>
        </div>
      )}
      {(enable.isError || disable.isError) && (
        <div className="text-xs text-red-700 dark:text-red-300 flex items-center gap-1">
          <AlertCircle size={12} />
          {((enable.error || disable.error) as Error).message}
        </div>
      )}
      {cluster.enabled && cluster.state && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <Field label="Target">{cluster.state.targetName ?? cluster.state.targetConfigId.slice(0, 8) + '…'}</Field>
          <Field label="WAL retention">{cluster.state.retentionDays} days</Field>
          <FieldCopy label="Destination" value={cluster.state.destinationPath} />
          <Field label="archive_timeout">{cluster.state.archiveTimeout ?? 'CNPG default (5min)'}</Field>
          <Field label="Base backups">
            {cluster.state.baseBackupSchedule
              ? `every ${cluster.state.baseBackupSchedule}`
              : 'not scheduled'}
          </Field>
          {cluster.state.baseBackupStatus && (
            <Field label="Last base backup">
              {cluster.state.baseBackupStatus.lastScheduleTime
                ? new Date(cluster.state.baseBackupStatus.lastScheduleTime).toLocaleString()
                : 'pending first run'}
            </Field>
          )}
          {cluster.state.baseBackupStatus?.nextScheduleTime && (
            <Field label="Next base backup">
              {new Date(cluster.state.baseBackupStatus.nextScheduleTime).toLocaleString()}
            </Field>
          )}
          <Field label="Enabled">{new Date(cluster.state.enabledAt).toLocaleString()}</Field>
        </div>
      )}
      {cluster.status && cluster.enabled && (
        <ArchiverStatus status={cluster.status} />
      )}
    </section>
  );
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
      <CheckCircle2 size={12} /> archiving
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300">
      <PauseCircle size={12} /> off
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
      <span className="text-gray-900 dark:text-gray-100 font-mono text-right truncate">{children}</span>
    </div>
  );
}

function FieldCopy({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex justify-between gap-2">
      <span className="text-gray-500 dark:text-gray-400">{label}:</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
        className="inline-flex items-center gap-1 text-gray-900 dark:text-gray-100 font-mono truncate hover:text-brand-600"
        title={value}
      >
        <span className="truncate">{value}</span>
        <Copy size={10} className={copied ? 'text-green-500' : ''} />
      </button>
    </div>
  );
}

function ArchiverStatus({ status }: { status: NonNullable<WalArchiveCluster['status']> }) {
  const failing = !!status.lastFailedArchiveError;
  return (
    <div className={`mt-3 rounded-lg border p-3 text-xs space-y-1 ${
      failing
        ? 'border-red-300 dark:border-red-700 bg-red-50/50 dark:bg-red-900/20'
        : 'border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/20'
    }`}>
      <div className="font-medium text-gray-700 dark:text-gray-300">CNPG archiver status</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-0.5">
        <Field label="Last archived WAL">{status.lastArchivedWal ?? 'none yet'}</Field>
        <Field label="Last archived at">{status.lastArchivedWalTime ? new Date(status.lastArchivedWalTime).toLocaleString() : '—'}</Field>
        <Field label="First recoverability">{status.firstRecoverabilityPoint ?? '—'}</Field>
        <Field label="Last failure at">{status.lastFailedArchiveTime ? new Date(status.lastFailedArchiveTime).toLocaleString() : '—'}</Field>
      </div>
      {failing && status.lastFailedArchiveError && (
        <div className="mt-2 text-red-700 dark:text-red-300 font-mono break-all">
          {status.lastFailedArchiveError}
        </div>
      )}
    </div>
  );
}
