import { Mail, Globe, Shield, Server } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import MailHealthBanner from '@/components/MailHealthBanner';
import { useAdminEmailDomains } from '@/hooks/use-email';

/**
 * Shared header for every `/email/*` child page.
 *
 * Sits at the top of EmailDomains / EmailSettings / EmailOperations so
 * the operator always sees:
 *   - the page title + top-level identity (Mail icon)
 *   - the 4 stat tiles (Domains, Mailboxes, DKIM-OK, Mail Server name)
 *   - the live MailHealthBanner (real Stalwart pod + JMAP + ports + cert
 *     + deliverability probes — see backend/src/modules/mail-admin/health.ts)
 *
 * Pulled out of the legacy EmailManagement.tsx during the IA split that
 * moved Email out of /settings/email into its own sidebar group with
 * per-section child pages.
 */
export default function EmailPageHeader({ subtitle }: { readonly subtitle?: string }) {
  const { data: domainsRes, isLoading: domainsLoading } = useAdminEmailDomains();
  const domains = domainsRes?.data ?? [];
  const totalMailboxes = domains.reduce((sum, d) => sum + (d.mailboxCount ?? 0), 0);
  const dkimOk = domains.filter((d) => d.dkimProvisioned).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Mail size={28} className="text-gray-700 dark:text-gray-300" />
        <div>
          <h1
            className="text-2xl font-bold text-gray-900 dark:text-gray-100"
            data-testid="email-mgmt-heading"
          >
            Email Management
          </h1>
          {subtitle && (
            <p className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Email Domains"
          value={domainsLoading ? '...' : domains.length}
          icon={Globe}
          accent="brand"
        />
        <StatCard
          title="Total Mailboxes"
          value={domainsLoading ? '...' : totalMailboxes}
          icon={Mail}
          accent="green"
        />
        <StatCard
          title="DKIM Configured"
          value={domainsLoading ? '...' : `${dkimOk}/${domains.length}`}
          icon={Shield}
          accent="amber"
        />
        <StatCard title="Mail Server" value="Stalwart" icon={Server} accent="green" />
      </div>

      <MailHealthBanner />
    </div>
  );
}
