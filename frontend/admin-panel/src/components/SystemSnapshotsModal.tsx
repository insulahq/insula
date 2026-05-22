import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  X, Loader2, Camera, Trash2, RotateCcw, AlertTriangle, AlertCircle, RefreshCw, CheckCircle, Save,
} from 'lucide-react';
import {
  useVolumeSnapshots,
  useTakeSnapshot,
  useDeleteSystemSnapshot,
  usePruneSystemSnapshots,
  useRestoreSystemSnapshot,
  useRecurringJobs,
  useUpdateRecurringJob,
} from '@/hooks/use-system-snapshots';
import {
  useStartPitr,
  usePitrPrechecks,
  useRestoreStatus,
} from '@/hooks/use-postgres-restore';
import type { SystemPvcSnapshotSummary } from '@k8s-hosting/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import RestorationWizard, { type RestoreArtifact, type RestorationWizardPrecheck } from '@/components/backups/RestorationWizard';

interface SystemSnapshotsModalProps {
  readonly volume: SystemPvcSnapshotSummary;
  readonly onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = bytes; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 ? 2 : 1)} ${u[i]}`;
}

/**
 * Per-volume snapshot management modal.
 *
 * Lists every Longhorn snapshot for the selected volume and exposes:
 *   - Take snapshot (manual, with optional label)
 *   - Delete a single snapshot
 *   - Restore (in-place revert; requires the volume to be detached)
 *   - Prune all (delete every snapshot except the N newest, default 1)
 *   - Edit recurring-job cron + retain for the jobs that apply to the
 *     volume — backed by a Longhorn RecurringJob CR PATCH so the change
 *     applies to every volume sharing the job group.
 */
export default function SystemSnapshotsModal({ volume, onClose }: SystemSnapshotsModalProps) {
  const list = useVolumeSnapshots(volume.longhornVolumeName);
  const jobs = useRecurringJobs({ enabled: true });
  const take = useTakeSnapshot();
  const del = useDeleteSystemSnapshot();
  const prune = usePruneSystemSnapshots();
  const restore = useRestoreSystemSnapshot();
  const updateJob = useUpdateRecurringJob();
  const startPitr = useStartPitr();
  // Poll cluster-wide PITR lock only while the modal is mounted, AND only
  // when this volume is CNPG-managed (other consumers don't care). Gates
  // every per-row Restore button on the snapshot table — pre-empts the
  // 409 PITR_PRECONDITION_FAILED a second operator would otherwise hit.
  const pitrStatusQ = useRestoreStatus({ enabled: volume.cnpgCluster != null });
  const anotherPitrInFlight = pitrStatusQ.data?.data?.inProgress === true;
  const qc = useQueryClient();

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [keepNewest, setKeepNewest] = useState(1);
  const [manualLabel, setManualLabel] = useState('');
  // Phase 1 (2026-05-22): CNPG snapshot → real PITR via wizard.
  // Holds the snapshot row the operator picked; null = wizard closed.
  const [pitrSnap, setPitrSnap] = useState<{ snapshotName: string; createdAt: string | null; sizeBytes: number } | null>(null);

  // Read live prechecks whenever the wizard is open against a CNPG snap.
  const prechecksQ = usePitrPrechecks({
    clusterNamespace: volume.cnpgCluster?.namespace ?? null,
    clusterName: volume.cnpgCluster?.name ?? null,
    snapshotName: pitrSnap?.snapshotName ?? null,
    enabled: pitrSnap != null && volume.cnpgCluster != null,
  });

  const snapshots = list.data?.data.snapshots ?? [];
  const allJobs = jobs.data?.data.jobs ?? [];
  const myJobs = allJobs.filter((j) => volume.recurringJobs.includes(j.jobName));

  // Local edit buffer for cron + retain — flushed on Save so unrelated
  // tabs don't see optimistic updates. The dep is the serialised job
  // signature so unrelated re-renders don't clobber in-flight edits.
  const [jobDraft, setJobDraft] = useState<Record<string, { cron: string; retain: number }>>({});
  const myJobSig = myJobs.map((j) => `${j.jobName}|${j.cron}|${j.retain}`).join(',');
  useEffect(() => {
    const init: Record<string, { cron: string; retain: number }> = {};
    for (const j of myJobs) init[j.jobName] = { cron: j.cron, retain: j.retain };
    setJobDraft(init);
  }, [myJobSig, myJobs]);

  const isDirty = (jobName: string): boolean => {
    const job = myJobs.find((j) => j.jobName === jobName);
    const d = jobDraft[jobName];
    return Boolean(job && d && (d.cron !== job.cron || d.retain !== job.retain));
  };

  const handleSaveJob = async (jobName: string): Promise<void> => {
    const d = jobDraft[jobName];
    if (!d) return;
    try {
      await updateJob.mutateAsync({ jobName, cron: d.cron, retain: d.retain });
    } catch { /* surfaced in panel */ }
  };

  const handleTakeSnapshot = async (): Promise<void> => {
    try {
      await take.mutateAsync({ volumeName: volume.longhornVolumeName, label: manualLabel || undefined });
      setManualLabel('');
    } catch { /* surfaced */ }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      role="dialog"
      aria-modal="true"
      data-testid="system-snapshots-modal"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl rounded-xl bg-white shadow-xl dark:bg-gray-800 max-h-[calc(100vh-4rem)] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Snapshots — <span className="font-mono">{volume.namespace}/{volume.pvcName}</span>
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {volume.longhornVolumeName} · {formatBytes(volume.volumeSizeBytes)} · {volume.snapshotCount} snapshot(s) · {formatBytes(volume.snapshotBytesTotal)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm">
          {/* Recurring-job policy editor */}
          <section>
            <h3 className="text-xs font-semibold uppercase text-gray-500 dark:text-gray-400 mb-2">Schedule</h3>
            {jobs.isLoading && (
              <div className="text-xs text-gray-500"><Loader2 size={12} className="inline animate-spin mr-1" /> loading jobs…</div>
            )}
            {!jobs.isLoading && myJobs.length === 0 && (
              <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
                <AlertCircle size={12} className="inline mr-1" />
                This volume has no RecurringJob attached. Snapshots will only be taken manually.
              </p>
            )}
            {myJobs.length > 0 && (
              <table className="w-full text-xs" data-testid="recurring-jobs-table">
                <thead className="text-gray-500 dark:text-gray-400">
                  <tr>
                    <th className="text-left py-1 pr-2">Job</th>
                    <th className="text-left py-1 pr-2">Task</th>
                    <th className="text-left py-1 pr-2">Cron</th>
                    <th className="text-right py-1 pr-2">Retain</th>
                    <th className="text-right py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {myJobs.map((j) => {
                    const d = jobDraft[j.jobName] ?? { cron: j.cron, retain: j.retain };
                    return (
                      <tr key={j.jobName} className="border-t border-gray-200/60 dark:border-gray-700/40">
                        <td className="py-1.5 pr-2 font-mono">{j.jobName}</td>
                        <td className="py-1.5 pr-2 text-gray-500">{j.task}</td>
                        <td className="py-1.5 pr-2">
                          <input
                            type="text"
                            value={d.cron}
                            onChange={(e) => setJobDraft((p) => ({ ...p, [j.jobName]: { ...d, cron: e.target.value } }))}
                            className="w-32 rounded border border-gray-300 bg-white px-1 py-0.5 text-xs font-mono dark:border-gray-600 dark:bg-gray-700"
                            data-testid={`job-cron-${j.jobName}`}
                          />
                        </td>
                        <td className="py-1.5 pr-2 text-right">
                          <input
                            type="number"
                            min={1}
                            max={365}
                            value={d.retain}
                            onChange={(e) => setJobDraft((p) => ({ ...p, [j.jobName]: { ...d, retain: parseInt(e.target.value, 10) || 1 } }))}
                            className="w-16 rounded border border-gray-300 bg-white px-1 py-0.5 text-xs text-right tabular-nums dark:border-gray-600 dark:bg-gray-700"
                            data-testid={`job-retain-${j.jobName}`}
                          />
                        </td>
                        <td className="py-1.5 text-right">
                          <button
                            type="button"
                            onClick={() => handleSaveJob(j.jobName)}
                            disabled={!isDirty(j.jobName) || updateJob.isPending}
                            className="inline-flex items-center gap-1 rounded border border-brand-300 bg-brand-50 px-2 py-0.5 text-xs text-brand-700 hover:bg-brand-100 disabled:opacity-50 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-200 dark:hover:bg-brand-900/50"
                            data-testid={`job-save-${j.jobName}`}
                          >
                            {updateJob.isPending ? <Loader2 size={10} className="animate-spin" /> : <Save size={10} />}
                            Save
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {updateJob.error && (
              <div className="mt-2"><ErrorPanel error={extractOperatorError(updateJob.error)} severity="error" compact /></div>
            )}
            <p className="mt-2 text-[11px] text-gray-500 dark:text-gray-400">
              Edits apply to every volume in the same job group, not just this one. To override per-volume, manage labels in the Longhorn UI.
            </p>
          </section>

          {/* Manual snapshot + prune-all */}
          <section className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/30">
            <input
              type="text"
              placeholder="Optional label"
              value={manualLabel}
              onChange={(e) => setManualLabel(e.target.value)}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-700"
              data-testid="manual-snapshot-label"
            />
            <button
              type="button"
              onClick={handleTakeSnapshot}
              disabled={take.isPending}
              className="inline-flex items-center gap-1.5 rounded bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              data-testid="manual-take-snapshot"
            >
              {take.isPending ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
              Take snapshot
            </button>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-[11px] text-gray-500 dark:text-gray-400">Keep newest</span>
              <input
                type="number"
                min={0}
                max={100}
                value={keepNewest}
                onChange={(e) => setKeepNewest(Math.max(0, parseInt(e.target.value, 10) || 0))}
                className="w-14 rounded border border-gray-300 bg-white px-1 py-0.5 text-xs text-right tabular-nums dark:border-gray-600 dark:bg-gray-700"
                data-testid="keep-newest-input"
              />
              <button
                type="button"
                onClick={() => setConfirmPrune(true)}
                disabled={snapshots.length === 0}
                className="inline-flex items-center gap-1.5 rounded border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200"
                data-testid="prune-all-button"
              >
                <Trash2 size={12} /> Prune (delete older)
              </button>
            </div>
          </section>

          {/* Snapshot list */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase text-gray-500 dark:text-gray-400">Snapshots</h3>
              <button
                type="button"
                onClick={() => list.refetch()}
                disabled={list.isFetching}
                className="rounded p-0.5 text-gray-500 hover:text-gray-700 disabled:opacity-50"
                aria-label="Refresh"
              >
                {list.isFetching ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              </button>
            </div>
            {list.isLoading && <div className="text-xs text-gray-500"><Loader2 size={12} className="inline animate-spin mr-1" /> loading…</div>}
            {list.error && <ErrorPanel error={extractOperatorError(list.error)} severity="error" compact />}
            {!list.isLoading && snapshots.length === 0 && (
              <p className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-400">No snapshots yet.</p>
            )}
            {snapshots.length > 0 && (
              <table className="w-full text-xs" data-testid="snapshot-list-table">
                <thead className="text-gray-500 dark:text-gray-400">
                  <tr>
                    <th className="text-left py-1 pr-2">Name</th>
                    <th className="text-left py-1 pr-2">Created</th>
                    <th className="text-right py-1 pr-2">Size</th>
                    <th className="text-left py-1 pr-2">Status</th>
                    <th className="text-left py-1 pr-2">Label</th>
                    <th className="text-right py-1">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((s) => (
                    <tr key={s.snapshotName} className="border-t border-gray-200/60 dark:border-gray-700/40" data-testid={`snapshot-row-${s.snapshotName}`}>
                      <td className="py-1.5 pr-2 font-mono">{s.snapshotName}</td>
                      <td className="py-1.5 pr-2 text-gray-500">{s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 16).replace('T', ' ') : '—'}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums">{formatBytes(s.sizeBytes)}</td>
                      <td className="py-1.5 pr-2">
                        {s.markedForRemoval ? (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">marked-removed</span>
                        ) : s.usable ? (
                          <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-800 dark:bg-green-900/40 dark:text-green-300">ready</span>
                        ) : (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-700 dark:bg-gray-700 dark:text-gray-300">pending</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 max-w-[160px] truncate text-gray-600 dark:text-gray-300">{s.userLabel ?? <span className="text-gray-400 italic">none</span>}</td>
                      <td className="py-1.5 text-right whitespace-nowrap">
                        {volume.cnpgCluster ? (
                          // Phase 1 (2026-05-22): CNPG snapshot Restore wires
                          // into the existing POST /admin/postgres-restore
                          // endpoint via the RestorationWizard. The backend
                          // spawns a dedicated k8s Job that promotes from
                          // the snapshot (with optional WAL replay) and
                          // replaces the source cluster — exactly the
                          // operation the DR shell-script wizard previously
                          // documented, but now visible + tracked through
                          // the task-center chip.
                          <button
                            type="button"
                            onClick={() => setPitrSnap({ snapshotName: s.snapshotName, createdAt: s.createdAt, sizeBytes: s.sizeBytes })}
                            disabled={!s.usable || anotherPitrInFlight}
                            className="mr-1 inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700/50"
                            data-testid={`snapshot-restore-${s.snapshotName}`}
                            title={anotherPitrInFlight
                              ? `Another PITR is in flight (snapshot=${pitrStatusQ.data?.data?.snapshot ?? 'unknown'}) — wait until it completes`
                              : 'Promote from this snapshot — runs in a dedicated k8s Job; track progress via the task-center chip'}
                          >
                            <RotateCcw size={10} /> Restore
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmRestore(s.snapshotName)}
                            disabled={!s.usable}
                            className="mr-1 inline-flex items-center gap-1 rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:hover:bg-gray-700/50"
                            data-testid={`snapshot-restore-${s.snapshotName}`}
                          >
                            <RotateCcw size={10} /> Restore
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(s.snapshotName)}
                          className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
                          data-testid={`snapshot-delete-${s.snapshotName}`}
                        >
                          <Trash2 size={10} /> Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {(take.error || del.error || prune.error) && (
            <ErrorPanel error={extractOperatorError(take.error ?? del.error ?? prune.error)} severity="error" compact />
          )}
        </div>

        {/* Confirm dialogs */}
        {confirmDelete && (
          <ConfirmDialog
            title="Delete snapshot?"
            body={<>This will delete <strong className="font-mono">{confirmDelete}</strong>. Cannot be undone.</>}
            onConfirm={async () => {
              await del.mutateAsync({ volumeName: volume.longhornVolumeName, snapshotName: confirmDelete });
              setConfirmDelete(null);
            }}
            onCancel={() => setConfirmDelete(null)}
            error={del.error}
            pending={del.isPending}
            testId="confirm-delete-snapshot"
          />
        )}

        {confirmRestore && (
          <ConfirmDialog
            title="Restore from snapshot?"
            body={
              <>
                This will revert <strong className="font-mono">{volume.namespace}/{volume.pvcName}</strong> to{' '}
                <strong className="font-mono">{confirmRestore}</strong>. The volume MUST be detached first
                (scale the consumer down to 0). Any data written after this snapshot will be lost.
              </>
            }
            onConfirm={async () => {
              await restore.mutateAsync({
                volumeName: volume.longhornVolumeName,
                snapshotName: confirmRestore,
                pvcNamespace: volume.namespace,
                pvcName: volume.pvcName,
              });
              setConfirmRestore(null);
            }}
            onCancel={() => setConfirmRestore(null)}
            error={restore.error}
            pending={restore.isPending}
            testId="confirm-restore-snapshot"
            confirmLabel="Yes, restore"
          />
        )}

        {confirmPrune && (
          <ConfirmDialog
            title="Prune snapshots?"
            body={
              <>
                Delete every snapshot except the {keepNewest} newest? <strong>{snapshots.length - keepNewest}</strong>{' '}
                snapshot(s) will be removed permanently.
              </>
            }
            onConfirm={async () => {
              await prune.mutateAsync({ volumeName: volume.longhornVolumeName, keepNewest });
              setConfirmPrune(false);
            }}
            onCancel={() => setConfirmPrune(false)}
            error={prune.error}
            pending={prune.isPending}
            testId="confirm-prune-all"
            confirmLabel="Yes, prune"
          />
        )}

        {/* Phase 1 — CNPG PITR wizard wired to the real backend endpoint. */}
        {pitrSnap && volume.cnpgCluster && (() => {
          const precheck = prechecksQ.data?.data;
          // Distinguish pending (neutral) from hard-blocking (rose-red).
          const pendingMessage: string | null = prechecksQ.isLoading
            ? 'Running prechecks against snapshot + cluster…'
            : null;
          const blockingError: string | null = (() => {
            if (prechecksQ.error) {
              return `Prechecks failed: ${prechecksQ.error instanceof Error ? prechecksQ.error.message : String(prechecksQ.error)}`;
            }
            return precheck?.blockingError ?? null;
          })();
          const livePrechecks: ReadonlyArray<RestorationWizardPrecheck> = (() => {
            if (!precheck) return [];
            const arr: RestorationWizardPrecheck[] = [];
            if (precheck.snapshotUsable && precheck.snapshotAgeSec != null) {
              const ageMin = Math.round(precheck.snapshotAgeSec / 60);
              arr.push({
                severity: 'info',
                message: `Snapshot ready · age ${ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin / 60)}h`} (created ${precheck.snapshotCreatedAt ? new Date(precheck.snapshotCreatedAt).toLocaleString() : '?'})`,
              });
            }
            if (precheck.sourceInstances != null && precheck.clusterPrimaryPvc) {
              arr.push({
                severity: 'info',
                message: `Source cluster: ${precheck.sourceInstances} instance${precheck.sourceInstances === 1 ? '' : 's'} · primary PVC ${precheck.clusterPrimaryPvc}`,
              });
            }
            if (precheck.lockState !== 'free') {
              arr.push({
                severity: 'warn',
                message: `Another PITR is in flight (snapshot=${precheck.lockSnapshot ?? 'unknown'}; lock source: ${precheck.lockState}). Cannot start a new restore until it completes.`,
              });
            }
            arr.push({
              severity: 'warn',
              message: 'This will REPLACE the source cluster atomically once the new bootstrap is ready. There is no automatic undo — the source data is deleted at the cutover.',
            });
            return arr;
          })();

          const artifact: RestoreArtifact = {
            kind: 'snapshot',
            id: pitrSnap.snapshotName,
            displayName: `${volume.cnpgCluster.namespace}/${volume.cnpgCluster.name} · ${pitrSnap.snapshotName}`,
            sizeBytes: pitrSnap.sizeBytes,
            createdAt: pitrSnap.createdAt,
          };

          return (
            <RestorationWizard
              artifact={artifact}
              prechecks={livePrechecks}
              blockSubmit={blockingError}
              submitPending={pendingMessage}
              hideWhereStep
              onClose={() => setPitrSnap(null)}
              onSubmit={async () => {
                const resp = await startPitr.mutateAsync({
                  clusterNamespace: volume.cnpgCluster!.namespace,
                  clusterName: volume.cnpgCluster!.name,
                  snapshotName: pitrSnap.snapshotName,
                });
                // Refresh the cluster-wide status so the chip + future
                // restore buttons see the lock immediately.
                qc.invalidateQueries({ queryKey: ['postgres-restore', 'status'] });
                return { taskId: resp.data.jobName };
              }}
            />
          );
        })()}
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  readonly title: string;
  readonly body: React.ReactNode;
  readonly onConfirm: () => Promise<void>;
  readonly onCancel: () => void;
  readonly error: unknown;
  readonly pending: boolean;
  readonly testId: string;
  readonly confirmLabel?: string;
}

function ConfirmDialog({ title, body, onConfirm, onCancel, error, pending, testId, confirmLabel = 'Yes, delete' }: ConfirmDialogProps) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 p-4" data-testid={testId}>
      <div className="w-full max-w-md rounded-xl border border-red-300 bg-white p-5 shadow-xl dark:border-red-700 dark:bg-gray-800">
        <h3 className="flex items-center gap-2 text-base font-semibold text-red-700 dark:text-red-300">
          <AlertTriangle size={16} /> {title}
        </h3>
        <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">{body}</p>
        {error !== null && error !== undefined && (
          <div className="mt-2"><ErrorPanel error={extractOperatorError(error)} severity="error" compact /></div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { onConfirm().catch(() => undefined); }}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            data-testid={`${testId}-confirm`}
          >
            {pending ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
