/**
 * `/backups/mail` — Mail backup-class page.
 *
 * Phase 7 (2026-05-22) added a "Restore…" action so operators can
 * open the Restoration Wizard for the mail flow. Mail restore is
 * operator-driven from the recovery host (`scripts/restore-mail-
 * from-shim.sh` — see /backups/disaster-recovery → Restore
 * Instructions). The wizard renders a precheck that explains the
 * command must run out-of-band, and on submit navigates the
 * operator to the DR page's Restore Instructions section so the
 * right command is one click away.
 *
 * Phase 3 split (unchanged): both tabs render `<MailObjectBackupCard>`
 * because Stalwart restic conflates snapshot + backup as one artifact
 * today. The distinct mail-bundle artifact lands with TENANT_BACKUP_V2
 * Phase 2 (JMAP+Maildir capture).
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
        subtitle="Stalwart RocksDB restic snapshots. Mail snapshots are uploaded directly to the Remote Storage Target as restic objects — there is no separate snapshot-vs-backup distinction today."
        shimClass="mail"
        scheduleSubsystems={['mail']}
        snapshotsTab={
          <div className="space-y-4">
            <div className="flex items-center justify-end">{restoreButton}</div>
            <MailObjectBackupCard ov={ov} loading={isLoading} />
          </div>
        }
        backupsTab={
          <div className="space-y-4">
            <div className="flex items-center justify-end">{restoreButton}</div>
            <MailObjectBackupCard ov={ov} loading={isLoading} />
            <p className="rounded border border-dashed border-gray-300 bg-gray-50 px-3 py-3 text-xs text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400">
              Mail uses restic for both the snapshot and the upload — the same artifact appears on both tabs.
              A distinct mail-bundle backup artifact will land with the JMAP+Maildir capture (see{' '}
              <Link to="/backups/disaster-recovery" className="font-medium text-brand-600 hover:underline dark:text-brand-300">
                Disaster Recovery
              </Link>{' '}
              for the roadmap).
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
            // Mail restore lives out-of-band — we just route the
            // operator to the DR instructions section + return a
            // stub task id so the wizard closes cleanly.
            navigate('/backups/disaster-recovery?section=instructions');
            return { taskId: 'mail-restore-instructions' };
          }}
        />
      )}
    </>
  );
}
