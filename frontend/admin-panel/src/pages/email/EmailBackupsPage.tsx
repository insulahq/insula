import { useState } from 'react';
import {
  Archive, AlertTriangle, RotateCcw, Loader2, CheckCircle2, X, Info, ExternalLink,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import EmailPageHeader from '@/components/email/EmailPageHeader';
import MailSectionCard from '@/components/MailSectionCard';
import MailMigrationProgressModal from '@/components/MailMigrationProgressModal';
import { useMailBackups, useRestoreMailBackup } from '@/hooks/use-mail-backups';
import { useMailPlacement } from '@/hooks/use-mail-placement';
import type { MailBackupSnapshot } from '@k8s-hosting/api-contracts';

/**
 * Email → Offsite Backups (restic snapshots).
 *
 * Operator-facing surface for the mail data backed up to the offsite
 * BackupTarget by the stalwart-snapshot CronJob. Distinct from the
 * rsync standby replication (which is live, in-cluster, for fast
 * failover) — this page is for point-in-time recovery beyond what
 * standby provides.
 *
 * NOTE 2026-05-27 iteration 1: per-snapshot Restore reuses the mail
 * migration state machine but does NOT yet plumb the chosen snapshot
 * ID to the restore-state init container — every restore today
 * uses restic-latest (most recent snapshot). The UI calls this out
 * explicitly so the operator isn't surprised. Iteration 2 will add
 * the snapshot-ID plumbing.
 */
export default function EmailBackupsPage() {
  const { data, isLoading, error, refetch, isRefetching } = useMailBackups();
  const placement = useMailPlacement();
  const [restoreModal, setRestoreModal] = useState<MailBackupSnapshot | null>(null);
  const [progressRunId, setProgressRunId] = useState<string | null>(null);

  const result = data?.data;
  const snapshots = result?.snapshots ?? [];

  return (
    <div className="space-y-6">
      <EmailPageHeader subtitle="Offsite mail backups (restic) — point-in-time inspection + restore." />

      <MailSectionCard
        icon={Archive}
        title="Offsite mail backups (restic)"
        summary={result?.targetName
          ? `Target: ${result.targetName} • ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}`
          : 'No mail BackupTarget configured'}
        dataTestId="mail-backups-section"
        storageKey="mail-backups"
        defaultOpen
      >
        <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-3 py-2.5 text-xs text-blue-800 dark:text-blue-200 flex items-start gap-2">
          <Info size={14} className="mt-0.5 shrink-0" />
          <div>
            <strong>Distinct from rsync standby.</strong> The standby DaemonSet pre-stages
            live mail data on standby-labelled nodes for sub-second failover (always
            current). Restic snapshots are the OFFSITE point-in-time history (older
            retention; configurable at /backups/mail → Schedule). Use this page when
            you need to roll back hours/days of damage, not for routine failover.
          </div>
        </div>

        {!result?.targetName && (
          <EmptyTargetState />
        )}

        {result?.targetName && !result.repoReachable && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200 flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>{result.reason ?? 'Restic repo not reachable.'}</div>
          </div>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-gray-500">
            <Loader2 size={14} className="animate-spin" /> Listing snapshots (spawns one-shot restic Pod, ~5s)...
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
            Failed to load: {(error as Error).message}
          </div>
        )}

        {result?.repoReachable && snapshots.length === 0 && (
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2.5 text-sm text-emerald-800 dark:text-emerald-200">
            Restic repo reachable but no snapshots yet. The stalwart-snapshot CronJob
            fires every 2 min — first snapshot should appear shortly.
          </div>
        )}

        {result?.repoReachable && snapshots.length > 0 && (
          <>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setRestoreModal(snapshots[0])}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40"
                data-testid="backup-restore-latest"
              >
                <AlertTriangle size={12} /> Restore latest snapshot...
              </button>
              <button
                type="button"
                onClick={() => refetch()}
                disabled={isRefetching}
                className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
              >
                {isRefetching ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                Refresh
              </button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Per-snapshot selection is not yet wired through to the restore-state
              init container — every restore today uses the most recent snapshot
              (top of the list). Per-snapshot picker ships in iteration 2.
            </p>
            <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900 text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  <tr>
                    <th className="px-3 py-2 text-left">Snapshot</th>
                    <th className="px-3 py-2 text-left">Time</th>
                    <th className="px-3 py-2 text-left">Size</th>
                    <th className="px-3 py-2 text-left">Tags</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {snapshots.map((s, idx) => (
                    <tr
                      key={s.shortId}
                      className={idx === 0 ? 'bg-amber-50 dark:bg-amber-900/10' : 'bg-white dark:bg-gray-800'}
                      title={idx === 0 ? 'Most recent — this is what Restore latest will use' : undefined}
                    >
                      <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-300">
                        {s.id}{idx === 0 ? ' (latest)' : ''}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
                        {new Date(s.time).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
                        {s.sizeBytes != null ? formatBytes(s.sizeBytes) : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-500">
                        {s.tags.join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </MailSectionCard>

      {restoreModal && (
        <RestoreModal
          snapshot={restoreModal}
          defaultTargetNode={placement.data?.data.primaryNode ?? ''}
          onClose={() => setRestoreModal(null)}
          onStarted={(runId) => {
            setRestoreModal(null);
            setProgressRunId(runId);
          }}
        />
      )}
      {progressRunId && (
        <MailMigrationProgressModal
          runId={progressRunId}
          onClose={() => setProgressRunId(null)}
        />
      )}
    </div>
  );
}

function EmptyTargetState() {
  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-3 text-sm text-amber-800 dark:text-amber-200 space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div>
          <strong>No mail BackupTarget configured.</strong> Snapshots cannot be
          taken or listed without one. The pre-migration backup step is also
          skipped when no target exists — migration restore is via in-cluster
          rsync standby, not restic.
        </div>
      </div>
      <Link
        to="/backups/mail"
        className="inline-flex items-center gap-1 text-xs font-medium text-amber-900 dark:text-amber-300 underline"
      >
        Configure at /backups/mail → Targets <ExternalLink size={10} />
      </Link>
    </div>
  );
}

function RestoreModal({ snapshot, defaultTargetNode, onClose, onStarted }: {
  readonly snapshot: MailBackupSnapshot;
  readonly defaultTargetNode: string;
  readonly onClose: () => void;
  readonly onStarted: (runId: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [targetNode, setTargetNode] = useState(defaultTargetNode);
  const restore = useRestoreMailBackup();

  const handleRun = async () => {
    try {
      const r = await restore.mutateAsync({
        shortId: snapshot.id,
        confirmShortId: snapshot.id,
        targetNode,
      });
      onStarted(r.data.runId);
    } catch {
      // surfaced via restore.isError
    }
  };

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid={`backup-restore-modal-${snapshot.id}`}
    >
      <div
        className="w-full max-w-xl rounded-xl bg-white dark:bg-gray-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-6 py-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <AlertTriangle size={18} className="text-red-500" />
            Restore latest mail backup
          </h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-800 dark:text-red-200 flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <strong>This is destructive.</strong> Restoring replaces the live mail
              data with the most recent snapshot. Any mail received AFTER the
              snapshot time will be PERMANENTLY LOST.
            </div>
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Restoring from</label>
            <div className="font-mono text-sm text-gray-900 dark:text-gray-100">{snapshot.id} (latest)</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {new Date(snapshot.time).toLocaleString()} {snapshot.sizeBytes != null ? `• ${formatBytes(snapshot.sizeBytes)}` : ''}
            </div>
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Target node</label>
            <input
              type="text"
              value={targetNode}
              onChange={(e) => setTargetNode(e.target.value)}
              placeholder="e.g. staging1, worker"
              className="block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500"
              data-testid="backup-restore-target-input"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Defaults to primary mail node ({defaultTargetNode || 'unset — set placement at Email → Operations'}).
              Must have the <code className="font-mono">mail-standby=true</code> label OR
              backup-rclone-shim must be reachable from it (preflight enforces this).
            </p>
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
              Type <code className="font-mono px-1 rounded bg-gray-100 dark:bg-gray-700">{snapshot.id}</code> to confirm
            </label>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500"
              data-testid="backup-restore-confirm-input"
            />
          </div>

          {restore.isError && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
              Restore failed: {(restore.error as Error).message}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRun}
              disabled={typed !== snapshot.id || !targetNode || restore.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="backup-restore-run"
            >
              {restore.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {restore.isPending ? 'Starting…' : 'Restore'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatBytes(b: number): string {
  if (b === 0) return '0 B';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(2)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KiB`;
  return `${b} B`;
}
