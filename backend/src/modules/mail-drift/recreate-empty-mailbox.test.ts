/**
 * Unit tests for `recreateDriftItemEmpty` — mailbox kind.
 *
 * Regression for the bug where the drift recreate path
 * called the legacy `createMailbox` shim with `name: fullAddress`
 * (e.g. "jane@xx.staging.example.test"). Stalwart 0.16 validates
 * `name` as a local-part token and rejected the create with:
 *
 *   Failed to create mailbox 'jane@xx.staging.example.test':
 *   Invalid email local part
 *
 * The new code resolves the parent Domain's stalwartDomainId, splits
 * the full address into local-part + domain, and uses the modern
 * `x:Account/set` shape (`@type: 'User'`, bare local-part `name`,
 * `domainId`). These tests pin the request shape against a captured
 * mock so a regression that re-introduces the legacy shape fails
 * loudly.
 *
 * Second regression: the payload also carried `emails: [fullAddress]`,
 * a property Stalwart 0.16's x:Account schema does not have, so every
 * recreate on a live server was refused with "Invalid key for object".
 * An earlier version of this test asserted that `emails` was SENT; the
 * mock agreed with the code, not with Stalwart. The payload now comes
 * from mailboxes/recreate-principal.ts, shared with the backup restore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const jmapCalls = vi.hoisted(() => ({
  getJmapSession: vi.fn(),
  createDomain: vi.fn(),
  accountSet: vi.fn(),
  updatePrincipal: vi.fn(),
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
    [],                             // 4. mailbox_aliases of the recreated mailbox
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
      expectedName: 'jane@xx.staging.example.test',
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
      fullAddress: 'jane@xx.staging.example.test',
      emailDomainId: 'ed-1',
      displayName: 'Jane',
      quotaMb: 0,
      status: 'active',
      mailboxType: 'mailbox',
      forwardingAddresses: null,
      autoReply: 0,
      autoReplySubject: null,
      autoReplyBody: null,
    };
    const domainRow = { id: 'ed-1', stalwartDomainId: 'd-new' };

    jmapCalls.accountSet.mockResolvedValue({
      created: { 'recreated-mailbox': { id: 'principal-new' } },
      notCreated: null,
    });

    const db = buildDbStub(driftRow, mbRow, domainRow);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await recreateDriftItemEmpty(db as any, 'drift-1', 'jane@xx.staging.example.test');

    expect(jmapCalls.accountSet).toHaveBeenCalledTimes(1);
    const args = jmapCalls.accountSet.mock.calls[0]![0]! as {
      request: { create: Record<string, Record<string, unknown>> };
    };
    const create = args.request.create['recreated-mailbox']!;
    expect(create['@type']).toBe('User');
    expect(create.name).toBe('jane');                 // BARE local-part — not the full address
    expect(create.domainId).toBe('d-new');            // resolved from email_domains
    // Stalwart 0.16 refuses any key outside its schema ("Invalid key for
    // object"); `emails` is one. Pin the exact key set createMailbox sends.
    expect(Object.keys(create).sort()).toEqual(['@type', 'credentials', 'description', 'domainId', 'name']);
    expect(create.description).toBe('Jane');
    expect(result.newStalwartId).toBe('principal-new');
    expect(result.item.resolvedVia).toBe('recreated');
  });

  it('names a quota it could not set, and how to apply it, in the drift note', async () => {
    const driftRow = {
      id: 'drift-4', kind: 'mailbox', expectedName: 'q@x.example', expectedStalwartId: 'z',
      platformRowId: 'mb-4', firstDetectedAt: new Date(), lastSeenAt: new Date(),
      resolvedAt: null, resolvedVia: null, notes: null,
    };
    const mbRow = {
      id: 'mb-4', fullAddress: 'q@x.example', emailDomainId: 'ed-4', displayName: null,
      quotaMb: 100, status: 'active', mailboxType: 'mailbox', forwardingAddresses: null,
      autoReply: 0, autoReplySubject: null, autoReplyBody: null,
    };
    jmapCalls.accountSet.mockResolvedValue({ created: { 'recreated-mailbox': { id: 'p-4' } }, notCreated: null });
    jmapCalls.updatePrincipal.mockRejectedValue(new Error('stalwart 503'));

    const db = buildDbStub(driftRow, mbRow, { id: 'ed-4', stalwartDomainId: 'd-4' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await recreateDriftItemEmpty(db as any, 'drift-4', 'q@x.example');

    expect(result.newStalwartId).toBe('p-4');
    expect(result.followUp).toContain("Its quota could not be set on the mail server: save the mailbox's quota again.");
    expect(result.followUp).not.toContain('15-minute reconcile');
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
