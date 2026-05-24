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
import WalArchiveTab from '@/components/system-backup/WalArchiveTab';
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
        scheduleSubsystems={['system_pitr']}
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
            <WalArchiveTab />
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
 * see docs/02-operations/PG_MAJOR_UPGRADE.md). A future multi-cluster
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
  const [resultBanner, setResultBanner] = useState<
    | null
    | { kind: 'ok'; backupName: string }
    | { kind: 'err'; message: string }
  >(null);

  const trigger = (): void => {
    setResultBanner(null);
    void (async () => {
      try {
        const r = await mutate.mutateAsync({
          namespace: 'platform',
          clusterName: 'system-db',
        });
        setResultBanner({ kind: 'ok', backupName: r.data.backupName });
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
        onClick={trigger}
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
          {resultBanner.backupName} — appears in the catalogue list once CNPG completes the upload.
        </span>
      )}
      {resultBanner?.kind === 'err' && (
        <span className="inline-flex items-center gap-1 text-xs text-rose-700 dark:text-rose-300" data-testid="system-backup-now-error">
          <AlertCircle size={12} /> {resultBanner.message}
        </span>
      )}
    </div>
  );
}
