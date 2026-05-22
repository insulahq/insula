/**
 * `/backups/mail` — Mail backup-class page.
 *
 * Phase 3 (2026-05-22) rewrites the Phase 1 stub on top of the
 * shared `<BackupClassPage>` shell.
 *
 *   (a) Snapshots — Stalwart RocksDB restic snapshots (the existing
 *       MailObjectBackupCard surfaces last-run + trigger-now). Phase 6
 *       Restoration Wizard adds row-click restore.
 *   (b) Backups   — Same restic flow viewed from the "uploaded
 *       artifact" angle. The actual restic snapshot IS the upload —
 *       there is no separate "backup" object for mail today, so the
 *       Backups tab is a thin pointer to (a) until the mail JMAP+
 *       Maildir capture (TENANT_BACKUP_V2 Phase 2) introduces a
 *       distinct backup artifact.
 *   (c) Targets, Schedules & Retention — `<BackupRoutingTab>` for the
 *       `mail` shim class with the `mail` schedule row.
 */

import { Mail } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiFetch } from '@/lib/api-client';
import type { SystemBackupsOverview } from '@k8s-hosting/api-contracts';
import BackupClassPage from './BackupClassPage';
import MailObjectBackupCard from '@/components/backups/MailObjectBackupCard';

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

  return (
    <BackupClassPage
      icon={Mail}
      title="Mail Backups"
      subtitle="Stalwart RocksDB restic snapshots. Mail snapshots are uploaded directly to the Remote Storage Target as restic objects — there is no separate snapshot-vs-backup distinction today."
      shimClass="mail"
      scheduleSubsystems={['mail']}
      snapshotsTab={
        <div className="space-y-4">
          <MailObjectBackupCard ov={ov} loading={isLoading} />
        </div>
      }
      backupsTab={
        <div className="space-y-4">
          <MailObjectBackupCard ov={ov} loading={isLoading} />
          <p className="rounded border border-dashed border-gray-300 bg-gray-50 px-3 py-3 text-xs text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400">
            Mail uses restic for both the snapshot and the upload — the same artifact appears on both tabs.
            A distinct mail-bundle backup artifact will land with the JMAP+Maildir capture
            (see <Link to="/backups/disaster-recovery" className="font-medium text-brand-600 hover:underline dark:text-brand-300">Disaster Recovery</Link>{' '}
            for the roadmap).
          </p>
        </div>
      }
    />
  );
}
