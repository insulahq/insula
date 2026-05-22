/**
 * `/backups/system` — System backup-class page.
 *
 * Phase 3 (2026-05-22) rebuilds the page on the shared
 * `<BackupClassPage>` shell. The three tabs:
 *
 *   (a) Snapshots — block-level snapshots for system PVCs.
 *       SystemSnapshotsSection already lists per-PVC snapshot rows.
 *
 *   (b) Backups   — off-cluster backups: postgres PITR base, CNPG
 *       ScheduledBackup health, secrets bundle, system databases,
 *       WAL archive.
 *
 *   (c) Targets, Schedules & Retention — `<BackupRoutingTab>` for
 *       the `system` shim class with the `system_pitr` schedule row.
 *
 * Compared to the old 5-tab page: dropped "Restore" (replaced by the
 * per-snapshot/per-backup Restoration Wizard in Phase 6) and "DR
 * Drill" (moved to /backups/disaster-recovery in Phase 5). Activity
 * lives on the Dashboard now.
 */

import { KeyRound } from 'lucide-react';
import BackupClassPage from './BackupClassPage';
import SystemSnapshotsSection from '@/components/SystemSnapshotsSection';
import { CnpgBackupHealthCard } from '@/components/CnpgBackupHealthCard';
import SecretsBundleTab from '@/components/system-backup/SecretsBundleTab';
import SystemDatabasesTab from '@/components/system-backup/SystemDatabasesTab';
import WalArchiveTab from '@/components/system-backup/WalArchiveTab';

export default function SystemBackupsPage() {
  return (
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
          {/* CNPG ScheduledBackup health (rolled-up cluster-side state). */}
          <CnpgBackupHealthCard />
          <SecretsBundleTab />
          <SystemDatabasesTab />
          <WalArchiveTab />
        </div>
      }
    />
  );
}
