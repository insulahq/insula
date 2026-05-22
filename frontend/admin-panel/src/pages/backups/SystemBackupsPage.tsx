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
import { useNavigate, Link } from 'react-router-dom';
import { KeyRound, RotateCw } from 'lucide-react';
import BackupClassPage from './BackupClassPage';
import SystemSnapshotsSection from '@/components/SystemSnapshotsSection';
import { CnpgBackupHealthCard } from '@/components/CnpgBackupHealthCard';
import SystemDatabasesTab from '@/components/system-backup/SystemDatabasesTab';
import WalArchiveTab from '@/components/system-backup/WalArchiveTab';
import RestorationWizard, {
  type RestoreArtifact,
  type RestorationWizardPrecheck,
} from '@/components/backups/RestorationWizard';

export default function SystemBackupsPage() {
  const [wizardOpen, setWizardOpen] = useState(false);
  const navigate = useNavigate();

  const pgArtifact: RestoreArtifact = {
    kind: 'backup',
    id: 'postgres-pitr',
    displayName: 'Postgres PITR (base + WAL)',
  };

  const pgPrechecks: ReadonlyArray<RestorationWizardPrecheck> = [
    {
      severity: 'warn',
      message:
        'Postgres PITR runs out-of-band from the recovery host (CNPG operator promotes a new cluster from the backup). The platform-api cannot perform this restore — on submit you will be navigated to the Restore Instructions section of the Disaster Recovery page where the command is pre-filled.',
    },
    {
      severity: 'info',
      message:
        'Manage the base backup schedule + retention at /backups/system → Targets, Schedules & Retention (subsystem: system_pitr).',
    },
  ];

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
            <div className="flex items-center justify-end">
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
            <SystemDatabasesTab />
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
        <RestorationWizard
          artifact={pgArtifact}
          prechecks={pgPrechecks}
          onClose={() => setWizardOpen(false)}
          onSubmit={async () => {
            navigate('/backups/disaster-recovery?section=instructions');
            return { taskId: 'postgres-restore-instructions' };
          }}
        />
      )}
    </>
  );
}
