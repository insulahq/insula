import { describe, it, expect } from 'vitest';

import {
  domainOf,
  checkMailboxDomainOwnership,
  assertMailboxDomainsOwnedByTenant,
} from './mailbox-domain-ownership.js';

const TENANT = 'tenant-aaaa';
const OTHER = 'tenant-bbbb';

interface Row { domainName: string; domainTenantId: string; emailTenantId: string }

/** Drizzle stub: `select().from().innerJoin().where()` resolves to `rows`. */
function stubDb(rows: Row[]) {
  const chain: Record<string, unknown> = {
    innerJoin: () => chain,
    where: () => Promise.resolve(rows),
  };
  return { select: () => ({ from: () => chain }) } as never;
}

describe('domainOf', () => {
  it('lower-cases and extracts the domain', () => {
    expect(domainOf('User.Name+tag@Example.Test')).toBe('example.test');
  });

  it('rejects anything with no single answer', () => {
    // More than one @ has no unambiguous domain. A lenient parser would pick
    // the last part; here that guess is exactly what must not happen, because
    // the guess decides an ownership check.
    for (const bad of ['', 'nolocal@', '@nodomain', 'a@b@c', 'plainstring', 'a@.lead', 'a@trail.', 'a@dou..ble']) {
      expect(domainOf(bad), bad).toBeNull();
    }
  });
});

describe('checkMailboxDomainOwnership', () => {
  it('accepts addresses on a domain the tenant owns', async () => {
    const r = await checkMailboxDomainOwnership(
      stubDb([{ domainName: 'example.test', domainTenantId: TENANT, emailTenantId: TENANT }]),
      TENANT, ['a@example.test', 'b@Example.Test'],
    );
    expect(r.ok).toBe(true);
    expect(r.rejected).toEqual([]);
    expect([...r.ownedDomains]).toEqual(['example.test']);
  });

  it('rejects an address on another tenant’s domain', async () => {
    // The row EXISTS — it just belongs to someone else. Returning it as owned
    // is the cross-tenant mailbox-principal path this module exists to close.
    const r = await checkMailboxDomainOwnership(
      stubDb([{ domainName: 'victim.test', domainTenantId: OTHER, emailTenantId: OTHER }]),
      TENANT, ['admin@victim.test'],
    );
    expect(r.ok).toBe(false);
    expect(r.rejected).toEqual([{ address: 'admin@victim.test', domain: 'victim.test', reason: 'not-owned' }]);
  });

  it('rejects a domain with no email_domains row at all', async () => {
    // Nothing found means nothing owned. Creating a Stalwart domain principal
    // for a name the platform has never heard of is the other half of the hole.
    const r = await checkMailboxDomainOwnership(stubDb([]), TENANT, ['a@unknown.test']);
    expect(r.ok).toBe(false);
    expect(r.rejected[0]).toMatchObject({ domain: 'unknown.test', reason: 'not-owned' });
  });

  it('fails closed when email_domains and domains disagree on the owner', async () => {
    // Should be impossible — both cascade from tenants — but if it ever happens,
    // restore time is not the place to arbitrate.
    const r = await checkMailboxDomainOwnership(
      stubDb([{ domainName: 'split.test', domainTenantId: TENANT, emailTenantId: OTHER }]),
      TENANT, ['a@split.test'],
    );
    expect(r.ok).toBe(false);
    const r2 = await checkMailboxDomainOwnership(
      stubDb([{ domainName: 'split.test', domainTenantId: OTHER, emailTenantId: TENANT }]),
      TENANT, ['a@split.test'],
    );
    expect(r2.ok).toBe(false);
  });

  it('reports every offending address, not just the first', async () => {
    const r = await checkMailboxDomainOwnership(
      stubDb([{ domainName: 'mine.test', domainTenantId: TENANT, emailTenantId: TENANT }]),
      TENANT, ['ok@mine.test', 'a@theirs.test', 'b@theirs.test', 'bad@@x'],
    );
    expect(r.ok).toBe(false);
    expect(r.rejected.map((x) => x.address).sort()).toEqual(['a@theirs.test', 'b@theirs.test', 'bad@@x']);
  });

  it('an empty address list is vacuously ok and queries nothing', async () => {
    // Guard against the query running with an empty IN (), which some drivers
    // turn into a match-everything.
    let queried = false;
    const db = { select: () => { queried = true; return { from: () => ({ innerJoin: () => ({ where: () => Promise.resolve([]) }) }) }; } } as never;
    const r = await checkMailboxDomainOwnership(db, TENANT, []);
    expect(r.ok).toBe(true);
    expect(queried).toBe(false);
  });
});

describe('assertMailboxDomainsOwnedByTenant', () => {
  it('resolves silently when everything is owned', async () => {
    await expect(assertMailboxDomainsOwnedByTenant(
      stubDb([{ domainName: 'example.test', domainTenantId: TENANT, emailTenantId: TENANT }]),
      TENANT, ['a@example.test'],
    )).resolves.toBeUndefined();
  });

  it('throws 403 MAILBOX_DOMAIN_NOT_OWNED and does not leak the other tenant', async () => {
    await expect(assertMailboxDomainsOwnedByTenant(
      stubDb([{ domainName: 'victim.test', domainTenantId: OTHER, emailTenantId: OTHER }]),
      TENANT, ['admin@victim.test'],
    )).rejects.toMatchObject({ code: 'MAILBOX_DOMAIN_NOT_OWNED', status: 403 });

    try {
      await assertMailboxDomainsOwnedByTenant(
        stubDb([{ domainName: 'victim.test', domainTenantId: OTHER, emailTenantId: OTHER }]),
        TENANT, ['admin@victim.test'],
      );
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('victim.test');
      // Who actually holds it is not the caller's business to learn.
      expect(msg).not.toContain(OTHER);
    }
  });

  it('caps the listed addresses so a 500-address selector cannot build a huge error', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `u${i}@theirs.test`);
    try {
      await assertMailboxDomainsOwnedByTenant(stubDb([]), TENANT, many);
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('and 7 more');
      expect(msg).not.toContain('u11@theirs.test');
    }
  });
});
