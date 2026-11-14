/**
 * Which kept keys may go back into the mail server: only a copy whose public
 * half the selector's published TXT record carries. Public DNS decides when it
 * answers; the platform's own record only when public DNS says there is none
 * AND the platform hosts the zone. No answer at all is undecidable: nothing
 * is restored, so nothing is minted over a key DNS may still publish.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../email-domains/dns-provisioning.js', () => ({ isZoneWritable: vi.fn(), syncRecordToProviders: vi.fn() }));

import { syncRecordToProviders } from '../email-domains/dns-provisioning.js';
import { dkimKeyRowId } from './key-store.js';
import { dkimPublicKeyOf, republishRestoredDkim, restorableDkimKeys } from './restore.js';
import { encrypt } from '../oidc/crypto.js';
import { generateDkimKeyPair, formatDkimDnsValue } from '../email-domains/dkim.js';
import { emailDkimPrivateKeys, dnsRecords } from '../../db/schema.js';

const sync = syncRecordToProviders as unknown as ReturnType<typeof vi.fn>;
const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const DOMAIN = 'shop.example.test';

const k1 = generateDkimKeyPair();
const k2 = generateDkimKeyPair();
const kOld = generateDkimKeyPair();

/** select().from(table).where() → the rows given for that table. */
function stubDb(tables: { keys?: Array<{ selector: string; privateKeyEncrypted: string }>; records?: Array<{ recordValue: string }> }) {
  return {
    select: () => ({
      from: (t: unknown) => ({
        where: () => Promise.resolve(t === emailDkimPrivateKeys ? tables.keys ?? [] : t === dnsRecords ? tables.records ?? [] : []),
      }),
    }),
  } as never;
}
const err = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
const params = (selectors: string[]) => ({ emailDomainId: 'ed-1', domainId: 'd-1', domainName: DOMAIN, selectors, encryptionKey: KEY });
const hosted = { zoneHostedHere: async () => true };
const external = { zoneHostedHere: async () => false };
const keptK1 = { keys: [{ selector: 'dkim-1', privateKeyEncrypted: encrypt(k1.privateKey, KEY) }] };

describe('restorableDkimKeys', () => {
  it('restores a copy public DNS publishes, and only for the selectors asked', async () => {
    const db = stubDb({ keys: [
      { selector: 'dkim-1', privateKeyEncrypted: encrypt(k1.privateKey, KEY) },
      { selector: 'dkim-2', privateKeyEncrypted: encrypt(k2.privateKey, KEY) },
    ] });
    const asked: string[] = [];
    const out = await restorableDkimKeys(db, params(['dkim-2']), {
      ...external, resolveTxt: async (name) => { asked.push(name); return [[formatDkimDnsValue(k2.publicKey)]]; },
    });
    expect(asked).toEqual([`dkim-2._domainkey.${DOMAIN}`]);
    expect(out.undecidable).toEqual([]);
    expect(out.restorable).toHaveLength(1);
    expect(out.restorable[0]).toMatchObject({ selector: 'dkim-2', privateKeyPem: k2.privateKey, matchedBy: 'dns' });
  });

  // What receivers see wins: a stale platform row must not vouch for a key DNS replaced.
  it('refuses a copy when public DNS publishes another key, whatever the platform holds', async () => {
    const db = stubDb({
      keys: [{ selector: 'dkim-1', privateKeyEncrypted: encrypt(kOld.privateKey, KEY) }],
      records: [{ recordValue: formatDkimDnsValue(kOld.publicKey) }],
    });
    const out = await restorableDkimKeys(db, params(['dkim-1']), { ...hosted, resolveTxt: async () => [[formatDkimDnsValue(k1.publicKey)]] });
    expect(out).toEqual({ restorable: [], undecidable: [] });
  });

  it('never restores a revoked key (empty p=), in public DNS or in the platform\'s record', async () => {
    const out = await restorableDkimKeys(stubDb(keptK1), params(['dkim-1']), { ...hosted, resolveTxt: async () => [['v=DKIM1; k=rsa; p=']] });
    expect(out).toEqual({ restorable: [], undecidable: [] });
    const viaPlatform = await restorableDkimKeys(stubDb({ ...keptK1, records: [{ recordValue: 'v=DKIM1; k=rsa; p=' }] }),
      params(['dkim-1']), { ...hosted, resolveTxt: () => err('ENOTFOUND') });
    expect(viaPlatform).toEqual({ restorable: [], undecidable: [] });
  });

  it('falls back to the platform\'s record on NXDOMAIN/NODATA when the platform hosts the zone', async () => {
    for (const code of ['ENOTFOUND', 'ENODATA']) {
      const db = stubDb({
        ...keptK1,
        records: [{ recordValue: `"${formatDkimDnsValue(k1.publicKey).slice(0, 100)}" "${formatDkimDnsValue(k1.publicKey).slice(100)}"` }],
      });
      const out = await restorableDkimKeys(db, params(['dkim-1']), { ...hosted, resolveTxt: () => err(code) });
      expect(out.restorable.map((k) => [k.selector, k.matchedBy])).toEqual([['dkim-1', 'platform']]);
    }
  });

  it('does not fall back for a zone hosted elsewhere: nothing vouches for the copy', async () => {
    const db = stubDb({ ...keptK1, records: [{ recordValue: formatDkimDnsValue(k1.publicKey) }] });
    const out = await restorableDkimKeys(db, params(['dkim-1']), { ...external, resolveTxt: () => err('ENOTFOUND') });
    expect(out).toEqual({ restorable: [], undecidable: [] });
  });

  // A SERVFAIL or a timeout is no answer, not "no record": the platform's
  // record must not stand in for it, and the caller must not mint.
  it('reports SERVFAIL and timeouts as undecidable, without consulting the platform\'s record', async () => {
    for (const code of ['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED']) {
      const db = stubDb({ ...keptK1, records: [{ recordValue: formatDkimDnsValue(k1.publicKey) }] });
      const out = await restorableDkimKeys(db, params(['dkim-1']), { ...hosted, resolveTxt: () => err(code) });
      expect(out).toEqual({ restorable: [], undecidable: ['dkim-1'] });
    }
  });

  // A bundle restored onto a cluster with another PLATFORM_ENCRYPTION_KEY.
  it('skips a copy encrypted under another cluster\'s key', async () => {
    const db = stubDb({ keys: [{ selector: 'dkim-1', privateKeyEncrypted: encrypt(k1.privateKey, OTHER_KEY) }] });
    const out = await restorableDkimKeys(db, params(['dkim-1']), { ...hosted, resolveTxt: async () => [[formatDkimDnsValue(k1.publicKey)]] });
    expect(out).toEqual({ restorable: [], undecidable: [] });
  });

  it('a selector never kept is no candidate; unreadable copies are an undecidable check', async () => {
    expect(await restorableDkimKeys(stubDb({}), params(['dkim-1', 'dkim-2']), { ...hosted, resolveTxt: () => err('ESERVFAIL') }))
      .toEqual({ restorable: [], undecidable: [] });
    const broken = { select: () => { throw new Error('db down'); } } as never;
    expect(await restorableDkimKeys(broken, params(['dkim-1']))).toEqual({ restorable: [], undecidable: ['dkim-1'] });
  });
});

