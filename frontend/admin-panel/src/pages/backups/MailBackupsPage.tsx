/**
 * `/backups/mail` — Mail backup-class page.
 *
 * Architecture: the `stalwart-snapshot` CronJob writes a restic snapshot
 * of /var/lib/mail-stack/ to the bound BackupTarget every 2 min. This
 * page is the operator surface for:
 *
 *   1. Reviewing recent snapshots (size, age, restic short id)
 *   2. Triggering a point-in-time restore back to a chosen target node
 *
 * NOT to be confused with /email/operations → Backups tab, which drives
 * the separate `stalwart -e` logical-export pipeline (mail-archive). The
 * two pipelines are completely independent.
 *
 * Mechanism: the per-snapshot restore reuses the mail-migration state
 * machine with skipFreshSnapshot=true and restoreSnapshotId=<shortId>
 * stamped on the Stalwart pod template. The restore-state init container
 * reads the annotation via downwardAPI and runs `restic restore <id>`
 * (or `latest` when the annotation is absent — the default failover path).
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, RotateCw, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  MailBackupSnapshot,
  SystemBackupsOverview,
} from '@k8s-hosting/api-contracts';
import BackupClassPage from './BackupClassPage';
import MailObjectBackupCard from '@/components/backups/MailObjectBackupCard';
import { useMailBackups, useRestoreMailBackup } from '@/hooks/use-mail-backups';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import { useMailPlacement } from '@/hooks/use-mail-placement';
import MailMigrationProgressModal from '@/components/MailMigrationProgressModal';

function useSystemOverview() {
  return useQuery({
    queryKey: ['admin', 'backups', 'system', 'overview'],
    queryFn: () =>
      apiFetch<{ data: SystemBackupsOverview }>(
        '/api/v1/admin/backups/system/overview',
      ),
    staleTime: 15_000,
  });
}

function formatBytes(b: number | null | undefined): string {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KiB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MiB`;
  return `${(b / 1024 ** 3).toFixed(2)} GiB`;
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

interface RestoreDialogProps {
  readonly snapshot: MailBackupSnapshot;
  readonly defaultTargetNode: string | null;
  readonly availableNodes: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onStarted: (runId: string) => void;
}

function RestoreDialog({
  snapshot,
  defaultTargetNode,
  availableNodes,
  onClose,
  onStarted,
}: RestoreDialogProps) {
  const [targetNode, setTargetNode] = useState(
    defaultTargetNode ?? availableNodes[0] ?? '',
  );
  const [confirmShortId, setConfirmShortId] = useState('');
  const restore = useRestoreMailBackup();
  const canSubmit =
    targetNode.length > 0 &&
    confirmShortId === snapshot.shortId &&
    !restore.isPending;

  const submit = async () => {
    try {
      const res = await restore.mutateAsync({
        shortId: snapshot.shortId,
        targetNode,
        confirmShortId,
      });
      onStarted(res.data.runId);
    } catch {
      // surface in UI below
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl dark:bg-gray-800">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Restore mail-stack from snapshot
        </h2>
        <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              This is a destructive operation. The current Stalwart DataStore
              (mail messages, indexes, ACLs) will be overwritten with the
              chosen snapshot. There is no undo. Bulwark webmail is restarted
              alongside Stalwart. Expected downtime: 1-5 minutes.
            </span>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="font-medium text-gray-600 dark:text-gray-400">
            Snapshot
          </dt>
          <dd className="font-mono text-gray-900 dark:text-gray-100">
            {snapshot.shortId}
          </dd>
          <dt className="font-medium text-gray-600 dark:text-gray-400">
            Taken
          </dt>
          <dd className="text-gray-900 dark:text-gray-100">
            {new Date(snapshot.time).toISOString()} ({formatAgo(snapshot.time)})
          </dd>
          <dt className="font-medium text-gray-600 dark:text-gray-400">
            Size
          </dt>
          <dd className="text-gray-900 dark:text-gray-100">
            {formatBytes(snapshot.sizeBytes)}
          </dd>
        </dl>

        <label className="mt-4 block text-sm">
          <span className="font-medium text-gray-700 dark:text-gray-300">
            Target node
          </span>
          <select
            className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900"
            value={targetNode}
            onChange={(e) => setTargetNode(e.target.value)}
            disabled={restore.isPending}
          >
            {availableNodes.map((n) => (
              <option key={n} value={n}>
                {n}
                {n === defaultTargetNode ? ' (current mail node)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-4 block text-sm">
          <span className="font-medium text-gray-700 dark:text-gray-300">
            Type the snapshot id{' '}
            <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs dark:bg-gray-700">
              {snapshot.shortId}
            </code>{' '}
            to confirm
          </span>
          <input
            type="text"
            className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-gray-600 dark:bg-gray-900"
            value={confirmShortId}
            onChange={(e) => setConfirmShortId(e.target.value)}
            disabled={restore.isPending}
            placeholder={snapshot.shortId}
            autoComplete="off"
          />
        </label>

        {restore.isError && (
          <div className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200">
            {(restore.error as Error).message}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={restore.isPending}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {restore.isPending && <Loader2 size={14} className="animate-spin" />}
            Restore from this snapshot
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MailBackupsPage() {
  const { data: ov, isLoading: ovLoading } = useSystemOverview();
  const overview = ov?.data;
  const m = overview?.objectBackups.mail;
  const targetName = m?.targetName ?? null;

  const backups = useMailBackups();
  const nodes = useClusterNodes();
  const placement = useMailPlacement();
  const navigate = useNavigate();
  const [dialogSnapshot, setDialogSnapshot] = useState<MailBackupSnapshot | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  const availableNodes = useMemo(
    () =>
      (nodes.data?.data ?? [])
        .filter((n) => {
          const ready = (n.statusConditions ?? []).find((c) => c.type === 'Ready');
          return ready?.status === 'True' && !n.cordoned;
        })
        .map((n) => n.name),
    [nodes.data],
  );

  const defaultTargetNode = useMemo(() => {
    // Prefer the current mail-stack node, falling back to the operator-
    // configured primary so a recovery restore doesn't accidentally
    // land on whatever node happens to be first in the cluster list.
    const cur = placement.data?.data.activeNode ?? null;
    if (cur && availableNodes.includes(cur)) return cur;
    const primary = placement.data?.data.primaryNode ?? null;
    if (primary && availableNodes.includes(primary)) return primary;
    return availableNodes[0] ?? null;
  }, [availableNodes, placement.data]);

  const snapshots = backups.data?.data.snapshots ?? [];
  const repoReachable = backups.data?.data.repoReachable ?? false;

  return (
    <>
      <BackupClassPage
        icon={Mail}
        title="Mail Backups"
        subtitle="Stalwart RocksDB restic uploads to the bound off-site target. Mail has no in-cluster snapshot path — restic IS the backup, written straight to the Remote Storage Target every 2 min."
        shimClass="mail"
        scheduleSubsystems={['mail']}
        backupsTab={
          <div className="space-y-4">
            <MailObjectBackupCard ov={overview} loading={ovLoading} />

            <section className="rounded border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
              <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    Restic snapshots
                  </h3>
                  <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
                    {targetName
                      ? `Read from "${targetName}" via the in-cluster backup shim.`
                      : 'No mail BackupTarget bound — configure one in the Targets, Schedules & Retention tab to start producing snapshots.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void backups.refetch()}
                  disabled={backups.isFetching}
                  className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  {backups.isFetching ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  Refresh
                </button>
              </header>

              <div className="px-4 py-3">
                {backups.isLoading ? (
                  <p className="text-sm text-gray-500">Loading snapshots…</p>
                ) : backups.isError ? (
                  <p className="text-sm text-red-600 dark:text-red-400">
                    Failed to load snapshots: {(backups.error as Error).message}
                  </p>
                ) : !repoReachable ? (
                  <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
                    <AlertTriangle size={14} className="mr-1 inline" />
                    Restic repo is not reachable.{' '}
                    {backups.data?.data.reason ??
                      'Check that the BackupTarget Service + Secret are present and that the backup-rclone-shim is healthy.'}
                  </div>
                ) : snapshots.length === 0 ? (
                  <p className="text-sm text-gray-500">
                    No snapshots yet. The stalwart-snapshot CronJob runs every
                    2 min; the first snapshot appears within a few minutes of
                    binding a target.
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-700 dark:text-gray-400">
                        <th className="py-2 pr-3 font-medium">Snapshot</th>
                        <th className="py-2 pr-3 font-medium">Taken</th>
                        <th className="py-2 pr-3 font-medium">Size</th>
                        <th className="py-2 pr-3 font-medium">Tags</th>
                        <th className="py-2 text-right font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {snapshots.map((s) => (
                        <tr key={s.shortId}>
                          <td className="py-2 pr-3 font-mono text-xs text-gray-900 dark:text-gray-100">
                            {s.shortId}
                          </td>
                          <td className="py-2 pr-3 text-gray-700 dark:text-gray-300">
                            <time
                              dateTime={s.time}
                              title={new Date(s.time).toISOString()}
                            >
                              {formatAgo(s.time)}
                            </time>
                          </td>
                          <td className="py-2 pr-3 text-gray-700 dark:text-gray-300">
                            {formatBytes(s.sizeBytes)}
                          </td>
                          <td className="py-2 pr-3 text-xs text-gray-600 dark:text-gray-400">
                            {s.tags.length > 0 ? s.tags.join(', ') : '—'}
                          </td>
                          <td className="py-2 text-right">
                            <button
                              type="button"
                              onClick={() => setDialogSnapshot(s)}
                              disabled={availableNodes.length === 0}
                              className="inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                              title={
                                availableNodes.length === 0
                                  ? 'No Ready cluster nodes available'
                                  : 'Restore the mail-stack from this snapshot'
                              }
                            >
                              <RotateCw size={12} /> Restore…
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          </div>
        }
      />

      {dialogSnapshot && (
        <RestoreDialog
          snapshot={dialogSnapshot}
          defaultTargetNode={defaultTargetNode}
          availableNodes={availableNodes}
          onClose={() => setDialogSnapshot(null)}
          onStarted={(runId) => {
            setDialogSnapshot(null);
            setActiveRunId(runId);
          }}
        />
      )}

      {activeRunId && (
        <MailMigrationProgressModal
          runId={activeRunId}
          onClose={() => {
            setActiveRunId(null);
            void backups.refetch();
            navigate('/backups/mail');
          }}
        />
      )}
    </>
  );
}
