/**
 * Which key "Show private key" hands out, and when it refuses.
 *
 * The key comes from the platform's copy, but Stalwart decides which key is in
 * use and whether the copy is really it: a copy whose public key differs from
 * the one Stalwart reports is never shown.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { pickSigningRow, resolveSigningKey } from './private-key.js';
import { keepDkimPrivateKey, readKeptDkimPrivateKey, spkiOf } from './key-store.js';
import type { StalwartDkimSignatureRow } from '../stalwart-jmap/client.js';

function rsaPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

const A = rsaPair();
const B = rsaPair();

const row = (selector: string, spki: string, over: Partial<StalwartDkimSignatureRow> = {}): StalwartDkimSignatureRow => ({
  id: `id-${selector}`, '@type': 'Dkim1RsaSha256', domainId: 'sd1', selector, stage: 'active', publicKey: spki, ...over,
});

const keptAs = (map: Record<string, string>) => async (selector: string) =>
  (map[selector] ? { ok: true as const, privateKeyPem: map[selector] } : { ok: false as const, reason: 'none' as const });

describe('pickSigningRow', () => {
  it('takes the selector the latest rotation signed with, when both sign', () => {
    const rows = [row('dkim-1', A.spki), row('dkim-2', B.spki)];
    expect(pickSigningRow({ rows, stalwartDomainId: 'sd1', activeSelector: 'dkim-2' })?.selector).toBe('dkim-2');
  });

  it('falls back to the only active key, and never to another domain\'s', () => {
    const rows = [row('v1-rsa-x', A.spki), row('dkim-1', B.spki, { domainId: 'other' })];
    expect(pickSigningRow({ rows, stalwartDomainId: 'sd1', activeSelector: null })?.selector).toBe('v1-rsa-x');
    expect(pickSigningRow({ rows: [row('dkim-1', B.spki, { domainId: 'other' })], stalwartDomainId: 'sd1', activeSelector: 'dkim-1' })).toBeNull();
  });

  it('does not guess between two active keys when the active selector is unknown', () => {
    const rows = [row('dkim-1', A.spki), row('dkim-2', B.spki)];
    expect(pickSigningRow({ rows, stalwartDomainId: 'sd1', activeSelector: null })).toBeNull();
  });
});

describe('resolveSigningKey', () => {
  const base = { stalwartDomainId: 'sd1', activeSelector: 'dkim-1' };

  it('hands out the kept key when it is the one Stalwart signs with', async () => {
    const res = await resolveSigningKey({ ...base, rows: [row('dkim-1', A.spki)], readKept: keptAs({ 'dkim-1': A.pem }) });
    expect(res).toMatchObject({ ok: true, selector: 'dkim-1', algorithm: 'rsa' });
    if (res.ok) expect(spkiOf(res.privateKeyPem)).toBe(A.spki);
  });

  it('refuses a copy that is not the signing key', async () => {
    const res = await resolveSigningKey({ ...base, rows: [row('dkim-1', A.spki)], readKept: keptAs({ 'dkim-1': B.pem }) });
    expect(res).toEqual({ ok: false, reason: 'mismatch', selector: 'dkim-1' });
  });

  it('refuses when Stalwart reports no public key to check against', async () => {
    const res = await resolveSigningKey({ ...base, rows: [row('dkim-1', '')], readKept: keptAs({ 'dkim-1': A.pem }) });
    expect(res).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('says a key created before copies were kept cannot be shown', async () => {
    const res = await resolveSigningKey({ ...base, rows: [row('dkim-1', A.spki)], readKept: keptAs({}) });
    expect(res).toEqual({ ok: false, reason: 'not_kept', selector: 'dkim-1' });
  });

  it('only reads the copy of the signing selector', async () => {
    const readKept = vi.fn(keptAs({ 'dkim-2': B.pem }));
    await resolveSigningKey({ ...base, activeSelector: 'dkim-2', rows: [row('dkim-1', A.spki), row('dkim-2', B.spki)], readKept });
    expect(readKept).toHaveBeenCalledTimes(1);
    expect(readKept).toHaveBeenCalledWith('dkim-2');
  });

  it('reports no signing key when the domain has none active', async () => {
    const res = await resolveSigningKey({ ...base, rows: [row('dkim-1', A.spki, { stage: 'retired' })], readKept: keptAs({ 'dkim-1': A.pem }) });
    expect(res).toEqual({ ok: false, reason: 'no_signing_key' });
  });
});

describe('key store', () => {
  const KEY = 'ab'.repeat(32);

  /** Captures the row an insert would write, and serves it back to a select. */
  function memoryDb() {
    let stored: { privateKeyEncrypted: string } | null = null;
    const db = {
      insert: () => ({
        values: (v: { privateKeyEncrypted: string }) => ({
          onConflictDoUpdate: async () => { stored = { privateKeyEncrypted: v.privateKeyEncrypted }; },
        }),
      }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => (stored ? [stored] : []) }) }) }),
    };
    return { db: db as never, stored: () => stored };
  }

  it('stores the key encrypted, and reads it back', async () => {
    const m = memoryDb();
    expect(await keepDkimPrivateKey(m.db, { emailDomainId: 'e1', selector: 'dkim-1', privateKeyPem: A.pem, encryptionKey: KEY })).toBe(true);
    expect(m.stored()?.privateKeyEncrypted).not.toContain('PRIVATE KEY');
    expect(await readKeptDkimPrivateKey(m.db, 'e1', 'dkim-1', KEY)).toEqual({ ok: true, privateKeyPem: A.pem });
  });

  it('cannot read a copy made under another encryption key, and says so', async () => {
    const m = memoryDb();
    await keepDkimPrivateKey(m.db, { emailDomainId: 'e1', selector: 'dkim-1', privateKeyPem: A.pem, encryptionKey: KEY });
    expect(await readKeptDkimPrivateKey(m.db, 'e1', 'dkim-1', 'cd'.repeat(32))).toEqual({ ok: false, reason: 'undecryptable' });
  });

  it('never fails the caller, and never logs the key, when the write fails', async () => {
    const warn = vi.fn();
    const deleted: unknown[] = [];
    const db = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => { throw new Error(`insert failed: ${A.pem}`); } }) }),
      delete: () => ({ where: async (w: unknown) => { deleted.push(w); } }),
    } as never;
    expect(await keepDkimPrivateKey(db, { emailDomainId: 'e1', selector: 'dkim-1', privateKeyPem: A.pem, encryptionKey: KEY }, { warn })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE KEY');
    // The selector's old copy is dropped, so it cannot outlive its key.
    expect(deleted).toHaveLength(1);
  });

  it('still never throws when dropping the old copy fails too', async () => {
    const warn = vi.fn();
    const db = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => { throw new Error('insert failed'); } }) }),
      delete: () => ({ where: async () => { throw new Error('delete failed'); } }),
    } as never;
    expect(await keepDkimPrivateKey(db, { emailDomainId: 'e1', selector: 'dkim-1', privateKeyPem: A.pem, encryptionKey: KEY }, { warn })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
