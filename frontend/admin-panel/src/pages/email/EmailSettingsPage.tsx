import { useState } from 'react';
import { Server, Mail, Package, Settings, Shield } from 'lucide-react';
import EmailPageHeader from '@/components/email/EmailPageHeader';
import MailSectionCard from '@/components/MailSectionCard';
import MailSettingsTab from '@/components/mail-settings/MailSettingsTab';
import WebmailSettingsTab from '@/components/mail-settings/WebmailSettingsTab';
import MailboxBackupEngineSection from '@/components/mail-settings/MailboxBackupEngineSection';
import StalwartAdminPanel from '@/components/StalwartAdminPanel';

type SettingsTab = 'mail' | 'webmail' | 'bundle-engine';

/**
 * Email → Settings.
 *
 * Houses the platform-side mail-server configuration: the SMTP/IMAP
 * hostname Stalwart advertises, the webmail engine + URL, the mailbox-
 * backup engine selector — plus a separate collapsible card embedding
 * the upstream Stalwart web-admin UI for everything the platform
 * doesn't surface natively (advanced filters, log inspection, etc).
 */
export default function EmailSettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('mail');

  return (
    <div className="space-y-6">
      <EmailPageHeader subtitle="Mail-server hostname, webmail engine, mailbox-backup engine, Stalwart admin." />

      <MailSectionCard
        icon={Settings}
        title="Settings"
        summary="Mail hostname • Webmail engine + URL • Mailbox-backup engine"
        dataTestId="mail-section-settings"
        storageKey="mail-settings"
        defaultOpen
      >
        <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
          {[
            { key: 'mail' as SettingsTab, label: 'Server', icon: Server },
            { key: 'webmail' as SettingsTab, label: 'Webmail', icon: Mail },
            { key: 'bundle-engine' as SettingsTab, label: 'Backup Engine', icon: Package },
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
              data-testid={`settings-tab-${t.key}`}
            >
              <t.icon size={13} />
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'mail' && <MailSettingsTab />}
        {tab === 'webmail' && <WebmailSettingsTab />}
        {tab === 'bundle-engine' && <MailboxBackupEngineSection />}
      </MailSectionCard>

      <MailSectionCard
        icon={Shield}
        title="Stalwart admin UI"
        summary="Direct access to the upstream Stalwart web admin (advanced)"
        dataTestId="mail-section-stalwart-admin"
        storageKey="stalwart-admin"
      >
        <StalwartAdminPanel />
      </MailSectionCard>
    </div>
  );
}
