/**
 * Which kept keys may go back into the mail server: only a copy whose public
 * half the selector's published TXT record carries. Public DNS decides when it
 * answers; the platform's own record only when it does not.
 */
import { describe, it, expect } from 'vitest';
import { dkimKeyRowId } from './key-store.js';
import { dkimPublicKeyOf, restorableDkimKeys } from './restore.js';
import { encrypt } from '../oidc/crypto.js';
import { generateDkimKeyPair, formatDkimDnsValue } from '../email-domains/dkim.js';
import { emailDkimPrivateKeys, dnsRecords } from '../../db/schema.js';

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
const nx = () => Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
const params = (selectors: string[]) => ({ emailDomainId: 'ed-1', domainId: 'd-1', domainName: DOMAIN, selectors, encryptionKey: KEY });

describe('restorableDkimKeys', () => {
  it('restores a copy public DNS publishes, and only for the selectors asked', async () => {
    const db = stubDb({ keys: [
      { selector: 'dkim-1', privateKeyEncrypted: encrypt(k1.privateKey, KEY) },
      { selector: 'dkim-2', privateKeyEncrypted: encrypt(k2.privateKey, KEY) },
    ] });
    const asked: string[] = [];
    const out = await restorableDkimKeys(db, params(['dkim-2']), {
      resolveTxt: async (name) => { asked.push(name); return [[formatDkimDnsValue(k2.publicKey)]]; },
    });
    expect(asked).toEqual([`dkim-2._domainkey.${DOMAIN}`]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ selector: 'dkim-2', privateKeyPem: k2.privateKey, matchedBy: 'dns' });
  });

  // What receivers see wins: a stale platform row must not vouch for a key DNS replaced.
  it('refuses a copy when public DNS publishes another key, whatever the platform holds', async () => {
    const db = stubDb({
      keys: [{ selector: 'dkim-1', privateKeyEncrypted: encrypt(kOld.privateKey, KEY) }],
      records: [{ recordValue: formatDkimDnsValue(kOld.publicKey) }],
    });
    const out = await restorableDkimKeys(db, params(['dkim-1']), { resolveTxt: async () => [[formatDkimDnsValue(k1.publicKey)]] });
    expect(out).toEqual([]);
  });

  it('falls back to the platform\'s record when public DNS has none, and says so', async () => {
    const db = stubDb({
      keys: [{ selector: 'dkim-1', privateKeyEncrypted: encrypt(k1.privateKey, KEY) }],
      records: [{ recordValue: `"${formatDkimDnsValue(k1.publicKey).slice(0, 100)}" "${formatDkimDnsValue(k1.publicKey).slice(100)}"` }],
    });
    const out = await restorableDkimKeys(db, params(['dkim-1']), { resolveTxt: nx });
    expect(out.map((k) => [k.selector, k.matchedBy])).toEqual([['dkim-1', 'platform']]);
  });

  it('restores nothing when no published record carries the copy', async () => {
    const db = stubDb({ keys: [{ selector: 'dkim-1', privateKeyEncrypted: encrypt(k1.privateKey, KEY) }] });
    expect(await restorableDkimKeys(db, params(['dkim-1']), { resolveTxt: nx })).toEqual([]);
  });

  // A bundle restored onto a cluster with another PLATFORM_ENCRYPTION_KEY.
  it('skips a copy encrypted under another cluster\'s key', async () => {
    const db = stubDb({ keys: [{ selector: 'dkim-1', privateKeyEncrypted: encrypt(k1.privateKey, OTHER_KEY) }] });
    const out = await restorableDkimKeys(db, params(['dkim-1']), { resolveTxt: async () => [[formatDkimDnsValue(k1.publicKey)]] });
    expect(out).toEqual([]);
  });

  it('restores nothing for a selector it never kept, and never throws', async () => {
    const db = stubDb({});
    expect(await restorableDkimKeys(db, params(['dkim-1', 'dkim-2']), { resolveTxt: async () => { throw new Error('boom'); } })).toEqual([]);
    const broken = { select: () => { throw new Error('db down'); } } as never;
    expect(await restorableDkimKeys(broken, params(['dkim-1']))).toEqual([]);
  });
});

describe('dkimPublicKeyOf', () => {
  it('reads p= from the platform\'s spelling, a quoted and split one, and loose spacing', () => {
    expect(dkimPublicKeyOf('v=DKIM1; k=rsa; p=ABC+/=')).toBe('ABC+/=');
    expect(dkimPublicKeyOf('"v=DKIM1; k=rsa; p=AB" "C+/="')).toBe('ABC+/=');
    expect(dkimPublicKeyOf('v=DKIM1;k=rsa;p = AB C')).toBe('ABC');
    expect(dkimPublicKeyOf('v=DKIM1; k=rsa; p=')).toBeNull();
    expect(dkimPublicKeyOf('v=spf1 -all')).toBeNull();
  });
});

describe('dkimKeyRowId', () => {
  // Migration 0180 backfills with the same formula in SQL.
  it('is stable per (email domain, selector) and UUID-shaped', () => {
    expect(dkimKeyRowId('ed-1', 'dkim-1')).toBe(dkimKeyRowId('ed-1', 'dkim-1'));
    expect(dkimKeyRowId('ed-1', 'dkim-1')).not.toBe(dkimKeyRowId('ed-1', 'dkim-2'));
    expect(dkimKeyRowId('ed-1', 'dkim-1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
