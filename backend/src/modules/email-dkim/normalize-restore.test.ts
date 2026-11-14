/**
 * normalizeDomainDkim against a stubbed Stalwart: kept keys go back under
 * their selectors before anything is minted, and the copy kept of a NEW key is
 * exactly the key Stalwart got — without a failing copy ever failing signing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../stalwart-jmap/client.js', () => ({ dkimSignatureGet: vi.fn(), dkimSignatureSet: vi.fn() }));
vi.mock('./signatures.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./signatures.js')>()),
  createRsaDkimSignature: vi.fn(),
}));

import { dkimSignatureGet, dkimSignatureSet, type StalwartDkimSignatureRow } from '../stalwart-jmap/client.js';
import { createRsaDkimSignature, RSA_SIGNATURE_TYPE, ED25519_SIGNATURE_TYPE } from './signatures.js';
import { normalizeDomainDkim } from './normalize.js';
import type { RestorableDkimKey, RestoreCheck } from './restore.js';

const get = dkimSignatureGet as unknown as ReturnType<typeof vi.fn>;
const set = dkimSignatureSet as unknown as ReturnType<typeof vi.fn>;
const create = createRsaDkimSignature as unknown as ReturnType<typeof vi.fn>;

const row = (id: string, selector: string, type = RSA_SIGNATURE_TYPE): StalwartDkimSignatureRow =>
  ({ id, selector, domainId: 'sw-1', '@type': type, stage: 'active' }) as unknown as StalwartDkimSignatureRow;
const key = (selector: string): RestorableDkimKey =>
  ({ selector, privateKeyPem: `PEM-${selector}`, publicKeySpki: `SPKI-${selector}`, matchedBy: 'dns' });
const base = { accountId: 'acct' as never, stalwartDomainId: 'sw-1' };
const ok = (restorable: RestorableDkimKey[]): RestoreCheck => ({ restorable, undecidable: [] });

describe('normalizeDomainDkim — restore before mint', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    create.mockImplementation(async (p: { selector: string }) => `new-${p.selector}`);
    set.mockResolvedValue({ destroyed: ['auto-rsa', 'auto-ed'] });
  });

  // Stalwart recreated the domain (drift repair, DR): only its auto pair is there.
  it('puts both kept keys back and mints nothing; the persisted selector stays active', async () => {
    get.mockResolvedValue([row('auto-rsa', 'v1-rsa-x'), row('auto-ed', 'v1-ed25519-x', ED25519_SIGNATURE_TYPE)]);
    const keepKey = vi.fn(async () => true);
    const restorable = vi.fn(async () => ok([key('dkim-1'), key('dkim-2')]));
    const res = await normalizeDomainDkim({ ...base, currentDbSelector: 'dkim-2', keepKey, restorable });

    expect(restorable).toHaveBeenCalledWith(['dkim-1', 'dkim-2']);
    expect(create.mock.calls.map((c) => [c[0].selector, c[0].privateKeyPem])).toEqual([
      ['dkim-1', 'PEM-dkim-1'], ['dkim-2', 'PEM-dkim-2'],
    ]);
    expect(res).toMatchObject({ activeSelector: 'dkim-2', createdPublicKey: null, createdSignatureId: null, keptCopy: null });
    expect(res.restored.map((k) => k.selector)).toEqual(['dkim-1', 'dkim-2']);
    expect(keepKey).not.toHaveBeenCalled();
    // The auto pair still goes, after the restore (create before destroy).
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ destroy: ['auto-rsa', 'auto-ed'] }));
  });

  it('restores only the selector Stalwart lost, next to the one it kept', async () => {
    get.mockResolvedValue([row('s1', 'dkim-1')]);
    const restorable = vi.fn(async () => ok([key('dkim-2')]));
    const res = await normalizeDomainDkim({ ...base, currentDbSelector: 'dkim-2', restorable });
    expect(restorable).toHaveBeenCalledWith(['dkim-2']);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ selector: 'dkim-2', privateKeyPem: 'PEM-dkim-2' });
    expect(res.activeSelector).toBe('dkim-2');
  });

  it('ignores a candidate for a selector it did not ask about', async () => {
    get.mockResolvedValue([row('s1', 'dkim-1')]);
    await normalizeDomainDkim({ ...base, restorable: async () => ok([key('dkim-1')]) });
    expect(create).not.toHaveBeenCalled();
  });

  it('mints as before when nothing is restorable, and keeps exactly the key Stalwart got', async () => {
    get.mockResolvedValue([row('auto-rsa', 'v1-rsa-x')]);
    const keepKey = vi.fn(async () => true);
    const res = await normalizeDomainDkim({ ...base, keepKey, restorable: async () => ok([]) });
    expect(create).toHaveBeenCalledTimes(1);
    const sent = create.mock.calls[0][0] as { selector: string; privateKeyPem: string };
    expect(sent.selector).toBe('dkim-1');
    expect(keepKey).toHaveBeenCalledWith('dkim-1', sent.privateKeyPem);
    expect(sent.privateKeyPem).toMatch(/BEGIN PRIVATE KEY/);
    expect(res).toMatchObject({ activeSelector: 'dkim-1', keptCopy: true, restored: [] });
    expect(res.createdPublicKey).toMatch(/BEGIN PUBLIC KEY/);
  });

  // The refused key is valid and its record still verifies: a new key minted
  // under the selector would replace it. Undecidable, retry instead.
  it('mints NOTHING when Stalwart refuses a restorable key, and keeps the auto pair signing', async () => {
    get.mockResolvedValue([row('auto-rsa', 'v1-rsa-x')]);
    create.mockRejectedValueOnce(new Error('refused -----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----'));
    const keepKey = vi.fn(async () => true);
    const res = await normalizeDomainDkim({ ...base, keepKey, restorable: async () => ok([key('dkim-1')]) });
    expect(create).toHaveBeenCalledTimes(1); // the refused restore only
    expect(res).toMatchObject({ undecidable: true, restored: [], createdPublicKey: null, destroyed: [] });
    expect(set).not.toHaveBeenCalled(); // nothing A/B signs: the auto pair stays
    expect(keepKey).not.toHaveBeenCalled();
  });

  it('keeps what did come back when only one selector is refused, mints nothing, and sweeps the auto pair', async () => {
    get.mockResolvedValue([row('auto-rsa', 'v1-rsa-x'), row('auto-ed', 'v1-ed25519-x', ED25519_SIGNATURE_TYPE)]);
    create.mockImplementation(async (p: { selector: string }) => {
      if (p.selector === 'dkim-2') throw new Error('transient');
      return `new-${p.selector}`;
    });
    const res = await normalizeDomainDkim({ ...base, currentDbSelector: 'dkim-2', restorable: async () => ok([key('dkim-1'), key('dkim-2')]) });
    expect(res.undecidable).toBe(true);
    expect(res.restored.map((k) => k.selector)).toEqual(['dkim-1']);
    expect(res.createdPublicKey).toBeNull();
    expect(res.activeSelector).toBe('dkim-1'); // the persisted dkim-2 did not come back
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ destroy: ['auto-rsa', 'auto-ed'] }));
  });

  // DNS gave no answer: a new key would replace one DNS may well still
  // publish. Nothing is restored, minted or swept — the auto pair keeps signing.
  it('an undecidable check restores nothing, mints nothing and sweeps nothing', async () => {
    get.mockResolvedValue([row('auto-rsa', 'v1-rsa-x')]);
    const keepKey = vi.fn(async () => true);
    const res = await normalizeDomainDkim({
      ...base, keepKey, restorable: async () => ({ restorable: [key('dkim-1')], undecidable: ['dkim-2'] }),
    });
    expect(res).toMatchObject({ undecidable: true, createdPublicKey: null, restored: [], destroyed: [] });
    expect(create).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(keepKey).not.toHaveBeenCalled();
  });

  it('a restore check that throws is undecidable too, never a mint', async () => {
    get.mockResolvedValue([row('auto-rsa', 'v1-rsa-x')]);
    const res = await normalizeDomainDkim({ ...base, restorable: async () => { throw new Error('db down'); } });
    expect(res.undecidable).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('a decided check reports undecidable: false', async () => {
    get.mockResolvedValue([row('auto-rsa', 'v1-rsa-x')]);
    const res = await normalizeDomainDkim({ ...base, restorable: async () => ok([]) });
    expect(res.undecidable).toBe(false);
  });

  // Keeping a copy never fails signing.
  it('a keepKey that throws leaves the new key signing, and says the copy was not kept', async () => {
    get.mockResolvedValue([row('auto-rsa', 'v1-rsa-x')]);
    const res = await normalizeDomainDkim({ ...base, keepKey: async () => { throw new Error('import failed'); } });
    expect(res).toMatchObject({ keptCopy: false, activeSelector: 'dkim-1' });
    expect(set).toHaveBeenCalled(); // the auto pair is still swept
  });
});
