/**
 * BarmanRestoreWizard — Phase 3 (2026-05-22). The "oops I deleted a row"
 * flow. Modal walks the operator through:
 *
 *   Step 1 — Pick the source cluster + a recovery target time (or latest).
 *            Reads the cnpg-backup-catalogue endpoint to surface real
 *            backup IDs from the object store.
 *   Step 2 — Pick the new (side-by-side) cluster name + instance count.
 *   Step 3 — Confirm + start. POSTs /admin/postgres-barman-restore.
 *
 * After POST the wizard switches to a status-polling view that watches
 * the new cluster reach Ready, with a "Delete" button surfaced once the
 * operator is done verifying.
 *
 * NEVER touches the source cluster. Promote (the destructive cutover)
 * is a separate Phase 3.1 work item and explicitly NOT in this modal.
 */

import { useEffect, useMemo, useState } from 'react';
import { X, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Check, Trash2, RotateCw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import {
  useStartBarmanRestore,
  useBarmanRestoreStatus,
  useDeleteBarmanRestore,
  usePromoteBarmanRestore,
} from '@/hooks/use-postgres-barman-restore';
import { useWalArchiveClusters } from '@/hooks/use-system-wal-archive';
import type {
  CnpgBackupCatalogueResponse,
  CnpgClusterBackupHealth,
  WalArchiveCluster,
} from '@k8s-hosting/api-contracts';

interface Envelope<T> { readonly data: T; }

interface BarmanRestoreWizardProps {
  readonly onClose: () => void;
  /** P4d (2026-05-22): when the wizard is opened from a backup row
   *  in the Health Card, pre-seed the source cluster + target time
   *  so the operator just confirms instead of re-picking. */
  readonly initialSourceName?: string;
  readonly initialTargetTime?: string;
}

type Step = 1 | 2 | 3 | 'in-flight';

const NS = 'platform';
const DEFAULT_SOURCE = 'system-db';
const DEFAULT_OBJSTORE = 'system-postgres-objectstore';

// ── catalogue feed ────────────────────────────────────────────────────

function useCatalogue(namespace: string, objStore: string, enabled: boolean) {
  return useQuery({
    queryKey: ['cnpg-backup-catalogue', namespace, objStore],
    queryFn: () =>
      apiFetch<Envelope<CnpgBackupCatalogueResponse>>(
        `/api/v1/admin/cnpg-backup-catalogue/${encodeURIComponent(namespace)}/${encodeURIComponent(objStore)}`,
      ),
    staleTime: 30_000,
    retry: false,
    enabled,
  });
}

function useHealth() {
  return useQuery({
    queryKey: ['cnpg-backup-health'],
    queryFn: () => apiFetch<Envelope<CnpgClusterBackupHealth[]>>('/api/v1/admin/cnpg-backup-health'),
    staleTime: 60_000,
    retry: false,
  });
}

// ── Modal ─────────────────────────────────────────────────────────────

export default function BarmanRestoreWizard({ onClose, initialSourceName, initialTargetTime }: BarmanRestoreWizardProps) {
  const [step, setStep] = useState<Step>(1);
  const [sourceName, setSourceName] = useState<string>(initialSourceName ?? DEFAULT_SOURCE);
  // Convert ISO string → datetime-local-compatible "YYYY-MM-DDTHH:mm"
  // so a pre-seeded value shows in the input.
  const initialTargetLocal = useMemo(() => {
    if (!initialTargetTime) return '';
    const d = new Date(initialTargetTime);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, [initialTargetTime]);
  const [targetTime, setTargetTime] = useState<string>(initialTargetLocal); // empty = latest
  const [newName, setNewName] = useState<string>('');
  // P4a (2026-05-22): default to the source's instances count when known,
  // so HA-3 source → restore creates 3 replicas matching the operator's
  // HA state. Falls back to 1 if the health endpoint hasn't loaded yet
  // or the source cluster's instance count isn't surfaced.
  const [instances, setInstances] = useState<number>(1);
  const [instancesUserEdited, setInstancesUserEdited] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [activeCluster, setActiveCluster] = useState<{ namespace: string; newClusterName: string } | null>(null);

  const startMut = useStartBarmanRestore();
  const deleteMut = useDeleteBarmanRestore();
  const healthQ = useHealth();
  const cnpgList = healthQ.data?.data ?? [];
  // Resolve the source cluster's ObjectStore name from the health
  // endpoint instead of relying on the DEFAULT_OBJSTORE constant.
  // Future-proofs against multiple plugin-mode clusters with different
  // ObjectStore bindings (per-tenant, etc.).
  const sourceClusterRow = cnpgList.find((c) => c.namespace === NS && c.clusterName === sourceName);
  const objStoreForSource = sourceClusterRow?.objectStoreName ?? DEFAULT_OBJSTORE;
  // P4c: WAL freshness for the source cluster — surfaces in Step 3 so
  // the operator sees the PITR target's max reach.
  const walQ = useWalArchiveClusters();
  const sourceWal = walQ.data?.find((w) => w.clusterNamespace === NS && w.clusterName === sourceName) ?? null;
  // P4a: derive the source cluster's HA state + auto-default instances.
  // Re-evaluate whenever the user picks a different source. Skip the
  // auto-default if the operator has already edited the field manually
  // (instancesUserEdited stays sticky once true).
  const sourceCluster = cnpgList.find((c) => c.namespace === NS && c.clusterName === sourceName);
  const sourceHaCount = sourceCluster?.instances ?? null;
  useEffect(() => {
    if (instancesUserEdited) return;
    if (sourceHaCount && sourceHaCount >= 1 && sourceHaCount <= 5) {
      setInstances(sourceHaCount);
    }
  }, [sourceHaCount, instancesUserEdited]);
  // The source name + ObjectStore pair we look up. For now scoped to the
  // platform namespace (single system-db). Future expansion: pick from
  // every plugin-mode CNPG cluster, look up the ObjectStore from its
  // plugin parameters.
  const catalogueQ = useCatalogue(NS, objStoreForSource, step === 1 && !!objStoreForSource);
  const cat = catalogueQ.data?.data;

  // Default the new cluster name to <source>-restored-<YYYYMMDDHHmm>.
  const defaultNewName = useMemo(() => {
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 12);
    return `${sourceName.slice(0, 30)}-r-${stamp}`;
  }, [sourceName]);

  const effectiveNewName = newName.trim() || defaultNewName;

  // Fresh-backup mitigation warning (2026-05-23): when the operator
  // requests a PITR-to-target restore, the backend triggers a fresh
  // CNPG Backup first to close the WAL gap. If that mitigation can't
  // complete, the restore still proceeds — we surface the warning here
  // so the operator knows the restore may loop on CNPG's recovery
  // timeout for large WAL gaps.
  const [freshBackupNote, setFreshBackupNote] = useState<{
    triggered: boolean;
    id: string | null;
    warning: string | null;
  } | null>(null);

  const submit = async () => {
    setSubmitError(null);
    setFreshBackupNote(null);
    try {
      const r = await startMut.mutateAsync({
        namespace: NS,
        sourceClusterName: sourceName,
        newClusterName: effectiveNewName,
        recoveryTargetTime: targetTime ? new Date(targetTime).toISOString() : undefined,
        instances,
      });
      setActiveCluster({ namespace: r.data.namespace, newClusterName: r.data.newClusterName });
      setFreshBackupNote({
        triggered: r.data.freshBackupTriggered ?? false,
        id: r.data.freshBackupId ?? null,
        warning: r.data.freshBackupWarning ?? null,
      });
      setStep('in-flight');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="barman-restore-wizard-title"
      data-testid="barman-restore-wizard"
    >
      <div className="w-full max-w-2xl rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <header className="flex items-start justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-700">
          <div>
            <h2 id="barman-restore-wizard-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Restore postgres from off-cluster backup
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Side-by-side restore from a barman-cloud archive. <span className="font-semibold">Source cluster is NEVER touched.</span>
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
            <X size={16} />
          </button>
        </header>

        <div className="p-4 text-sm">
          {step === 1 && (
            <Step1Pick
              cnpgList={cnpgList}
              sourceName={sourceName}
              setSourceName={setSourceName}
              targetTime={targetTime}
              setTargetTime={setTargetTime}
              cat={cat}
              isLoading={catalogueQ.isLoading}
              error={catalogueQ.error}
            />
          )}
          {step === 2 && (
            <Step2Target
              defaultNewName={defaultNewName}
              newName={newName}
              setNewName={setNewName}
              instances={instances}
              setInstances={(n) => { setInstances(n); setInstancesUserEdited(true); }}
              sourceHaCount={sourceHaCount}
            />
          )}
          {step === 3 && (
            <Step3Confirm
              sourceName={sourceName}
              targetTime={targetTime}
              newName={effectiveNewName}
              instances={instances}
              submitError={submitError}
              sourceWal={sourceWal}
            />
          )}
          {step === 'in-flight' && activeCluster && (
            <>
              {freshBackupNote?.triggered && freshBackupNote.warning && (
                <div role="alert" className="mb-3 flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                  <div>
                    <strong>Pre-restore backup mitigation didn't complete.</strong>
                    <p className="mt-1">{freshBackupNote.warning}</p>
                    <p className="mt-1 text-amber-700 dark:text-amber-300">
                      The restore is proceeding anyway. If recovery loops, manually trigger a fresh backup (
                      <code className="font-mono">kubectl -n {activeCluster.namespace} cnpg backup {sourceName}</code>
                      ) and retry.
                    </p>
                  </div>
                </div>
              )}
              {freshBackupNote?.triggered && !freshBackupNote.warning && freshBackupNote.id && (
                <div role="status" className="mb-3 flex items-start gap-2 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200">
                  <CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" />
                  <span>
                    Fresh barman backup <code className="font-mono">{freshBackupNote.id}</code> taken to minimize WAL gap. Recovery should complete promptly.
                  </span>
                </div>
              )}
              <InFlight
                namespace={activeCluster.namespace}
                newClusterName={activeCluster.newClusterName}
                sourceName={sourceName}
                onCleanup={async () => {
                  await deleteMut.mutateAsync(activeCluster).catch(() => undefined);
                  onClose();
                }}
                cleanupPending={deleteMut.isPending}
                onPromoted={() => {
                  // Cutover handed off to task-center chip → PitrProgressModal.
                  onClose();
                }}
              />
            </>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-gray-200 p-3 dark:border-gray-700">
          {step !== 'in-flight' ? (
            <>
              <button
                type="button"
                onClick={() => setStep((s) => (typeof s === 'number' && s > 1 ? ((s - 1) as Step) : s))}
                disabled={step === 1 || startMut.isPending}
                className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                <ChevronLeft size={12} /> Back
              </button>
              {step < 3 ? (
                <button
                  type="button"
                  onClick={() => setStep((s) => (typeof s === 'number' && s < 3 ? ((s + 1) as Step) : s))}
                  className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600"
                  data-testid="barman-restore-wizard-next"
                >
                  Next <ChevronRight size={12} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={submit}
                  disabled={startMut.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  data-testid="barman-restore-wizard-start"
                >
                  {startMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  {startMut.isPending ? 'Starting…' : 'Start restore'}
                </button>
              )}
            </>
          ) : (
            <div className="flex-1" />
          )}
        </footer>
      </div>
    </div>
  );
}

// ── Step 1: pick source + target time ─────────────────────────────────

function Step1Pick({
  cnpgList,
  sourceName,
  setSourceName,
  targetTime,
  setTargetTime,
  cat,
  isLoading,
  error,
}: {
  readonly cnpgList: ReadonlyArray<CnpgClusterBackupHealth>;
  readonly sourceName: string;
  readonly setSourceName: (s: string) => void;
  readonly targetTime: string;
  readonly setTargetTime: (s: string) => void;
  readonly cat?: CnpgBackupCatalogueResponse;
  readonly isLoading: boolean;
  readonly error: unknown;
}) {
  const restorableClusters = cnpgList.filter((c) => c.namespace === NS);
  const sortedBackups = useMemo(() => {
    if (!cat?.backups) return [];
    return [...cat.backups].sort((a, b) => (a.backupId < b.backupId ? 1 : -1));
  }, [cat?.backups]);

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300">Source cluster</label>
        <select
          value={sourceName}
          onChange={(e) => setSourceName(e.target.value)}
          className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          data-testid="barman-restore-source-select"
        >
          {restorableClusters.length === 0 && <option>{sourceName}</option>}
          {restorableClusters.map((c) => (
            <option key={c.clusterName} value={c.clusterName}>{c.namespace}/{c.clusterName}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300">
          Recovery target time (UTC) — leave empty to restore to the latest backup
        </label>
        <input
          type="datetime-local"
          value={targetTime}
          onChange={(e) => setTargetTime(e.target.value)}
          className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm font-mono dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          data-testid="barman-restore-target-time"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          The restore picks the backup that finished just BEFORE this time + replays WAL forward to it.
        </p>
      </div>

      <div className="rounded border border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900/50">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Available backups in the object store
        </div>
        {isLoading && <div className="text-xs text-gray-500">Loading from shim…</div>}
        {error != null && (
          <div className="text-xs text-rose-700">Catalogue read failed: {error instanceof Error ? error.message : String(error)}</div>
        )}
        {cat && cat.source === 'unavailable' && (
          <div className="text-xs text-amber-700 dark:text-amber-300">
            Catalogue unavailable: {cat.unavailableReason ?? 'unknown'} — pick a target time anyway; CNPG will use whatever it can find.
          </div>
        )}
        {cat && cat.source === 'object-store' && sortedBackups.length === 0 && (
          <div className="text-xs text-gray-500 dark:text-gray-400">No backups in the archive yet.</div>
        )}
        {cat && cat.source === 'object-store' && sortedBackups.length > 0 && (
          <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
            {sortedBackups.slice(0, 50).map((b) => (
              <li key={b.backupId} className="flex justify-between gap-2 font-mono">
                <span className="text-gray-800 dark:text-gray-200">{b.backupId}</span>
                <span className="text-gray-500 dark:text-gray-400">
                  {b.endedAt ? new Date(b.endedAt).toLocaleString() : 'in-flight'}
                  {b.dataSizeBytes ? ` · ${formatBytes(b.dataSizeBytes)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MiB`;
  return `${(b / 1024).toFixed(0)} KiB`;
}

// ── Step 2: target name + instances ──────────────────────────────────

function Step2Target({
  defaultNewName,
  newName,
  setNewName,
  instances,
  setInstances,
  sourceHaCount,
}: {
  readonly defaultNewName: string;
  readonly newName: string;
  readonly setNewName: (s: string) => void;
  readonly instances: number;
  readonly setInstances: (n: number) => void;
  readonly sourceHaCount: number | null;
}) {
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300">New cluster name (side-by-side)</label>
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={defaultNewName}
          className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm font-mono dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          data-testid="barman-restore-new-name"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Lower-case DNS-label (1-50 chars). Leave empty to use the suggested name: <code className="font-mono">{defaultNewName}</code>
        </p>
      </div>
      <div>
        <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300">Instances</label>
        <input
          type="number"
          min={1}
          max={5}
          value={instances}
          onChange={(e) => setInstances(Math.max(1, Math.min(5, Number.parseInt(e.target.value || '1', 10))))}
          className="mt-1 w-32 rounded border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
          data-testid="barman-restore-instances"
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {sourceHaCount && sourceHaCount > 1
            ? <>Defaulted to <strong>{sourceHaCount}</strong> matching the source cluster&apos;s HA state. Lower to 1 to save cost on a verify-only restore — scale up later via <code>kubectl edit cluster</code> if you promote.</>
            : <>Source is single-instance; default 1 is correct. Increase only if you plan to promote into an HA topology.</>}
        </p>
      </div>
    </div>
  );
}

// ── Step 3: confirm ──────────────────────────────────────────────────

function Step3Confirm({
  sourceName,
  targetTime,
  newName,
  instances,
  submitError,
  sourceWal,
}: {
  readonly sourceName: string;
  readonly targetTime: string;
  readonly newName: string;
  readonly instances: number;
  readonly submitError: string | null;
  readonly sourceWal: WalArchiveCluster | null;
}) {
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-2 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs dark:border-gray-700 dark:bg-gray-900">
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Source cluster</dt>
          <dd className="font-mono text-gray-900 dark:text-gray-100">{NS}/{sourceName}</dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Recovery target</dt>
          <dd className="font-mono text-gray-900 dark:text-gray-100">{targetTime ? new Date(targetTime).toISOString() : 'latest'}</dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">New cluster</dt>
          <dd className="font-mono text-gray-900 dark:text-gray-100">{NS}/{newName}</dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Instances</dt>
          <dd className="font-mono text-gray-900 dark:text-gray-100">{instances}</dd>
        </div>
      </dl>
      <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
        <strong>Side-by-side restore.</strong> A NEW Cluster CR will be created next to{' '}
        <code className="font-mono">{sourceName}</code>. The source is untouched.
        Verify the restored data (psql, dumps), then either keep both clusters or
        delete the side-by-side one with the Delete button that appears post-restore.
      </div>
      {targetTime ? (
        <div className="rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-200">
          <div className="font-semibold">Expected timeline (with WAL replay to target time)</div>
          <ol className="mt-1.5 ml-4 list-decimal space-y-0.5 text-indigo-700 dark:text-indigo-300">
            <li><span className="font-mono">~30-180s</span> — auto-fresh-backup mitigation (closes WAL gap so CNPG's ~2-min recovery-pod timeout doesn't fire). Skips automatically if your target time is older than the most recent backup.</li>
            <li><span className="font-mono">~1-2 min</span> — CNPG downloads base backup from object store</li>
            <li><span className="font-mono">depends on WAL volume</span> — replay WAL forward to your target. Per-day-of-WAL ≈ ~1-3 min on small clusters.</li>
            <li><span className="font-mono">~30s</span> — promote primary + ready signal</li>
          </ol>
          <div className="mt-1.5">
            <strong>Total: ~5-10 min</strong> when target is recent (≤1h gap from last backup).
            Longer for older targets — see the per-WAL-day estimate above.
          </div>
          <div className="mt-1.5 text-indigo-600 dark:text-indigo-400">
            If the fresh-backup mitigation can't run (object-store unreachable, RBAC issue, etc.) the restore proceeds anyway — you'll see an amber warning + the manual <code className="font-mono">kubectl cnpg backup</code> command in the InFlight panel.
          </div>
        </div>
      ) : (
        <div className="rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-200">
          <div className="font-semibold">Expected timeline (no WAL replay — bootstrap to latest backup LSN)</div>
          <ol className="mt-1.5 ml-4 list-decimal space-y-0.5 text-indigo-700 dark:text-indigo-300">
            <li><span className="font-mono">~1-2 min</span> — CNPG downloads base backup from object store</li>
            <li><span className="font-mono">~0s</span> — no WAL replay (you didn't set a target time)</li>
            <li><span className="font-mono">~30s</span> — promote primary + ready signal</li>
          </ol>
          <div className="mt-1.5"><strong>Total: ~2-3 min</strong> for small clusters. The restored cluster will be at the most recent backup's stop_LSN — any data written AFTER that backup is NOT in the restore.</div>
        </div>
      )}
      {/* P4c — WAL streaming reach indicator. Tells the operator the
          maximum point-in-time the restore can roll forward to,
          assuming continuous WAL archive coverage.
      */}
      <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
        <div className="font-semibold text-gray-700 dark:text-gray-300">WAL coverage</div>
        {sourceWal?.enabled && sourceWal.status?.lastArchivedWalTime && !sourceWal.status.lastFailedArchiveTime && (
          <div>
            ✓ WAL archived continuously to the object store. Latest archive
            <span className="ml-1 font-mono">{new Date(sourceWal.status.lastArchivedWalTime).toLocaleString()}</span>.
            PITR target can roll forward to that point.
          </div>
        )}
        {sourceWal?.enabled && sourceWal.status?.lastFailedArchiveTime && (
          <div className="text-rose-800 dark:text-rose-300">
            ⚠ WAL archiver FAILING since
            <span className="ml-1 font-mono">{new Date(sourceWal.status.lastFailedArchiveTime).toLocaleString()}</span>.
            Restore can only roll forward to the last successful archive — data written after that is NOT in the archive.
            {sourceWal.status.lastFailedArchiveError && (
              <span className="ml-1 text-rose-700 dark:text-rose-400">({sourceWal.status.lastFailedArchiveError})</span>
            )}
          </div>
        )}
        {sourceWal?.enabled && !sourceWal.status?.lastArchivedWalTime && !sourceWal.status?.lastFailedArchiveTime && (
          <div>WAL archive enabled but no archive yet. Restore can only roll forward to the base backup's LSN.</div>
        )}
        {!sourceWal?.enabled && (
          <div className="text-amber-800 dark:text-amber-300">
            ⚠ WAL archive is DISABLED for this cluster. Restore can ONLY use base backups — no point-in-time roll-forward beyond the backup's stop_LSN.
            {targetTime && <> Your selected target time will snap to the nearest backup boundary.</>}
          </div>
        )}
      </div>
      <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
        <AlertTriangle size={12} className="-mt-0.5 mr-1 inline" />
        Restore time depends on archive size + WAL replay distance. Typical small clusters reach Ready in 2-10 min; larger archives can take 30+ min.
      </div>
      {submitError && (
        <div role="alert" className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
          {submitError}
        </div>
      )}
    </div>
  );
}

// ── In-flight: status polling + cleanup ──────────────────────────────

function InFlight({
  namespace,
  newClusterName,
  sourceName,
  onCleanup,
  cleanupPending,
  onPromoted,
}: {
  readonly namespace: string;
  readonly newClusterName: string;
  readonly sourceName: string;
  readonly onCleanup: () => Promise<void>;
  readonly cleanupPending: boolean;
  readonly onPromoted: () => void;
}) {
  // Phase 3.1: type-to-confirm gate + promote mutation. The promote
  // button only enables when the operator types the source cluster
  // name back AND the restored cluster is Ready (data must be present
  // to be snapshot-able). `promotedJob` flips on after successful
  // POST — the section then surfaces a confirmation + chip-tracking
  // hint instead of immediately closing the wizard (review MEDIUM
  // discoverability fix 2026-05-23).
  const [confirmName, setConfirmName] = useState('');
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [promotedJob, setPromotedJob] = useState<string | null>(null);
  const promoteMut = usePromoteBarmanRestore();
  const statusQ = useBarmanRestoreStatus({ namespace, newClusterName });
  const s = statusQ.data?.data;
  // P4b: derive a timeline from CNPG conditions sorted by lastTransitionTime.
  // Conditions repeat across reconciles; dedupe by type, keeping the latest
  // transition so the timeline shows one row per logical milestone.
  const timeline = useMemo(() => {
    if (!s) return [] as ReadonlyArray<{ type: string; status: string; message: string | null; lastTransitionTime: string | null }>;
    const latest = new Map<string, { type: string; status: string; message: string | null; lastTransitionTime: string | null }>();
    for (const c of s.conditions) {
      const prev = latest.get(c.type);
      if (!prev || (c.lastTransitionTime && (!prev.lastTransitionTime || c.lastTransitionTime >= prev.lastTransitionTime))) {
        latest.set(c.type, c);
      }
    }
    return Array.from(latest.values()).sort((a, b) => {
      const at = a.lastTransitionTime ?? '';
      const bt = b.lastTransitionTime ?? '';
      return at.localeCompare(bt);
    });
  }, [s]);
  return (
    <div className="space-y-3">
      <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs dark:border-gray-700 dark:bg-gray-900">
        <div className="font-semibold text-gray-700 dark:text-gray-300">
          Restoring → {namespace}/{newClusterName}
        </div>
        {!s && <div className="mt-1 text-gray-500">Connecting to status feed…</div>}
        {s && (
          <ul className="mt-1 space-y-0.5 text-gray-700 dark:text-gray-300">
            <li>Phase: <code className="font-mono">{s.phase ?? 'unknown'}</code></li>
            <li>Instances: {s.readyInstances ?? 0} / {s.desiredInstances ?? '?'} ready</li>
            {s.currentPrimary && <li>Primary: <code className="font-mono">{s.currentPrimary}</code></li>}
            {s.ready && (
              <li className="mt-1 font-semibold text-emerald-700 dark:text-emerald-300">
                <Check size={12} className="-mt-0.5 mr-1 inline" /> Cluster Ready — verify data, then delete to clean up.
              </li>
            )}
          </ul>
        )}
        {timeline.length > 0 && (
          <div className="mt-2">
            <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Timeline</div>
            <ol className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-[11px]" data-testid="barman-restore-timeline">
              {timeline.map((c) => {
                const ok = c.status === 'True';
                const failed = c.status === 'False' && c.type.toLowerCase().includes('fail');
                const when = c.lastTransitionTime ? new Date(c.lastTransitionTime).toLocaleTimeString() : '—';
                return (
                  <li key={c.type} className="flex items-start gap-2">
                    <span className="mt-0.5 flex-shrink-0">
                      {ok && <Check size={10} className="text-emerald-600 dark:text-emerald-400" />}
                      {failed && <Check size={10} className="text-rose-600 dark:text-rose-400 rotate-45" />}
                      {!ok && !failed && <Loader2 size={10} className="animate-spin text-brand-600 dark:text-brand-400" />}
                    </span>
                    <span className="flex-1">
                      <span className={ok ? 'text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-300'}>{c.type}</span>
                      {c.message && <span className="ml-2 text-gray-500 dark:text-gray-400">{c.message}</span>}
                    </span>
                    <span className="flex-shrink-0 font-mono text-[10px] text-gray-500 dark:text-gray-400">{when}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-gray-500 dark:text-gray-400">
          Need to leave? Reconnect later by running:{' '}
          <code className="rounded bg-gray-100 px-1 py-0.5 font-mono dark:bg-gray-800">kubectl -n {namespace} get cluster {newClusterName}</code>
          {' '}or by visiting <code className="font-mono">kubectl delete cluster -n {namespace} {newClusterName}</code> to clean up.
        </div>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Delete the side-by-side restored cluster ${namespace}/${newClusterName}? Source cluster is untouched.${!s?.ready ? '  WARNING: restore is still in progress — confirming will abort the WAL replay.' : ''}`)) {
              void onCleanup();
            }
          }}
          disabled={cleanupPending || !s?.ready}
          title={!s?.ready ? 'Wait for the cluster to reach Ready before deleting — otherwise the WAL replay is aborted mid-stream' : 'Delete the side-by-side cluster'}
          className="inline-flex items-center gap-1 rounded border border-rose-300 bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
          data-testid="barman-restore-cleanup"
        >
          {cleanupPending ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
          Delete restored cluster
        </button>
      </div>

      {/* Phase 3.1 — Promote (cutover). Only renders once the restored
          cluster is Ready (data verifiable + snapshot-able). Type-to-
          confirm enforced client + server side. */}
      {s?.ready && (
        <details
          className="rounded border border-rose-300 bg-rose-50/30 px-3 py-2 dark:border-rose-700 dark:bg-rose-900/10"
          data-testid="barman-restore-promote-section"
        >
          <summary className="cursor-pointer text-xs font-semibold text-rose-800 dark:text-rose-300">
            <RotateCw size={11} className="-mt-0.5 mr-1 inline" />
            Promote → <code className="font-mono">{sourceName}</code> (destructive cutover)
          </summary>
          <div className="mt-2 space-y-2 text-xs">
            <p className="text-rose-900 dark:text-rose-200">
              <strong>This will REPLACE the source cluster.</strong> Steps:
              snapshot the restored cluster's primary PVC, delete{' '}
              <code className="font-mono">{sourceName}</code>, recreate it from the snapshot,
              normalize bootstrap, restart consumers, delete this side-by-side cluster.
              ~5-10 min wall-clock + ~6-8 min source write-block during cutover.
            </p>
            <p className="text-rose-900 dark:text-rose-200">
              Verify the restored cluster has the expected data first
              (<code className="rounded bg-rose-100 px-1 dark:bg-rose-900/40">kubectl -n {namespace} exec {newClusterName}-1 -c postgres -- psql ...</code>).
            </p>
            <label className="block">
              <span className="text-gray-700 dark:text-gray-300">
                Type <code className="rounded bg-gray-100 px-1 font-mono dark:bg-gray-800">{sourceName}</code> to confirm:
              </span>
              <input
                type="text"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={sourceName}
                className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 font-mono text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                data-testid="barman-restore-promote-confirm"
              />
            </label>
            {promoteError && (
              <div role="alert" className="rounded border border-rose-400 bg-rose-100 px-2 py-1 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200">
                {promoteError}
              </div>
            )}
            {promotedJob ? (
              <div role="status" className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200">
                <div className="font-semibold">
                  <Check size={12} className="-mt-0.5 mr-1 inline" />
                  Promote started — Job <code className="font-mono">{promotedJob}</code>
                </div>
                <div className="mt-1">
                  Track live progress in the <strong>task-center chip</strong> (top bar). Clicking the chip opens
                  the step-by-step timeline modal — same view as a normal PITR. Closing this wizard is now safe.
                </div>
                <button
                  type="button"
                  onClick={onPromoted}
                  className="mt-2 inline-flex items-center gap-1 rounded border border-emerald-400 px-2 py-0.5 text-xs font-medium text-emerald-900 hover:bg-emerald-100 dark:border-emerald-600 dark:text-emerald-200 dark:hover:bg-emerald-900/50"
                  data-testid="barman-restore-promote-close"
                >
                  Close wizard
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={confirmName !== sourceName || promoteMut.isPending}
                onClick={async () => {
                  setPromoteError(null);
                  try {
                    const resp = await promoteMut.mutateAsync({
                      namespace,
                      newClusterName,
                      body: { sourceClusterName: sourceName, confirmSourceClusterName: confirmName },
                    });
                    setPromotedJob(resp.data.jobName);
                  } catch (err) {
                    setPromoteError(err instanceof Error ? err.message : String(err));
                  }
                }}
                className="inline-flex items-center gap-1.5 rounded bg-rose-600 px-3 py-1 text-xs font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="barman-restore-promote-start"
              >
                {promoteMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
                {promoteMut.isPending ? 'Starting cutover…' : 'Promote → source'}
              </button>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
