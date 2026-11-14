/**
 * convergeDomainDkim finishes what normalize decided, the same way for every
 * caller: nothing at all on an undecidable check, the platform's record back
 * on the provider for a restored key, a minted key's record published — and
 * the operator is told which, worded for who publishes the zone's DNS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./normalize.js', () => ({ normalizeDomainDkim: vi.fn() }));
vi.mock('./restore.js', () => ({ restorableDkimKeys: vi.fn(), republishRestoredDkim: vi.fn() }));
vi.mock('./dns-publish.js', () => ({ upsertDkimTxtRecord: vi.fn() }));

import { normalizeDomainDkim } from './normalize.js';
import { republishRestoredDkim } from './restore.js';
import { upsertDkimTxtRecord } from './dns-publish.js';
import { convergeDomainDkim, describeDkimConvergence } from './converge.js';

const normalize = normalizeDomainDkim as unknown as ReturnType<typeof vi.fn>;
const republish = republishRestoredDkim as unknown as ReturnType<typeof vi.fn>;
const upsert = upsertDkimTxtRecord as unknown as ReturnType<typeof vi.fn>;

function stubDb() {
  const updates: unknown[] = [];
  return {
    db: { update: () => ({ set: (p: unknown) => ({ where: () => { updates.push(p); return Promise.resolve(); } }) }) } as never,
    updates,
  };
}
const params = {
  accountId: 'acct' as never, stalwartDomainId: 'sw-1', emailDomainId: 'ed-1', domainId: 'd-1',
  domainName: 'shop.example.test', currentDbSelector: 'dkim-2', expectAutoPair: true, encryptionKey: 'k'.repeat(64),
};
/** A stand-in for the per-domain lock that records how it was taken. */
const locks: Array<{ id: string; wait: boolean }> = [];
const lock = async <T>(id: string, opts: { wait: boolean }, work: () => Promise<T>): Promise<T> => {
  locks.push({ id, wait: opts.wait });
  return work();
};
const result = (over: Record<string, unknown>) => ({
  activeSelector: 'dkim-1', createdSignatureId: null, createdPublicKey: null, destroyed: [], failed: [],
  restored: [], keptCopy: null, undecidable: false, ...over,
});

describe('convergeDomainDkim', () => {
  beforeEach(() => { vi.clearAllMocks(); locks.length = 0; });

  it('an undecidable check changes nothing: no selector persisted, nothing published', async () => {
    normalize.mockResolvedValue(result({ undecidable: true }));
    const { db, updates } = stubDb();
    const r = await convergeDomainDkim(db, params, { lock, zoneHostedHere: async () => true });
    expect(r).toMatchObject({ undecidable: true, activeSelector: null, minted: false, restored: [] });
    expect(updates).toEqual([]);
    expect(republish).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(describeDkimConvergence('shop.example.test', r)).toMatch(/NOT restored yet and no new key was made/);
  });

  it('a restore persists the selector and puts the platform\'s record back; the operator is told no DNS change', async () => {
    const restored = [{ selector: 'dkim-2', privateKeyPem: 'x', publicKeySpki: 'S', matchedBy: 'platform' }];
    normalize.mockResolvedValue(result({ activeSelector: 'dkim-2', restored }));
    const { db, updates } = stubDb();
    const r = await convergeDomainDkim(db, params, { lock, zoneHostedHere: async () => true });
    expect(updates).toEqual([{ dkimActiveSelector: 'dkim-2' }]);
    expect(republish).toHaveBeenCalledWith(db, expect.objectContaining({ domainId: 'd-1', restored }));
    expect(upsert).not.toHaveBeenCalled();
    expect(describeDkimConvergence('shop.example.test', r)).toMatch(/no DNS change is needed/);
  });

  it('for a zone hosted elsewhere, the restore says to verify the record at the DNS provider', async () => {
    normalize.mockResolvedValue(result({ restored: [{ selector: 'dkim-1', privateKeyPem: 'x', publicKeySpki: 'S', matchedBy: 'dns' }] }));
    const r = await convergeDomainDkim(stubDb().db, params, { lock, zoneHostedHere: async () => false });
    const text = describeDkimConvergence('shop.example.test', r);
    expect(text).toMatch(/verify the record at your DNS provider/);
    expect(text).not.toMatch(/no DNS change is needed/);
  });

  it('a minted key has its record published, and the text says who must publish it', async () => {
    normalize.mockResolvedValue(result({ createdPublicKey: 'PEM', keptCopy: true }));
    const hostedR = await convergeDomainDkim(stubDb().db, params, { lock, zoneHostedHere: async () => true });
    expect(upsert).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ selector: 'dkim-1', publicKey: 'PEM' }));
    expect(hostedR).toMatchObject({ minted: true, txtPublished: true, keptCopy: true });
    expect(describeDkimConvergence('shop.example.test', hostedR)).toMatch(/republished it/);

    const externalR = await convergeDomainDkim(stubDb().db, params, { lock, zoneHostedHere: async () => false });
    expect(externalR.txtPublished).toBe(false);
    expect(describeDkimConvergence('shop.example.test', externalR)).toMatch(/update the record at their DNS provider/);
  });

  // Two runs at once could both mint dkim-1 (Stalwart, the copy and DNS on three keys).
  it('runs under the domain lock: waiting by default, failing fast for the staff route', async () => {
    normalize.mockResolvedValue(result({}));
    await convergeDomainDkim(stubDb().db, params, { lock, zoneHostedHere: async () => true });
    await convergeDomainDkim(stubDb().db, { ...params, waitForLock: false }, { lock, zoneHostedHere: async () => true });
    expect(locks).toEqual([{ id: 'ed-1', wait: true }, { id: 'ed-1', wait: false }]);
  });

  it('a busy lock is the caller error, and nothing runs', async () => {
    const { DkimDomainBusyError } = await import('./lock.js');
    const busy = async () => { throw new DkimDomainBusyError('ed-1'); };
    await expect(convergeDomainDkim(stubDb().db, params, { lock: busy })).rejects.toBeInstanceOf(DkimDomainBusyError);
    expect(normalize).not.toHaveBeenCalled();
  });

  // A kept key Stalwart refused: what did come back is still recorded.
  it('records the selectors that came back even when part of the run is undecidable', async () => {
    const restored = [{ selector: 'dkim-1', privateKeyPem: 'x', publicKeySpki: 'S', matchedBy: 'platform' }];
    normalize.mockResolvedValue(result({ activeSelector: 'dkim-1', restored, undecidable: true }));
    const { db, updates } = stubDb();
    const r = await convergeDomainDkim(db, params, { lock, zoneHostedHere: async () => true });
    expect(r).toMatchObject({ undecidable: true, restored: ['dkim-1'], minted: false, activeSelector: 'dkim-1' });
    expect(updates).toEqual([{ dkimActiveSelector: 'dkim-1' }]);
    expect(republish).toHaveBeenCalled();
  });
});
