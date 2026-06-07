/**
 * `/backups/system` — System backup-class page.
 *
 * Phase 3 (2026-05-22) rebuilt the page on the shared
 * `<BackupClassPage>` shell. Phase 7 added a "Restore postgres…"
 * action launcher for the BACKUPS tab — opens the Restoration
 * Wizard which navigates to the Disaster Recovery page's Restore
 * Instructions section (postgres PITR runs out-of-band from the
 * recovery host).
 *
 * Tabs:
 *
 *   (a) Snapshots — block-level snapshots for system PVCs.
 *       SystemSnapshotsSection has full take/restore/delete actions
 *       (per-snapshot modal: in-place revert, prune-older,
 *       on-demand snapshot).
 *
 *   (b) Backups   — off-cluster backups: postgres PITR base + WAL,
 *       CNPG ScheduledBackup health, system databases (pg_dump
 *       inline trigger). "Restore postgres…" launches the wizard.
 *
 *   (c) Targets, Schedules & Retention — `<BackupRoutingTab>` for
 *       the `system` shim class with the `system_pitr` schedule row.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, RotateCw, PlayCircle, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import BackupClassPage from './BackupClassPage';
import SystemSnapshotsSection from '@/components/SystemSnapshotsSection';
import { CnpgBackupHealthCard } from '@/components/CnpgBackupHealthCard';
import SystemBackupListSection from '@/components/system-backup/SystemBackupListSection';
import BarmanRestoreWizard from '@/components/backups/BarmanRestoreWizard';
import { useCnpgBackupNow } from '@/hooks/use-cnpg-backup-now';

export default function SystemBackupsPage() {
  const [wizardOpen, setWizardOpen] = useState(false);

  return (
    <>
      <BackupClassPage
        icon={KeyRound}
        title="System Backups"
        subtitle="Postgres WAL + base backup, etcd snapshots, secrets bundle, monitoring + restic-backed components."
        shimClass="system"
        scheduleSubsystems={[]}
        snapshotsTab={
          <div className="space-y-3">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Block-level snapshots for system PVCs. CNPG clusters collapse into one row;
              click a row to drill into per-replica PVCs and take / restore / delete individual
              snapshots.
            </p>
            <SystemSnapshotsSection />
          </div>
        }
        backupsTab={
          <div className="space-y-6">
            <div className="flex items-center justify-end gap-2">
              {/* Phase 2 (2026-05-24): page-level "Backup Now" trigger.
                  Posts to /admin/cnpg-backup-now which creates a single
                  Backup CR for the platform/system-db cluster. Async —
                  returns immediately; result appears in the catalogue
                  list section a few seconds later. */}
              <BackupNowButton />
              <button
                type="button"
                onClick={() => setWizardOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                data-testid="system-restore-postgres-open"
              >
                <RotateCw size={14} /> Restore postgres…
              </button>
            </div>
            {/* CNPG ScheduledBackup health (rolled-up cluster-side state). */}
            <CnpgBackupHealthCard />
            {/* Phase 3 (2026-05-24): sibling section showing the
                catalogue list of backups in the current target. */}
            <SystemBackupListSection />
            {/* Phase 4 (2026-05-24): WAL Archive configuration moved
                to the Routing tab — it's a target/schedule decision,
                not a backup-list view. See BackupRoutingTab.tsx. */}
            <div className="rounded border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
              Looking for the cluster-wide Secrets bundle? It moved to{' '}
              <Link to="/backups/disaster-recovery" className="font-medium underline">
                Disaster Recovery
              </Link>{' '}
              alongside the DR drill and restore instructions.
            </div>
          </div>
        }
      />

      {wizardOpen && (
        <BarmanRestoreWizard onClose={() => setWizardOpen(false)} />
      )}
    </>
  );
}

/**
 * Page-level "Backup Now" button — triggers a CNPG Backup CR for
 * platform/system-db. Defaults are hardcoded because that's the only
 * system cluster on the platform (mail-db was removed in Phase 0a;
 * see docs/operations/PG_MAJOR_UPGRADE.md). A future multi-cluster
 * setup would expose a cluster picker here.
 *
 * UX:
 *   - idle      → outline button "Backup Now"
 *   - pending   → button spinner + disabled (one in-flight at a time)
 *   - success   → button flashes green + caption "queued — see catalogue"
 *   - error     → inline red caption below button with the error message
 *
 * Auto-resets the success/error state after 6s so the operator can
 * trigger another run without a manual dismiss.
 */
