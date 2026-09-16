import { describe, it, expect } from 'vitest';
import {
  formatOccurredAt,
  normaliseDateVariables,
  greetingFor,
  findIds,
  resolveIdVariables,
} from './envelope.js';

describe('formatOccurredAt', () => {
  it('turns a raw ISO instant into something a customer can read', () => {
    // Production has been mailing customers `2026-09-21T00:00:00.000Z`.
    expect(formatOccurredAt('2026-09-21T00:00:00.000Z')).toBe('2026-09-21 00:00 UTC');
  });

  it('accepts a Date as well as a string', () => {
    expect(formatOccurredAt(new Date('2026-09-14T10:30:00Z'))).toBe('2026-09-14 10:30 UTC');
  });

  it('passes an unparseable string through rather than showing "Invalid Date"', () => {
    expect(formatOccurredAt('next Tuesday')).toBe('next Tuesday');
  });

  it('returns null for absent values so the caller can decide', () => {
    expect(formatOccurredAt(null)).toBeNull();
    expect(formatOccurredAt(undefined)).toBeNull();
  });
});

describe('normaliseDateVariables', () => {
  it('formats every date-shaped variable', () => {
    const out = normaliseDateVariables({
      expiresAt: '2026-09-21T00:00:00.000Z',
      newExpiresAt: '2026-10-01T12:00:00.000Z',
    });
    expect(out.expiresAt).toBe('2026-09-21 00:00 UTC');
    expect(out.newExpiresAt).toBe('2026-10-01 12:00 UTC');
  });

  it('leaves non-date variables untouched', () => {
    const out = normaliseDateVariables({ percent: '90', tenantName: 'Example Ltd' });
    expect(out).toEqual({ percent: '90', tenantName: 'Example Ltd' });
  });

  it('does not invent keys that were not supplied', () => {
    expect(Object.keys(normaliseDateVariables({ a: 1 }))).toEqual(['a']);
  });
});

describe('greetingFor', () => {
  it('addresses the person by name', () => {
    expect(greetingFor('Alex Mwangi')).toBe('Hi Alex Mwangi,');
  });

  it('returns null for the address-derived pseudo-name', () => {
    // `userDisplayName` falls back to the email local part for a recipient
    // with no platform account. "Hi bookings," reads as a broken mail merge,
    // which is worse than no greeting — the operator's stated exception.
    expect(greetingFor('bookings@example.test')).toBeNull();
    expect(greetingFor('there')).toBeNull();
  });

  it('returns null rather than greeting an empty name', () => {
    expect(greetingFor(null)).toBeNull();
    expect(greetingFor('   ')).toBeNull();
  });
});

describe('findIds', () => {
  it('finds an id on its own and inside a sentence', () => {
    expect(findIds('3fd54013-fc40-4e13-adaf-ed1b5dd39f28')).toEqual([
      '3fd54013-fc40-4e13-adaf-ed1b5dd39f28',
    ]);
    expect(findIds('tenant 3fd54013-fc40-4e13-adaf-ed1b5dd39f28 sent 53')).toHaveLength(1);
  });

  it('de-duplicates and finds every distinct id', () => {
    const t = 'a 11111111-1111-1111-1111-111111111111 b 11111111-1111-1111-1111-111111111111 c 22222222-2222-2222-2222-222222222222';
    expect(findIds(t)).toHaveLength(2);
  });

  it('does not flag ordinary text', () => {
    expect(findIds('sent 53 of 50 messages this hour')).toEqual([]);
  });
});

describe('resolveIdVariables', () => {
  const TENANT = '3fd54013-fc40-4e13-adaf-ed1b5dd39f28';

  /** Branches on the projection, so lookup ORDER cannot change the outcome. */
  function db(rows: {
    tenants?: { id: string; tenantName: string }[];
    users?: { id: string; userFullName: string | null; userEmail: string }[];
    mailboxes?: { id: string; mailboxAddress: string }[];
    domains?: { id: string; domainName: string }[];
  }) {
    return {
      select: (proj: Record<string, unknown>) => {
        const keys = new Set(Object.keys(proj ?? {}));
        const result: unknown[] =
          keys.has('tenantName') ? rows.tenants ?? []
            : keys.has('userEmail') ? rows.users ?? []
              : keys.has('mailboxAddress') ? rows.mailboxes ?? []
                : keys.has('domainName') ? rows.domains ?? []
                  : [];
        const chain: Record<string, unknown> = {
          from: () => chain,
          where: () => Promise.resolve(result),
        };
        return chain;
      },
    } as unknown as Parameters<typeof resolveIdVariables>[0];
  }

  it('replaces a tenant id with the tenant name', async () => {
    const out = await resolveIdVariables(db({ tenants: [{ id: TENANT, tenantName: 'Example Ltd' }] }), {
      tenantLabel: TENANT,
    });
    expect(out.vars.tenantLabel).toBe('Example Ltd');
    expect(out.unresolved).toEqual([]);
  });

  it('replaces an id embedded in a longer sentence', async () => {
    const out = await resolveIdVariables(db({ tenants: [{ id: TENANT, tenantName: 'Example Ltd' }] }), {
      detail: `tenant ${TENANT} sent 53 of 50 messages`,
    });
    expect(out.vars.detail).toBe('tenant Example Ltd sent 53 of 50 messages');
  });

  it('never leaves a raw id in the text, even when nothing can name it', async () => {
    // The operator's instruction is absolute: an id must not reach a reader.
    // An id nothing can name is a defect to REPORT, not a string to print.
    const out = await resolveIdVariables(db({}), { tenantLabel: TENANT });
    expect(out.vars.tenantLabel).toBe('(unnamed)');
    expect(out.unresolved).toEqual([TENANT]);
  });

  it('leaves variables with no id untouched and does no queries', async () => {
    const out = await resolveIdVariables(db({}), { used: '53', limit: '50' });
    expect(out.vars).toEqual({ used: '53', limit: '50' });
    expect(out.unresolved).toEqual([]);
  });
});
