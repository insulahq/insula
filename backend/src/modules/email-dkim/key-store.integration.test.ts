/**
 * The kept DKIM key copies against a real Postgres: migration 0180's id, the
 * per-selector upsert, dropping selectors, and a tenant-bundle restore that
 * replaces the live row of the same selector instead of aborting on the
 * (email domain, selector) unique index.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sql, eq } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant, seedDomain } from '../../test-helpers/fixtures.js';
import { emailDkimPrivateKeys, emailDomains } from '../../db/schema.js';
import { upsertRow } from '../backup-restore/executors/_shared.js';
import {
  dkimKeyRowId, forgetDkimPrivateKeysFor, keepDkimPrivateKey, readKeptDkimPrivateKey, readKeptDkimPrivateKeys,
} from './key-store.js';

const dbAvailable = await isDbAvailable();
const KEY = 'c'.repeat(64);

describe.skipIf(!dbAvailable)('kept DKIM keys (integration)', () => {
  const db = () => getTestDb();
  let emailDomainId = '';

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    const tenantId = (await seedTenant(db(), regionId, planId)).id;
    const domain = await seedDomain(db(), tenantId, { domainName: 'shop.example.com' });
    emailDomainId = crypto.randomUUID();
    await db().insert(emailDomains).values({ id: emailDomainId, domainId: domain.id, tenantId, enabled: 1 } as typeof emailDomains.$inferInsert);
  });

  it('keeps one row per selector, replacing it on reuse', async () => {
    expect(await keepDkimPrivateKey(db(), { emailDomainId, selector: 'dkim-1', privateKeyPem: 'PEM-A', encryptionKey: KEY })).toBe(true);
    expect(await keepDkimPrivateKey(db(), { emailDomainId, selector: 'dkim-2', privateKeyPem: 'PEM-B', encryptionKey: KEY })).toBe(true);
    // Two rotations later dkim-1 is reused with a new key.
    expect(await keepDkimPrivateKey(db(), { emailDomainId, selector: 'dkim-1', privateKeyPem: 'PEM-C', encryptionKey: KEY })).toBe(true);

    const all = await readKeptDkimPrivateKeys(db(), emailDomainId, KEY);
    expect([...all].map(([s, k]) => [s, k.ok ? k.privateKeyPem : k.reason]).sort()).toEqual([['dkim-1', 'PEM-C'], ['dkim-2', 'PEM-B']]);
    const rows = await db().select().from(emailDkimPrivateKeys).where(eq(emailDkimPrivateKeys.emailDomainId, emailDomainId));
    expect(rows.map((r) => r.id).sort()).toEqual([dkimKeyRowId(emailDomainId, 'dkim-1'), dkimKeyRowId(emailDomainId, 'dkim-2')].sort());
    // Stored encrypted, never as the PEM.
    expect(rows.every((r) => !r.privateKeyEncrypted.includes('PEM'))).toBe(true);
  });

  it('drops only the selectors named', async () => {
    await keepDkimPrivateKey(db(), { emailDomainId, selector: 'dkim-1', privateKeyPem: 'PEM-A', encryptionKey: KEY });
    await keepDkimPrivateKey(db(), { emailDomainId, selector: 'v1-rsa-legacy', privateKeyPem: 'PEM-L', encryptionKey: KEY });
    await forgetDkimPrivateKeysFor(db(), emailDomainId, ['v1-rsa-legacy']);
    expect((await readKeptDkimPrivateKey(db(), emailDomainId, 'v1-rsa-legacy', KEY))).toEqual({ ok: false, reason: 'none' });
    expect((await readKeptDkimPrivateKey(db(), emailDomainId, 'dkim-1', KEY)).ok).toBe(true);
  });

  // The bundle restore upserts on id; a random id would collide with the live
  // row of the same selector on the unique index and abort the whole restore.
  it('a bundle row replaces the live row of its selector', async () => {
    await keepDkimPrivateKey(db(), { emailDomainId, selector: 'dkim-1', privateKeyPem: 'PEM-NOW', encryptionKey: KEY });
    const [live] = await db().select().from(emailDkimPrivateKeys).where(eq(emailDkimPrivateKeys.emailDomainId, emailDomainId));
    // A bundle taken earlier: same derived id, an older key.
    const row = {
      id: live.id, email_domain_id: emailDomainId, selector: 'dkim-1',
      private_key_encrypted: (await import('../oidc/crypto.js')).encrypt('PEM-BACKUP', KEY), created_at: new Date().toISOString(),
    };
    await db().transaction(async (tx) => { expect(await upsertRow(tx as never, 'email_dkim_private_keys', row)).toBe(true); });
    const kept = await readKeptDkimPrivateKey(db(), emailDomainId, 'dkim-1', KEY);
    expect(kept).toEqual({ ok: true, privateKeyPem: 'PEM-BACKUP' });
    // And a bundle row whose email domain is not there is skipped, not an error.
    const orphan = { ...row, id: dkimKeyRowId('gone', 'dkim-1'), email_domain_id: crypto.randomUUID() };
    await db().transaction(async (tx) => { expect(await upsertRow(tx as never, 'email_dkim_private_keys', orphan)).toBe(false); });
  });

  it('the migration\'s SQL id formula is dkimKeyRowId, and 0180 replays cleanly', async () => {
    const res = await db().execute(sql`
      SELECT substr(encode(sha256(convert_to('dkim-key:' || ${'ed-x'} || ':' || ${'dkim-2'}, 'UTF8')), 'hex'), 1, 32)::uuid::text AS id
    `) as { rows: Array<{ id: string }> };
    expect(res.rows[0].id).toBe(dkimKeyRowId('ed-x', 'dkim-2'));

    await keepDkimPrivateKey(db(), { emailDomainId, selector: 'dkim-1', privateKeyPem: 'PEM-A', encryptionKey: KEY });
    const file = path.resolve(import.meta.dirname, '../../db/migrations/0180_email_dkim_private_keys_id.sql');
    await db().execute(sql.raw(fs.readFileSync(file, 'utf8')));
    const pk = await db().execute(sql`
      SELECT a.attname FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = 'email_dkim_private_keys'::regclass AND c.contype = 'p'
    `) as { rows: Array<{ attname: string }> };
    expect(pk.rows.map((r) => r.attname)).toEqual(['id']);
    expect((await readKeptDkimPrivateKey(db(), emailDomainId, 'dkim-1', KEY)).ok).toBe(true);
  });
});