function BackupNowButton() {
  const mutate = useCnpgBackupNow();
  const [modalOpen, setModalOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [resultBanner, setResultBanner] = useState<
    | null
    | { kind: 'ok'; backupName: string; description: string }
    | { kind: 'err'; message: string }
  >(null);

  // Phase 7c (2026-05-24): description stored as annotation (not label)
  // so the charset is unrestricted — only the length cap of 200 chars
  // applies. Empty stays valid (description is optional).
  const descValid = description.length <= 200;

  const confirmTrigger = (): void => {
    if (!descValid) return;
    setResultBanner(null);
    void (async () => {
      try {
        const r = await mutate.mutateAsync({
          namespace: 'platform',
          clusterName: 'system-db',
          ...(description ? { description } : {}),
        });
        setResultBanner({
          kind: 'ok',
          backupName: r.data.backupName,
          description,
        });
        setModalOpen(false);
        setDescription('');
        window.setTimeout(() => setResultBanner(null), 6000);
      } catch (err) {
        setResultBanner({
          kind: 'err',
          message: err instanceof Error ? err.message : String(err),
        });
        window.setTimeout(() => setResultBanner(null), 8000);
      }
    })();
  };

  const okFlash = resultBanner?.kind === 'ok';
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        disabled={mutate.isPending}
        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
          okFlash
            ? 'border border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
            : 'border border-brand-300 bg-brand-50 text-brand-800 hover:bg-brand-100 dark:border-brand-600 dark:bg-brand-900/30 dark:text-brand-200 dark:hover:bg-brand-900/50'
        } disabled:opacity-60`}
        data-testid="system-backup-now"
      >
        {mutate.isPending ? (
          <Loader2 size={14} className="animate-spin" />
        ) : okFlash ? (
          <CheckCircle2 size={14} />
        ) : (
          <PlayCircle size={14} />
        )}
        {mutate.isPending ? 'Triggering…' : okFlash ? 'Queued' : 'Backup Now'}
      </button>
      {resultBanner?.kind === 'ok' && (
        <span className="text-xs text-emerald-700 dark:text-emerald-300">
          {resultBanner.backupName}
          {resultBanner.description && ` "${resultBanner.description}"`}
          {' '}— appears in the list once CNPG completes the upload.
        </span>
      )}
      {resultBanner?.kind === 'err' && (
        <span className="inline-flex items-center gap-1 text-xs text-rose-700 dark:text-rose-300" data-testid="system-backup-now-error">
          <AlertCircle size={12} /> {resultBanner.message}
        </span>
      )}

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="backup-now-modal-title"
          data-testid="backup-now-modal"
        >
          <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
            <header className="border-b border-gray-200 px-5 py-3 dark:border-gray-700">
              <h3 id="backup-now-modal-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Trigger on-demand backup
              </h3>
            </header>
            <div className="space-y-3 px-5 py-4 text-sm text-gray-700 dark:text-gray-300">
              <p>
                Creates a fresh CNPG <code className="rounded bg-gray-100 px-1 dark:bg-gray-900">Backup</code> CR for{' '}
                <code>platform/system-db</code>. The barman-cloud plugin
                runs <code>pg_basebackup</code> + uploads to the SYSTEM
                backup target through the shim.
              </p>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Description (optional)
                </span>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. pre-upgrade: tenant import"
                  maxLength={200}
                  autoFocus
                  aria-invalid={!descValid}
                  className={`w-full rounded-md border bg-white px-2 py-1.5 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 ${
                    descValid ? 'border-gray-300 dark:border-gray-600' : 'border-rose-400 dark:border-rose-600'
                  }`}
                  data-testid="backup-now-description"
                />
                <p className="mt-1 text-[10px] text-gray-500 dark:text-gray-400">
                  Up to 200 chars. Stored as a CR annotation (no charset
                  restrictions). Surfaced in the backup list so you can
                  recognise ad-hoc backups later.
                </p>
                {!descValid && (
                  <p className="mt-1 text-[10px] text-rose-700 dark:text-rose-300">
                    Too long (max 200 chars).
                  </p>
                )}
              </label>
              {mutate.error && (
                <div className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
                  {(mutate.error as Error).message}
                </div>
              )}
            </div>
            <footer className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3 dark:border-gray-700 dark:bg-gray-900/50">
              <button
                type="button"
                onClick={() => { setModalOpen(false); setDescription(''); }}
                disabled={mutate.isPending}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                data-testid="backup-now-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmTrigger}
                disabled={!descValid || mutate.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                data-testid="backup-now-confirm"
              >
                {mutate.isPending ? <Loader2 size={14} className="animate-spin" /> : <PlayCircle size={14} />}
                {mutate.isPending ? 'Triggering…' : 'Trigger backup'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
