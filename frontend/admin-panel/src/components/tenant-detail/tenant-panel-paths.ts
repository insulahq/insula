/**
 * Pages of the TENANT panel the admin tenant page links into.
 *
 * Paths only, relative to the tenant panel's root: "Login as tenant" passes
 * one as `next`, and the tenant panel lands there after signing the operator
 * in as the tenant. Kept in one place so a renamed tenant-panel route is one
 * edit here, and so a test can hold every path against that panel's routes.
 *
 * The item parameters (`mailbox`, `alias`, `migration`) are read by the tenant
 * panel's Email page to open that item; `emailDomain` picks the domain the
 * item belongs to, since the page shows one domain at a time.
 */
export type TenantEmailTab = 'mailboxes' | 'aliases' | 'settings' | 'statistics' | 'dmarc' | 'abuse' | 'tls';

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export const tenantPanel = {
  home: (): string => '/',
  domains: (): string => '/domains',
  domain: (domainId: string): string => `/domains/${encodeURIComponent(domainId)}`,
  applications: (): string => '/applications/installed',
  cronJobs: (): string => '/cron-jobs',
  databases: (): string => '/database-manager',
  files: (): string => '/files',
  snapshots: (): string => '/snapshots',
  backups: (): string => '/backups',
  users: (): string => '/users',
  sftp: (): string => '/sftp',
  sshKeys: (): string => '/ssh-keys',
  email: (tab: TenantEmailTab, emailDomainId?: string): string =>
    withQuery(`/email/${tab}`, { emailDomain: emailDomainId }),
  mailbox: (emailDomainId: string, mailboxId: string): string =>
    withQuery('/email/mailboxes', { emailDomain: emailDomainId, mailbox: mailboxId }),
  mailingList: (emailDomainId: string, aliasId: string): string =>
    withQuery('/email/aliases', { emailDomain: emailDomainId, alias: aliasId }),
  /** A migration lives under its destination mailbox's domain. */
  migration: (jobId: string, action?: 'edit', emailDomainId?: string): string =>
    withQuery('/email/mailboxes', { emailDomain: emailDomainId, migration: jobId, action }),
};
