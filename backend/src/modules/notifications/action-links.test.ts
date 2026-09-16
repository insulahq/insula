import { describe, it, expect } from 'vitest';
import {
  resolveNotificationLinks,
  renderActionButtons,
  inlineLink,
  escapeHtml,
  isAdminCategory,
} from './action-links.js';

const ADMIN = 'https://admin.example.test';
const TENANT = 'https://panel.example.test/';

describe('resolveNotificationLinks', () => {
  it('sends an admin category to the admin panel and a tenant one to the tenant panel', () => {
    const a = resolveNotificationLinks({
      categoryId: 'admin.backup_failed',
      resourceType: null, resourceId: null, tenantId: null,
      adminBaseUrl: ADMIN, tenantBaseUrl: TENANT,
    });
    expect(a[0]?.url.startsWith(ADMIN)).toBe(true);

    const t = resolveNotificationLinks({
      categoryId: 'tenant.email_quota_exceeded',
      resourceType: null, resourceId: null, tenantId: 't1',
      adminBaseUrl: ADMIN, tenantBaseUrl: TENANT,
    });
    // Tenant links must never point at the admin panel — the tenant cannot
    // open it, and a dead link in a customer email is worse than no link.
    expect(t.every((l) => l.url.startsWith('https://panel.example.test'))).toBe(true);
  });

  it('deep-links a tenant-scoped admin alert to THAT tenant', () => {
    const links = resolveNotificationLinks({
      categoryId: 'admin.email_quota_exceeded',
      resourceType: 'tenant', resourceId: 't-123', tenantId: 't-123',
      adminBaseUrl: ADMIN, tenantBaseUrl: TENANT,
    });
    // Production pointed this at /tenants — the list, which shows no sending
    // limits at all, so the click told the operator nothing.
    expect(links[0]?.url).toBe(`${ADMIN}/tenants/t-123`);
  });

  it('carries more than one link, primary first', () => {
    const links = resolveNotificationLinks({
      categoryId: 'admin.email_quota_exceeded',
      resourceType: 'tenant', resourceId: 't-123', tenantId: 't-123',
      adminBaseUrl: ADMIN, tenantBaseUrl: TENANT,
    });
    expect(links.length).toBeGreaterThan(1);
    expect(links[0]?.style).toBe('primary');
    expect(links.some((l) => l.text === 'Open mail operations')).toBe(true);
  });

  it('strips a trailing slash from the configured base', () => {
    const links = resolveNotificationLinks({
      categoryId: 'tenant.email_quota_exceeded',
      resourceType: null, resourceId: null, tenantId: 't1',
      adminBaseUrl: ADMIN, tenantBaseUrl: TENANT,
    });
    expect(links[0]?.url).not.toContain('//email');
  });

  it('returns NO links when the panel URL is unconfigured', () => {
    // A relative path in an email is a dead link, and a dead link costs the
    // reader a click to discover that it is one.
    const links = resolveNotificationLinks({
      categoryId: 'admin.backup_failed',
      resourceType: null, resourceId: null, tenantId: null,
      adminBaseUrl: null, tenantBaseUrl: TENANT,
    });
    expect(links).toEqual([]);
  });

  it('returns no links for a category with no landing page', () => {
    const links = resolveNotificationLinks({
      categoryId: 'nonexistent.category',
      resourceType: null, resourceId: null, tenantId: null,
      adminBaseUrl: ADMIN, tenantBaseUrl: TENANT,
    });
    expect(links).toEqual([]);
  });
});

describe('isAdminCategory', () => {
  it('splits on the id prefix, which is what the panel routing uses', () => {
    expect(isAdminCategory('admin.backup_failed')).toBe(true);
    expect(isAdminCategory('tenant.suspended')).toBe(false);
    expect(isAdminCategory('mailbox.quota_exceeded')).toBe(false);
  });
});

describe('escaping', () => {
  it('escapes a label before it goes inside an anchor', () => {
    // The label is real data — a tenant name — and the template has opted out
    // of escaping to render the anchor at all, so this is the only escape.
    const html = inlineLink('<script>alert(1)</script> Ltd', 'https://x.test/a');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes a quote in a URL so it cannot break out of the attribute', () => {
    expect(escapeHtml('https://x.test/"onmouseover="evil()')).toContain('&quot;');
  });

  it('returns null rather than an anchor with no label or no target', () => {
    expect(inlineLink(null, 'https://x.test')).toBeNull();
    expect(inlineLink('Example Ltd', null)).toBeNull();
    expect(inlineLink('   ', 'https://x.test')).toBeNull();
  });
});

describe('renderActionButtons', () => {
  it('renders one mj-button per link', () => {
    const html = renderActionButtons([
      { text: 'Open', url: 'https://x.test/a', style: 'primary' },
      { text: 'Review', url: 'https://x.test/b', style: 'secondary' },
    ]);
    expect(html.match(/<mj-button/g)).toHaveLength(2);
    expect(html).toContain('https://x.test/b');
  });

  it('renders nothing for no links, so the wrapper collapses cleanly', () => {
    expect(renderActionButtons([])).toBe('');
  });
});
