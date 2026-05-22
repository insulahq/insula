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

import { useMemo, useState } from 'react';
import { X, AlertTriangle, ChevronLeft, ChevronRight, Loader2, Check, Trash2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import {
  useStartBarmanRestore,
  useBarmanRestoreStatus,
  useDeleteBarmanRestore,
} from '@/hooks/use-postgres-barman-restore';
import type {
  CnpgBackupCatalogueResponse,
  CnpgClusterBackupHealth,
} from '@k8s-hosting/api-contracts';

interface Envelope<T> { readonly data: T; }

interface BarmanRestoreWizardProps {
  readonly onClose: () => void;
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

export default function BarmanRestoreWizard({ onClose }: BarmanRestoreWizardProps) {
  const [step, setStep] = useState<Step>(1);
  const [sourceName, setSourceName] = useState<string>(DEFAULT_SOURCE);
  const [targetTime, setTargetTime] = useState<string>(''); // empty = latest
  const [newName, setNewName] = useState<string>('');
  const [instances, setInstances] = useState<number>(1);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [activeCluster, setActiveCluster] = useState<{ namespace: string; newClusterName: string } | null>(null);

  const startMut = useStartBarmanRestore();
  const deleteMut = useDeleteBarmanRestore();
  const healthQ = useHealth();
  const cnpgList = healthQ.data?.data ?? [];
  // The source name + ObjectStore pair we look up. For now scoped to the
  // platform namespace (single system-db). Future expansion: pick from
  // every plugin-mode CNPG cluster, look up the ObjectStore from its
  // plugin parameters.
  const catalogueQ = useCatalogue(NS, DEFAULT_OBJSTORE, step === 1);
  const cat = catalogueQ.data?.data;

  // Default the new cluster name to <source>-restored-<YYYYMMDDHHmm>.
  const defaultNewName = useMemo(() => {
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 12);
    return `${sourceName.slice(0, 30)}-r-${stamp}`;
  }, [sourceName]);

  const effectiveNewName = newName.trim() || defaultNewName;

  const submit = async () => {
    setSubmitError(null);
    try {
      const r = await startMut.mutateAsync({
        namespace: NS,
        sourceClusterName: sourceName,
        newClusterName: effectiveNewName,
        recoveryTargetTime: targetTime ? new Date(targetTime).toISOString() : undefined,
        instances,
      });
      setActiveCluster({ namespace: r.data.namespace, newClusterName: r.data.newClusterName });
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
              setInstances={setInstances}
            />
          )}
          {step === 3 && (
            <Step3Confirm
              sourceName={sourceName}
              targetTime={targetTime}
              newName={effectiveNewName}
              instances={instances}
              submitError={submitError}
            />
          )}
          {step === 'in-flight' && activeCluster && (
            <InFlight
              namespace={activeCluster.namespace}
              newClusterName={activeCluster.newClusterName}
              onCleanup={async () => {
                await deleteMut.mutateAsync(activeCluster).catch(() => undefined);
                onClose();
              }}
              cleanupPending={deleteMut.isPending}
            />
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
}: {
  readonly defaultNewName: string;
  readonly newName: string;
  readonly setNewName: (s: string) => void;
  readonly instances: number;
  readonly setInstances: (n: number) => void;
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
          Default 1 (cheapest restore). Scale up later via <code>kubectl edit cluster</code> if you intend to promote.
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
}: {
  readonly sourceName: string;
  readonly targetTime: string;
  readonly newName: string;
  readonly instances: number;
  readonly submitError: string | null;
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
  onCleanup,
  cleanupPending,
}: {
  readonly namespace: string;
  readonly newClusterName: string;
  readonly onCleanup: () => Promise<void>;
  readonly cleanupPending: boolean;
}) {
  const statusQ = useBarmanRestoreStatus({ namespace, newClusterName });
  const s = statusQ.data?.data;
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
        {s && s.conditions.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400">CNPG conditions ({s.conditions.length})</summary>
            <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-[11px]">
              {s.conditions.map((c, i) => (
                <li key={`${c.type}-${i}`} className="flex gap-2">
                  <span className="font-mono">{c.type}</span>
                  <span className="text-gray-500">{c.status}</span>
                  {c.message && <span className="truncate text-gray-500" title={c.message}>{c.message}</span>}
                </li>
              ))}
            </ul>
          </details>
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
    </div>
  );
}
