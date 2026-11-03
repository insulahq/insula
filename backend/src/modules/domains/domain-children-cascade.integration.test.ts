/**
 * A domain's certificate rows go with the domain (migration 0174), against a
 * real Postgres.
 *
 * Deleting a domain removed its cert-manager Certificate and Secret but never
 * its ssl_certificates row, which had no foreign key. On production six rows
 * outlived their six domains, and the dashboard counted two of them as
 * "Certificates expiring" for a wildcard whose live certificate was healthy.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { domains, sslCertificates } from '../../db/schema.js';
import { splitSqlStatements } from '../../db/sql-splitter.js';
import { upsertRow } from '../backup-restore/executors/_shared.js';
import { deleteDomain } from './service.js';

const dbAvailable = await isDbAvailable();
const MIGRATION = new URL('../../db/migrations/0174_domain_children_cascade.sql', import.meta.url);

describe.skipIf(!dbAvailable)('domain child rows cascade (integration)', () => {
  let tenantId: string;
  let regionId: string;
  let planId: string;

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });

  beforeEach(async () => {
    await cleanTables();
    const db = getTestDb();
    const region = await seedRegion(db);
    const plan = await seedPlan(db);
    tenantId = (await seedTenant(db, region.id, plan.id)).id;
    regionId = region.id; planId = plan.id;
  });

  const addDomain = async (name: string): Promise<string> => {
    const id = crypto.randomUUID();
    await getTestDb().insert(domains).values({ id, tenantId, domainName: name, status: 'verified', dnsMode: 'cname' });
    return id;
  };
  const certRow = (domainId: string) => ({
    id: crypto.randomUUID(), domainId, tenantId, certificate: 'PEM', privateKeyEncrypted: '# Managed by cert-manager',
    subject: '*.example.test', status: 'issued', expiresAt: new Date(Date.now() + 14 * 86_400_000),
  });
  const certCount = async (): Promise<number> =>
    Number(((await getTestDb().execute(sql`SELECT count(*)::int AS n FROM ssl_certificates`)).rows[0] as { n: number }).n);

  it('deleting a domain deletes its certificate rows', async () => {
    const db = getTestDb();
    const domainId = await addDomain('cascade.example.test');
    await db.insert(sslCertificates).values(certRow(domainId));
    expect(await certCount()).toBe(1);

    await db.delete(domains).where(eq(domains.id, domainId));
    expect(await certCount()).toBe(0);
  });

  it('refuses a certificate row for a domain that does not exist', async () => {
    const err = await getTestDb().insert(sslCertificates).values(certRow(crypto.randomUUID()))
      .then(() => null, (e: unknown) => e as { cause?: { code?: string; constraint?: string } });
    // drizzle wraps the driver error; the Postgres one is its cause.
    expect(err?.cause).toMatchObject({ code: '23503', constraint: 'ssl_certificates_domain_id_domains_id_fk' });
  });

  it('the migration reaps a row whose domain is already gone, and replays cleanly', async () => {
    const db = getTestDb();
    const liveId = await addDomain('live.example.test');
    await db.insert(sslCertificates).values(certRow(liveId));
    // An orphan as the platform left them before 0174: bypass the new key the
    // way a pre-0174 database simply never had it.
    await db.execute(sql`SET session_replication_role = replica`);
    await db.insert(sslCertificates).values(certRow(crypto.randomUUID()));
    await db.execute(sql`SET session_replication_role = DEFAULT`);
    expect(await certCount()).toBe(2);

    for (let pass = 0; pass < 2; pass++) {
      for (const stmt of splitSqlStatements(readFileSync(MIGRATION, 'utf8'))) await db.execute(sql.raw(stmt));
    }
    expect(await certCount()).toBe(1);
    const fk = await db.execute(sql`
      SELECT confdeltype FROM pg_constraint WHERE conname = 'ssl_certificates_domain_id_domains_id_fk'
    `);
    expect((fk.rows[0] as { confdeltype: string }).confdeltype).toBe('c');
  });

  it('a restore skips a bundled certificate row whose domain is gone, and writes the rest', async () => {
    const db = getTestDb();
    const liveId = await addDomain('restore.example.test');
    const snake = (r: ReturnType<typeof certRow>) => ({
      id: r.id, domain_id: r.domainId, tenant_id: r.tenantId, certificate: r.certificate,
      private_key_encrypted: r.privateKeyEncrypted, subject: r.subject, status: r.status, expires_at: r.expiresAt,
    });
    const written = await db.transaction(async (tx) => [
      await upsertRow(tx, 'ssl_certificates', snake(certRow(crypto.randomUUID()))),
      await upsertRow(tx, 'ssl_certificates', snake(certRow(liveId))),
    ]);
    expect(written).toEqual([false, true]);
    expect(await certCount()).toBe(1);
  });

  it('refuses to delete a domain of the SYSTEM tenant — the platform\'s own apex and its DNS zone', async () => {
    const db = getTestDb();
    const system = await seedTenant(db, regionId, planId, { isSystem: true });
    const id = crypto.randomUUID();
    await db.insert(domains).values({ id, tenantId: system.id, domainName: 'platform.example.test', status: 'verified', dnsMode: 'cname' });
    await expect(deleteDomain(db, system.id, id)).rejects.toMatchObject({ code: 'SYSTEM_DOMAIN_PROTECTED', status: 409 });
    expect((await db.select().from(domains).where(eq(domains.id, id))).length).toBe(1);
  });
});