describe('republishRestoredDkim', () => {
  beforeEach(() => { sync.mockReset(); sync.mockResolvedValue({ status: 'published' }); });

  // Create only: a failed create leaves the zone as it was, and the platform's
  // row already holds the value.
  it('puts a platform-matched record back with a create, never a delete, and leaves DNS-matched ones alone', async () => {
    const db = {} as never;
    await republishRestoredDkim(db, {
      domainId: 'd-1', domainName: DOMAIN, encryptionKey: KEY,
      restored: [
        { selector: 'dkim-1', privateKeyPem: 'x', publicKeySpki: 'SPKI1', matchedBy: 'platform' },
        { selector: 'dkim-2', privateKeyPem: 'y', publicKeySpki: 'SPKI2', matchedBy: 'dns' },
      ],
    });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][3]).toBe('create');
    expect(sync.mock.calls[0][4]).toMatchObject({ type: 'TXT', name: `dkim-1._domainkey.${DOMAIN}`, content: 'v=DKIM1; k=rsa; p=SPKI1' });
  });

  it('never throws when the provider refuses', async () => {
    sync.mockRejectedValue(new Error('provider down'));
    await expect(republishRestoredDkim({} as never, {
      domainId: 'd-1', domainName: DOMAIN, encryptionKey: KEY,
      restored: [{ selector: 'dkim-1', privateKeyPem: 'x', publicKeySpki: 'S', matchedBy: 'platform' }],
    })).resolves.toBeUndefined();
  });
});

describe('dkimPublicKeyOf', () => {
  it('reads p= from the platform\'s spelling, a quoted and split one, and loose spacing; empty p= is revocation', () => {
    expect(dkimPublicKeyOf('v=DKIM1; k=rsa; p=ABC+/=')).toBe('ABC+/=');
    expect(dkimPublicKeyOf('"v=DKIM1; k=rsa; p=AB" "C+/="')).toBe('ABC+/=');
    expect(dkimPublicKeyOf('v=DKIM1;k=rsa;p = AB C')).toBe('ABC');
    expect(dkimPublicKeyOf('v=DKIM1; k=rsa; p=')).toBe('');
    expect(dkimPublicKeyOf('v=spf1 -all')).toBeNull();
  });
});

describe('dkimKeyRowId', () => {
  // Migration 0180 backfills with the same formula in SQL, 0182's trigger fills it on insert.
  it('is stable per (email domain, selector) and UUID-shaped', () => {
    expect(dkimKeyRowId('ed-1', 'dkim-1')).toBe(dkimKeyRowId('ed-1', 'dkim-1'));
    expect(dkimKeyRowId('ed-1', 'dkim-1')).not.toBe(dkimKeyRowId('ed-1', 'dkim-2'));
    expect(dkimKeyRowId('ed-1', 'dkim-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
