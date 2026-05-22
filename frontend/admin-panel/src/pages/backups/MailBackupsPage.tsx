/**
 * `/backups/mail` — Mail backup-class page.
 *
 * Honesty/B0 (2026-05-22): Mail has NO snapshot mechanism. Stalwart
 * RocksDB is not snapshotted in-cluster; the only backup path is
 * restic uploading to the bound off-site target. So this page
 * exposes only TWO tabs: Backups + Targets/Schedules/Retention.
 *
 * Mail restore runs out-of-band from the recovery host
 * (`scripts/restore-mail-from-shim.sh`). The Restore… button opens
 * the wizard which routes to the Disaster Recovery page's Restore
 * Instructions section where the command is pre-filled.
 */

import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Mail, RotateCw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type { SystemBackupsOverview } from '@k8s-hosting/api-contracts';
import BackupClassPage from './BackupClassPage';
import MailObjectBackupCard from '@/components/backups/MailObjectBackupCard';
import RestorationWizard, {
  type RestoreArtifact,
  type RestorationWizardPrecheck,
} from '@/components/backups/RestorationWizard';

function useSystemOverview() {
  return useQuery({
    queryKey: ['admin', 'backups', 'system', 'overview'],
    queryFn: () => apiFetch<{ data: SystemBackupsOverview }>('/api/v1/admin/backups/system/overview'),
    staleTime: 15_000,
  });
}

export default function MailBackupsPage() {
  const { data, isLoading } = useSystemOverview();
  const ov = data?.data;
  const [wizardOpen, setWizardOpen] = useState(false);
  const navigate = useNavigate();

  const m = ov?.objectBackups.mail;
  const targetName = m?.targetName ?? null;

  const restoreButton = (
    <button
      type="button"
      onClick={() => setWizardOpen(true)}
      disabled={!targetName}
      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
      data-testid="mail-restore-open"
      title={targetName ? 'Open the Restoration Wizard' : 'Bind a target first'}
    >
      <RotateCw size={14} /> Restore…
    </button>
  );

  const wizardArtifact: RestoreArtifact = {
    kind: 'backup',
    id: 'mail-restic',
    displayName: targetName ? `Stalwart restic repo @ ${targetName}` : 'Stalwart restic repo',
    sizeBytes: m?.totalSnapshotSizeBytes ?? undefined,
    createdAt: m?.lastRunAt ?? null,
  };

  const wizardPrechecks: ReadonlyArray<RestorationWizardPrecheck> = [
    {
      severity: 'warn',
      message:
        'Mail restic restore runs out-of-band from the recovery host — the platform-api does not have shell access into the target VM. On submit you will be navigated to the Restore Instructions section of the Disaster Recovery page where the command is pre-filled.',
    },
    {
      severity: 'info',
      message: targetName
        ? `Will restore from the bound target "${targetName}" (mail shim class). Manage at /backups/mail → Targets, Schedules & Retention.`
        : 'No mail target bound — restore is not possible.',
    },
  ];

  return (
    <>
      <BackupClassPage
        icon={Mail}
        title="Mail Backups"
        subtitle="Stalwart RocksDB restic uploads to the bound off-site target. Mail has no in-cluster snapshot path — restic IS the backup, written straight to the Remote Storage Target."
        shimClass="mail"
        scheduleSubsystems={['mail']}
        // No `snapshotsTab` → tab is suppressed by the shell.
        backupsTab={
          <div className="space-y-4">
            <div className="flex items-center justify-end">{restoreButton}</div>
            <MailObjectBackupCard ov={ov} loading={isLoading} />
            <p className="rounded border border-dashed border-gray-300 bg-gray-50 px-3 py-3 text-xs text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400">
              The platform-api does not currently enumerate the restic snapshots in the off-site repo
              (that requires running <code>restic snapshots</code> with the password Secret). The card
              above reports the last upload from the in-cluster sidecar. To list snapshots for a
              specific restore see{' '}
              <Link to="/backups/disaster-recovery?section=instructions" className="font-medium text-brand-600 hover:underline dark:text-brand-300">
                Disaster Recovery → Restore Instructions
              </Link>.
            </p>
          </div>
        }
      />

      {wizardOpen && (
        <RestorationWizard
          artifact={wizardArtifact}
          prechecks={wizardPrechecks}
          onClose={() => setWizardOpen(false)}
          onSubmit={async () => {
            navigate('/backups/disaster-recovery?section=instructions');
            return { taskId: 'mail-restore-instructions' };
          }}
        />
      )}
    </>
  );
}
