import { describe, it, expect, vi, beforeEach } from 'vitest';

const jmapCalls = vi.hoisted(() => ({
  getJmapSession: vi.fn(),
  destroyPrincipal: vi.fn(),
}));
const dkimCalls = vi.hoisted(() => ({
  removeAllDkimSignaturesForDomain: vi.fn(),
}));

vi.mock('../stalwart-jmap/client.js', () => jmapCalls);
vi.mock('../email-dkim/cleanup.js', () => dkimCalls);

import { deleteOrphanDomain } from './service.js';

const ORPHAN_ITEM = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'orphan-domain',
  expectedName: 'mail-e2e-12345.example.test',
  expectedStalwartId: 'o',
  platformRowId: 'orphan:o',
  firstDetectedAt: new Date('2026-06-11T00:00:00Z'),
  lastSeenAt: new Date('2026-06-11T01:00:00Z'),
  resolvedAt: null,
  resolvedVia: null,
  notes: null,
};

function buildDbStub(driftRow: Record<string, unknown> | null) {
  const selects: Array<Array<Record<string, unknown>>> = [
    driftRow ? [driftRow] : [],
    driftRow ? [{ ...driftRow, resolvedAt: new Date(), resolvedVia: 'deleted' }] : [],
  ];
  let idx = 0;
  return {
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
  } as never;
}

describe('deleteOrphanDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jmapCalls.getJmapSession.mockResolvedValue({
      primaryAccounts: { 'urn:ietf:params:jmap:principals': 'd333333' },
    });
    jmapCalls.destroyPrincipal.mockResolvedValue(undefined);
    dkimCalls.removeAllDkimSignaturesForDomain.mockResolvedValue({ destroyed: ['k1', 'k2'], failed: [] });
  });

  it('destroys DKIM first, then the Domain, and resolves the item via deleted', async () => {
    const db = buildDbStub(ORPHAN_ITEM);
    const r = await deleteOrphanDomain(db, ORPHAN_ITEM.id, ORPHAN_ITEM.expectedName);
    expect(dkimCalls.removeAllDkimSignaturesForDomain).toHaveBeenCalledWith(
      expect.objectContaining({ stalwartDomainId: 'o' }),
    );
    expect(jmapCalls.destroyPrincipal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'o' }),
    );
    // DKIM strictly before Domain — Stalwart rejects linked destroys.
    expect(dkimCalls.removeAllDkimSignaturesForDomain.mock.invocationCallOrder[0])
      .toBeLessThan(jmapCalls.destroyPrincipal.mock.invocationCallOrder[0]);
    expect(r.dkimSignaturesDeleted).toBe(2);
    expect(r.item.resolvedVia).toBe('deleted');
  });

  it('rejects a confirm-name mismatch before touching Stalwart', async () => {
    const db = buildDbStub(ORPHAN_ITEM);
    await expect(deleteOrphanDomain(db, ORPHAN_ITEM.id, 'wrong.example.test'))
      .rejects.toMatchObject({ code: 'CONFIRM_NAME_MISMATCH' });
    expect(jmapCalls.destroyPrincipal).not.toHaveBeenCalled();
    expect(dkimCalls.removeAllDkimSignaturesForDomain).not.toHaveBeenCalled();
  });

  it('refuses non-orphan kinds (their Stalwart entry is MISSING — nothing to delete)', async () => {
    const db = buildDbStub({ ...ORPHAN_ITEM, kind: 'domain' });
    await expect(deleteOrphanDomain(db, ORPHAN_ITEM.id, ORPHAN_ITEM.expectedName))
      .rejects.toMatchObject({ code: 'INVALID_DRIFT_ACTION' });
  });

  it('surfaces ORPHAN_HAS_PRINCIPALS when Stalwart refuses a linked destroy (PITR false orphan)', async () => {
    jmapCalls.destroyPrincipal.mockRejectedValue(
      new Error("Failed to destroy principal 'o': objectIsLinked"),
    );
    const db = buildDbStub(ORPHAN_ITEM);
    await expect(deleteOrphanDomain(db, ORPHAN_ITEM.id, ORPHAN_ITEM.expectedName))
      .rejects.toMatchObject({ code: 'ORPHAN_HAS_PRINCIPALS' });
  });

  it('404s on unknown / already-resolved items', async () => {
    const db = buildDbStub(null);
    await expect(deleteOrphanDomain(db, ORPHAN_ITEM.id, ORPHAN_ITEM.expectedName))
      .rejects.toMatchObject({ code: 'DRIFT_ITEM_NOT_FOUND' });
  });
});
