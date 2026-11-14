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
import { dkimKeyRowRestorable } from '../backup-restore/executors/config-tables.js';
import {
  dkimKeyRowId, forgetDkimPrivateKeysFor, keepDkimPrivateKey, readKeptDkimPrivateKey, readKeptDkimPrivateKeys,
} from './key-store.js';

const dbAvailable = await isDbAvailable();
const KEY = 'c'.repeat(64);

describe.skipIf(!dbAvailable)('kept DKIM keys (integration)', () => {
  const db = () => getTestDb();
  let emailDomainId = '';
  let tenantId = '';

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    tenantId = (await seedTenant(db(), regionId, planId)).id;
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

  // A copy that could not be replaced must not outlive its key.
  it('a failed keep drops the selector\'s old copy', async () => {
    await keepDkimPrivateKey(db(), { emailDomainId, selector: 'dkim-1', privateKeyPem: 'PEM-OLD', encryptionKey: KEY });
    expect(await keepDkimPrivateKey(db(), { emailDomainId, selector: 'dkim-1', privateKeyPem: 'PEM-NEW', encryptionKey: 'zz' })).toBe(false);
    expect(await readKeptDkimPrivateKey(db(), emailDomainId, 'dkim-1', KEY)).toEqual({ ok: false, reason: 'none' });
  });

  // A pod of the previous release inserts without an id during a rolling deploy.
  it('0182 fills a missing id with the derived one', async () => {
    await db().execute(sql`
      INSERT INTO email_dkim_private_keys (email_domain_id, selector, private_key_encrypted) VALUES (${emailDomainId}, 'dkim-2', 'x')
    `);
    const [r] = await db().select().from(emailDkimPrivateKeys).where(eq(emailDkimPrivateKeys.selector, 'dkim-2'));
    expect(r.id).toBe(dkimKeyRowId(emailDomainId, 'dkim-2'));
  });

  describe('a bundle row (dkimKeyRowRestorable)', () => {
    const bundleRow = (over: Record<string, unknown> = {}) => ({
      id: dkimKeyRowId(emailDomainId, 'dkim-1'), email_domain_id: emailDomainId, selector: 'dkim-1',
      private_key_encrypted: 'cipher', created_at: new Date().toISOString(), ...over,
    });
    const restorable = (row: Record<string, unknown>, tenant: string | null) =>
      db().transaction(async (tx) => dkimKeyRowRestorable(tx as never, row, tenant));

    it('is restored into its own tenant, with its derived id', async () => {
      expect(await restorable(bundleRow(), tenantId)).toBe(true);
    });

    it('is refused for another tenant\'s email domain', async () => {
      const regionId = (await seedRegion(db())).id;
      const planId = (await seedPlan(db())).id;
      const other = (await seedTenant(db(), regionId, planId)).id;
      expect(await restorable(bundleRow(), other)).toBe(false);
      expect(await restorable(bundleRow(), null)).toBe(false);
    });

    it('is refused under any id but the derived one', async () => {
      expect(await restorable(bundleRow({ id: crypto.randomUUID() }), tenantId)).toBe(false);
      expect(await restorable(bundleRow({ selector: 'dkim-2' }), tenantId)).toBe(false); // id of dkim-1, says dkim-2
    });

    it('never replaces a live copy that is newer than the bundle\'s', async () => {
      await keepDkimPrivateKey(db(), { emailDomainId, selector: 'dkim-1', privateKeyPem: 'PEM-NOW', encryptionKey: KEY });
      expect(await restorable(bundleRow({ created_at: new Date(Date.now() - 86_400_000).toISOString() }), tenantId)).toBe(false);
      expect(await restorable(bundleRow({ created_at: 'not a date' }), tenantId)).toBe(false);
      expect(await restorable(bundleRow({ created_at: new Date(Date.now() + 60_000).toISOString() }), tenantId)).toBe(true);
    });
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
