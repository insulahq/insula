import { Server, Network, HardDrive } from 'lucide-react';
import EmailPageHeader from '@/components/email/EmailPageHeader';
import MailSectionCard from '@/components/MailSectionCard';
import MailDrCard from '@/components/MailDrCard';
import MailPortExposureCard from '@/components/MailPortExposureCard';
import MailNodeStorageCards from '@/components/email/MailNodeStorageCards';
import { useTabParam } from '@/hooks/use-tab-param';
import type { TabOf } from '@/routes/tabbed-pages';

type OpsTab = TabOf<'/email/operations'>;

/**
 * Email → Operations.
 *
 * Day-99 actions: mail-server placement & DR (failover/failback/migrate +
 * standby data freshness) and the per-PVC storage view.
 *
 * The page had a third tab, Backups, whose only content was the mail archive
 * card (`stalwart -e` export). The archive is switched off — its code is kept
 * dormant, see backend `mail-admin/archive-dormant.ts` — so the tab is gone
 * with it. Mail backups are under Backups → Mail.
 */

export default function EmailOperationsPage() {
  const [tab, setTab] = useTabParam('/email/operations');

  return (
    <div className="space-y-6">
      <EmailPageHeader subtitle="Placement & DR • Storage." />

      <MailSectionCard
        icon={Server}
        title="Operations"
        summary="Placement & migration • Storage"
        dataTestId="mail-section-operations"
        storageKey="operations"
        defaultOpen
      >
        <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
          {[
            { key: 'placement' as OpsTab, label: 'Placement & migration', icon: Network },
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
            {/* Always visible: which nodes publish the mail ports is part of
                placement, and an operator should not have to know to open a
                "debugging only" fold to see it (operator request). */}
            <MailPortExposureCard />
          </div>
        )}

        {tab === 'storage' && (
          <div className="space-y-4">
            <MailNodeStorageCards />
            {/* Blob-store switch UI removed (ADR-046): the platform stays on
                Stalwart's Default (RocksDB) blob store. The switch feature was
                fenced after live E2E found it inoperative (config only applies
                on restart, schema-invalid S3 cli fields, Flux strips the CIFS
                Deployment patch). Backend module retained as STALE reference. */}
          </div>
        )}
      </MailSectionCard>
    </div>
  );
}
