/**
 * Unit tests for `recreateDriftItemEmpty` — mailbox kind.
 *
 * Regression for the 2026-05-29 bug where the drift recreate path
 * called the legacy `createMailbox` shim with `name: fullAddress`
 * (e.g. "jane@xx.staging.success.com.na"). Stalwart 0.16 validates
 * `name` as a local-part token and rejected the create with:
 *
 *   Failed to create mailbox 'jane@xx.staging.success.com.na':
 *   Invalid email local part
 *
 * The new code resolves the parent Domain's stalwartDomainId, splits
 * the full address into local-part + domain, and uses the modern
 * `x:Account/set` shape (`@type: 'User'`, bare local-part `name`,
 * `domainId`). These tests pin the request shape against a captured
 * mock so a regression that re-introduces the legacy shape fails
 * loudly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const jmapCalls = vi.hoisted(() => ({
  getJmapSession: vi.fn(),
  createDomain: vi.fn(),
  accountSet: vi.fn(),
}));

vi.mock('../stalwart-jmap/client.js', () => jmapCalls);

import { recreateDriftItemEmpty } from './service.js';

// Minimal Drizzle stub. Returns successive results in array order
// per chain (`.where()` resolves to the array). The chain only needs
// to support `.select().from().where()` and `.update().set().where()`.
function buildDbStub(driftRow: Record<string, unknown> | null, mailboxRow: Record<string, unknown> | null, domainRow: Record<string, unknown> | null) {
  const selects: Array<Array<Record<string, unknown>>> = [
    driftRow ? [driftRow] : [],   // 1. getActiveById: lookup drift item
    mailboxRow ? [mailboxRow] : [], // 2. mailbox lookup
    domainRow ? [domainRow] : [],   // 3. parent email_domains lookup
    driftRow ? [{ ...driftRow, resolvedAt: new Date(), resolvedVia: 'recreated' }] : [],
  ];
  let idx = 0;
  const stub = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(selects[idx++] ?? []),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  };
  return stub;
}

describe('recreateDriftItemEmpty: mailbox kind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jmapCalls.getJmapSession.mockResolvedValue({
      primaryAccounts: { 'urn:ietf:params:jmap:principals': 'singleton' },
    });
  });

  it('passes bare local-part as name and stalwart_domain_id as domainId (not the full address)', async () => {
    const driftRow = {
      id: 'drift-1',
      kind: 'mailbox',
      expectedName: 'jane@xx.staging.success.com.na',
      expectedStalwartId: 'b',
      platformRowId: 'mb-1',
      firstDetectedAt: new Date(),
      lastSeenAt: new Date(),
      resolvedAt: null,
      resolvedVia: null,
      notes: null,
    };
    const mbRow = {
      id: 'mb-1',
      fullAddress: 'jane@xx.staging.success.com.na',
      passwordHash: '$2b$10$placeholder',
      emailDomainId: 'ed-1',
    };
    const domainRow = { id: 'ed-1', stalwartDomainId: 'd-new' };

    jmapCalls.accountSet.mockResolvedValue({
      created: { 'recreated-mailbox': { id: 'principal-new' } },
      notCreated: null,
    });

    const db = buildDbStub(driftRow, mbRow, domainRow);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await recreateDriftItemEmpty(db as any, 'drift-1', 'jane@xx.staging.success.com.na');

    expect(jmapCalls.accountSet).toHaveBeenCalledTimes(1);
    const args = jmapCalls.accountSet.mock.calls[0]![0]! as {
      request: { create: Record<string, Record<string, unknown>> };
    };
    const create = args.request.create['recreated-mailbox']!;
    expect(create['@type']).toBe('User');
    expect(create.name).toBe('jane');                 // BARE local-part — not the full address
    expect(create.domainId).toBe('d-new');            // resolved from email_domains
    expect(create.emails).toEqual(['jane@xx.staging.success.com.na']);
    expect(result.newStalwartId).toBe('principal-new');
  });

  it('refuses when parent Domain has no stalwart_domain_id (PARENT_DOMAIN_NOT_IN_STALWART)', async () => {
    const driftRow = {
      id: 'drift-2',
      kind: 'mailbox',
      expectedName: 'bob@orphan.example',
      expectedStalwartId: 'x',
      platformRowId: 'mb-2',
      firstDetectedAt: new Date(),
      lastSeenAt: new Date(),
      resolvedAt: null,
      resolvedVia: null,
      notes: null,
    };
    const mbRow = {
      id: 'mb-2',
      fullAddress: 'bob@orphan.example',
      passwordHash: '$2b$10$placeholder',
      emailDomainId: 'ed-2',
    };
    const domainRow = { id: 'ed-2', stalwartDomainId: null }; // parent ALSO drifting

    const db = buildDbStub(driftRow, mbRow, domainRow);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recreateDriftItemEmpty(db as any, 'drift-2', 'bob@orphan.example'),
    ).rejects.toMatchObject({ code: 'PARENT_DOMAIN_NOT_IN_STALWART' });

    expect(jmapCalls.accountSet).not.toHaveBeenCalled();
  });

  it('rejects when Stalwart returns notCreated (STALWART_CREATE_REJECTED with server reason)', async () => {
    const driftRow = {
      id: 'drift-3',
      kind: 'mailbox',
      expectedName: 'alice@x.example',
      expectedStalwartId: 'y',
      platformRowId: 'mb-3',
      firstDetectedAt: new Date(),
      lastSeenAt: new Date(),
      resolvedAt: null,
      resolvedVia: null,
      notes: null,
    };
    const mbRow = {
      id: 'mb-3',
      fullAddress: 'alice@x.example',
      passwordHash: '$2b$10$placeholder',
      emailDomainId: 'ed-3',
    };
    const domainRow = { id: 'ed-3', stalwartDomainId: 'd-ok' };

    jmapCalls.accountSet.mockResolvedValue({
      created: null,
      notCreated: {
        'recreated-mailbox': {
          type: 'invalidPatch',
          description: 'Quota policy refused the principal',
          properties: ['quota'],
        },
      },
    });

    const db = buildDbStub(driftRow, mbRow, domainRow);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recreateDriftItemEmpty(db as any, 'drift-3', 'alice@x.example'),
    ).rejects.toMatchObject({
      code: 'STALWART_CREATE_REJECTED',
      message: expect.stringContaining('Quota policy refused'),
    });
  });
});
