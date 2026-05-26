import EmailPageHeader from '@/components/email/EmailPageHeader';
import EmailDomainsSection from '@/components/email/EmailDomainsSection';

/**
 * Email → Domains & Relays.
 *
 * Daily-driver page for operators managing per-tenant email domains
 * (mailboxes, DKIM/SPF/DMARC status, webmail toggle) and the cluster's
 * outbound SMTP relays.
 *
 * Sibling pages: EmailSettingsPage, EmailOperationsPage. They share
 * EmailPageHeader (title + stat tiles + live MailHealthBanner) so the
 * operator never loses sight of mail-server health while navigating.
 */
export default function EmailDomainsPage() {
  return (
    <div className="space-y-6">
      <EmailPageHeader subtitle="Per-tenant email domains and outbound SMTP relays." />
      <EmailDomainsSection />
    </div>
  );
}
