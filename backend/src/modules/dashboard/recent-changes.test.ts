import { describe, it, expect } from 'vitest';
import { describeChange } from './admin-service.js';

/**
 * "The CHANGES tile is useless — always-green entries like 'update', 'create'
 * with no additional information."
 *
 * Two causes. The feed was the raw audit log, which on production is mostly
 * machine bookkeeping (1006 snapshot-last-run rows in seven days against a
 * handful of real administrative changes). And the label was the bare
 * action_type, so even a real change read as "create".
 *
 * This covers the label; the filter lives in the query.
 */
describe('describeChange', () => {
  it('names the thing that changed, not just the verb', () => {
    expect(describeChange('create', 'domain', null)).toBe('create domain');
    expect(describeChange('update', 'deployment', null)).toBe('update deployment');
    expect(describeChange('delete', 'mail', null)).toBe('delete mail');
  });

  it('adds the tenant when the row carries one', () => {
    expect(describeChange('update', 'domain', 'Acme Trading')).toBe('update domain · Acme Trading');
  });

  it('resolves a tenant id sitting in resource_type to the tenant NAME', () => {
    // Some rows carry a tenant UUID where the type belongs. A raw uuid on a
    // dashboard is worse than no label at all.
    const uuid = '80650e72-4489-498d-9177-1b2a95cb4a35';
    expect(describeChange('create', uuid, 'Zambezi Phyto')).toBe('create · Zambezi Phyto');
  });

  it('falls back to the verb when a uuid has no tenant behind it', () => {
    expect(describeChange('create', '80650e72-4489-498d-9177-1b2a95cb4a35', null)).toBe('create');
  });

  it('corrects the plural-stripped "mailboxe"', () => {
    expect(describeChange('delete', 'mailboxe', null)).toBe('delete mailbox');
    expect(describeChange('create', 'mailboxe', null)).toBe('create mailbox');
  });

  it('keeps a namespaced action readable', () => {
    expect(describeChange('mailbox.login_password.create', 'mailbox', null))
      .toBe('login_password create mailbox');
  });

  it('degrades to the verb when there is no resource at all', () => {
    expect(describeChange('create', null, null)).toBe('create');
    expect(describeChange('create', '', null)).toBe('create');
  });
});
