import { Mail, Globe, Shield, HardDrive } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import MailHealthBanner from '@/components/MailHealthBanner';
import { useAdminEmailDomains } from '@/hooks/use-email';
import { useMailNodeStorage } from '@/hooks/use-mail-node-storage';

/**
 * Shared header for every `/email/*` child page.
 *
 * Sits at the top of EmailDomains / EmailSettings / EmailOperations so
 * the operator always sees:
 *   - the page title + top-level identity (Mail icon)
 *   - the 4 stat tiles (Storage used, Domains, Mailboxes, DKIM-OK)
 *
 * The lead tile used to read "Mail Server: Stalwart" — a constant. It never
 * changed, never told the operator anything they could act on, and occupied
 * the most prominent slot in the row. Replaced with the one mail number that
 * does move: how much disk the mail data is actually using.
 *   - the live MailHealthBanner (real Stalwart pod + JMAP + ports + cert
 *     + deliverability probes — see backend/src/modules/mail-admin/health.ts)
 *
 * Pulled out of the legacy EmailManagement.tsx during the IA split that
 * moved Email out of /settings/email into its own sidebar group with
 * per-section child pages.
 */
/** Bytes → short human string. Mirrors MailNodeStorageCards' formatter so the
 *  tile and the per-node cards below it never disagree on units. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export default function EmailPageHeader({ subtitle }: { readonly subtitle?: string }) {
  const { data: domainsRes, isLoading: domainsLoading } = useAdminEmailDomains();
  const domains = domainsRes?.data ?? [];
  const totalMailboxes = domains.reduce((sum, d) => sum + (d.mailboxCount ?? 0), 0);
  const dkimOk = domains.filter((d) => d.dkimProvisioned).length;

  // Mail lives on one node at a time, so "storage used" is the active node's
  // measured mail data. Sum defensively in case a future placement reports
  // more than one active card; standby copies are excluded because they are a
  // replica of the same mail, not additional consumption.
  const storage = useMailNodeStorage();
  // `?.data?.nodes` — not `?.data.nodes`. This header sits above every /email/*
  // page, so a null or unexpected payload here must degrade the ONE tile, not
  // throw and blank the whole page including the domains table below it.
  const activeNodes = (storage.data?.data?.nodes ?? []).filter((n) => n.isActive);
  const mailUsedBytes = activeNodes.reduce<number | null>(
    (sum, n) => (n.mailUsedBytes == null ? sum : (sum ?? 0) + n.mailUsedBytes),
    null,
  );

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
          title="Storage Usage"
          value={
            storage.isLoading
              ? '...'
              : mailUsedBytes == null
                ? '—'
                : formatBytes(mailUsedBytes)
          }
          icon={HardDrive}
          accent="brand"
        />
        <StatCard
          title="Email Domains"
          value={domainsLoading ? '...' : domains.length}
          icon={Globe}
          accent="green"
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
      </div>

      <MailHealthBanner />
    </div>
  );
}
