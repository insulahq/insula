import { useState } from 'react';
import { Server, Network, Archive as ArchiveIcon, HardDrive } from 'lucide-react';
import EmailPageHeader from '@/components/email/EmailPageHeader';
import MailSectionCard from '@/components/MailSectionCard';
import MailDrCard from '@/components/MailDrCard';
import MailPortExposureCard from '@/components/MailPortExposureCard';
import MailArchiveCard from '@/components/MailArchiveCard';
import MailNodeStorageCards from '@/components/email/MailNodeStorageCards';
import StalwartBlobStoreCard from '@/components/StalwartBlobStoreCard';

type OpsTab = 'placement' | 'backups' | 'storage';

/**
 * Email → Operations.
 *
 * Day-99 actions: mail-server placement & DR (failover/failback/migrate +
 * standby data freshness), point-in-time archive via `stalwart -e`, and
 * the per-PVC storage view.
 */
export default function EmailOperationsPage() {
  const [tab, setTab] = useState<OpsTab>('placement');

  return (
    <div className="space-y-6">
      <EmailPageHeader subtitle="Placement & DR • Mail archive (DR export) • Storage." />

      <MailSectionCard
        icon={Server}
        title="Operations"
        summary="Placement & migration • Mail archive (DR export) • Storage"
        dataTestId="mail-section-operations"
        storageKey="operations"
        defaultOpen
      >
        <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
          {[
            { key: 'placement' as OpsTab, label: 'Placement & migration', icon: Network },
            { key: 'backups' as OpsTab, label: 'Backups', icon: ArchiveIcon },
            { key: 'storage' as OpsTab, label: 'Storage', icon: HardDrive },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium ${
                tab === t.key
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
              data-testid={`ops-tab-${t.key}`}
            >
              <t.icon size={13} />
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'placement' && (
          <div className="space-y-4">
            <MailDrCard />
            {/* Port exposure as Advanced collapsible — allServerNodes is
                the default since Phase 2. Toggle retained for debugging
                single-node installs but rarely needed. */}
            <details className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
              <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                Advanced — port exposure (debugging only)
              </summary>
              <div className="border-t border-gray-200 dark:border-gray-700 p-4">
                <MailPortExposureCard />
              </div>
            </details>
          </div>
        )}

        {tab === 'backups' && (
          <div className="space-y-3">
            {/* Mail backup vocabulary cheatsheet. */}
            <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 px-4 py-3 text-xs text-blue-900 dark:text-blue-200 space-y-1">
              <p className="font-semibold">Three distinct mail-backup paths — pick by recovery need:</p>
              <ul className="space-y-0.5 ml-4 list-disc">
                <li>
                  <strong>Archive</strong> (below) — Stalwart-native <code className="font-mono">stalwart -e</code> LZ4 export. Whole-server point-in-time. Use for DR drills + monthly cold backup.
                </li>
                <li>
                  <strong>Snapshots</strong> — restic CronJob of the mail PVC, configured under{' '}
                  <a href="/backups/system?tab=object" className="font-medium underline">System Backups → Object Backups</a>.
                </li>
                <li>
                  <strong>Per-tenant bundles</strong> — mailbox-only capture via the engine picked in{' '}
                  <a href="/email/settings" className="font-medium underline">Email → Settings → Backup Engine</a>. Used by the Plesk-style tenant restore cart.
                </li>
              </ul>
            </div>
            <MailArchiveCard />
          </div>
        )}

        {tab === 'storage' && (
          <div className="space-y-4">
            <MailNodeStorageCards />
            <details className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
              <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                Blob store (S3-compatible, for large attachments)
              </summary>
              <div className="border-t border-gray-200 dark:border-gray-700 p-4">
                <StalwartBlobStoreCard />
              </div>
            </details>
          </div>
        )}
      </MailSectionCard>
    </div>
  );
}
