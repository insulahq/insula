/**
 * rotateDkimKey and the kept copies, against a stubbed Stalwart: each rotation
 * keeps a copy of exactly the key Stalwart got under the target selector
 * (dkim-1 → dkim-2 → dkim-1, so both selectors hold one), a failed copy never
 * fails the rotation, and a destroyed straggler's copy goes with it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../stalwart-jmap/client.js', () => ({ dkimSignatureGet: vi.fn(), dkimSignatureSet: vi.fn() }));
vi.mock('./signatures.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./signatures.js')>()),
  resolveDkimAccountId: vi.fn(async () => 'acct'),
  createRsaDkimSignature: vi.fn(),
}));
vi.mock('./dns-publish.js', () => ({
  upsertDkimTxtRecord: vi.fn(async (_db: unknown, p: { selector: string; domainName: string }) => ({
    txtRecordName: `${p.selector}._domainkey.${p.domainName}`, txtRecordValue: 'v=DKIM1; k=rsa; p=X',
  })),
}));
vi.mock('./key-store.js', () => ({ keepDkimPrivateKey: vi.fn(), forgetDkimPrivateKeysFor: vi.fn() }));

import { dkimSignatureGet, dkimSignatureSet, type StalwartDkimSignatureRow } from '../stalwart-jmap/client.js';
import { createRsaDkimSignature, RSA_SIGNATURE_TYPE } from './signatures.js';
import { keepDkimPrivateKey, forgetDkimPrivateKeysFor } from './key-store.js';
import { rotateDkimKey } from './rotate.js';

const get = dkimSignatureGet as unknown as ReturnType<typeof vi.fn>;
const set = dkimSignatureSet as unknown as ReturnType<typeof vi.fn>;
const create = createRsaDkimSignature as unknown as ReturnType<typeof vi.fn>;
const keep = keepDkimPrivateKey as unknown as ReturnType<typeof vi.fn>;
const forget = forgetDkimPrivateKeysFor as unknown as ReturnType<typeof vi.fn>;

const row = (id: string, selector: string): StalwartDkimSignatureRow =>
  ({ id, selector, domainId: 'sw-1', '@type': RSA_SIGNATURE_TYPE, stage: 'active' }) as unknown as StalwartDkimSignatureRow;

/** One email domain whose active selector is `state.active`; update() records the flip. */
function stubDb(state: { active: string | null }) {
  return {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: () => Promise.resolve([{
      id: 'ed-1', domainId: 'd-1', domainName: 'shop.example.test', stalwartDomainId: 'sw-1', dkimActiveSelector: state.active,
    }]) }) }) }),
    update: () => ({ set: (p: { dkimActiveSelector: string }) => ({ where: () => { state.active = p.dkimActiveSelector; return Promise.resolve(); } }) }),
  } as never;
}

describe('rotateDkimKey — kept copies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    create.mockImplementation(async (p: { selector: string }) => `sig-${p.selector}`);
    keep.mockResolvedValue(true);
    set.mockImplementation(async (p: { destroy: string[] }) => ({ destroyed: p.destroy }));
  });

  it('dkim-1 → dkim-2 → dkim-1: each copy is the key Stalwart got, under its selector', async () => {
    const state = { active: 'dkim-1' as string | null };
    const db = stubDb(state);
    const signatures: StalwartDkimSignatureRow[] = [row('s1', 'dkim-1')];
    get.mockImplementation(async () => [...signatures]);

    const first = await rotateDkimKey(db, 'ed-1', 'k'.repeat(64));
    signatures.push(row('s2', 'dkim-2'));
    const second = await rotateDkimKey(db, 'ed-1', 'k'.repeat(64));

    expect([first.newSelector, second.newSelector]).toEqual(['dkim-2', 'dkim-1']);
    expect(state.active).toBe('dkim-1');
    expect(create.mock.calls.map((c) => c[0].selector)).toEqual(['dkim-2', 'dkim-1']);
    // The copy kept is exactly the PEM handed to Stalwart, for the same selector.
    for (const [i, c] of create.mock.calls.entries()) {
      expect(keep.mock.calls[i][1]).toMatchObject({ emailDomainId: 'ed-1', selector: c[0].selector, privateKeyPem: c[0].privateKeyPem });
    }
    expect(first.keptCopy).toBe(true);
    // The second rotation replaced dkim-1's key: its old signature was destroyed
    // first, and its copy is replaced by the keep above (no separate forget).
    expect(set.mock.calls[0][0]).toMatchObject({ destroy: ['s1'] });
    expect(forget.mock.calls.flatMap((c) => c[2] as string[])).toEqual([]);
  });

  it('a copy that could not be kept never fails the rotation, and the result says so', async () => {
    get.mockResolvedValue([row('s1', 'dkim-1')]);
    keep.mockResolvedValue(false);
    const res = await rotateDkimKey(stubDb({ active: 'dkim-1' }), 'ed-1', 'k'.repeat(64));
    expect(res).toMatchObject({ newSelector: 'dkim-2', keptCopy: false });
  });

  it('drops the copy of a destroyed straggler selector', async () => {
    get.mockResolvedValue([row('s1', 'dkim-1'), row('old', 'v1-rsa-legacy')]);
    await rotateDkimKey(stubDb({ active: 'dkim-1' }), 'ed-1', 'k'.repeat(64));
    expect(forget).toHaveBeenCalledWith(expect.anything(), 'ed-1', ['v1-rsa-legacy']);
  });

  it('keeps the copy of a straggler Stalwart refused to destroy', async () => {
    get.mockResolvedValue([row('s1', 'dkim-1'), row('old', 'v1-rsa-legacy')]);
    set.mockResolvedValue({ destroyed: [] });
    await rotateDkimKey(stubDb({ active: 'dkim-1' }), 'ed-1', 'k'.repeat(64));
    expect(forget).toHaveBeenCalledWith(expect.anything(), 'ed-1', []);
  });
});
