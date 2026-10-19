/**
 * Every tenant-panel page the admin links into must exist in the tenant panel:
 * a renamed route there would otherwise turn these links into its "Page Not
 * Found" without any test noticing. Read as text, like the admin link guard.
 */
import { describe, it, expect } from 'vitest';
import { tenantPanel, type TenantEmailTab } from './tenant-panel-paths';
// Vite's ?raw: this workspace typechecks without node types.
import tenantApp from '../../../../tenant-panel/src/App.tsx?raw';
import tenantTabs from '../../../../tenant-panel/src/routes/tabbed-pages.ts?raw';

const routePaths = [...tenantApp.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]!);

function routed(path: string): boolean {
  const segments = path.split('?')[0]!.replace(/^\//, '').split('/');
  return routePaths.some((route) => {
    const parts = route.split('/');
    if (parts.length < segments.length && !parts.at(-1)?.endsWith('?')) return false;
    return segments.every((seg, i) => {
      const part = parts[i];
      if (part === undefined) return false;
      return part.startsWith(':') || part === seg;
    });
  });
}

describe('tenant-panel paths', () => {
  const samples = [
    tenantPanel.domains(), tenantPanel.domain('d1'), tenantPanel.applications(), tenantPanel.cronJobs(),
    tenantPanel.databases(), tenantPanel.files(), tenantPanel.snapshots(), tenantPanel.backups(),
    tenantPanel.users(), tenantPanel.sftp(), tenantPanel.sshKeys(),
    tenantPanel.mailbox('ed1', 'm1'), tenantPanel.mailingList('ed1', 'a1'), tenantPanel.migration('j1', 'edit', 'ed1'),
  ];

  it.each(samples)('%s is a route of the tenant panel', (path) => {
    expect(routed(path)).toBe(true);
  });

  it('every email tab linked to is a tab of the tenant panel’s email page', () => {
    const declared = tenantTabs.match(/'\/email':\s*\[([^\]]*)\]/)?.[1] ?? '';
    const tabs: TenantEmailTab[] = ['mailboxes', 'aliases', 'settings', 'statistics', 'dmarc', 'abuse', 'tls'];
    for (const t of tabs) expect(declared).toContain(`'${t}'`);
  });

  it('names the item for the email page to open, and encodes it', () => {
    expect(tenantPanel.mailbox('ed 1', 'm/1')).toBe('/email/mailboxes?emailDomain=ed+1&mailbox=m%2F1');
    expect(tenantPanel.migration('j1')).toBe('/email/mailboxes?migration=j1');
    expect(tenantPanel.email('settings')).toBe('/email/settings');
  });
});
