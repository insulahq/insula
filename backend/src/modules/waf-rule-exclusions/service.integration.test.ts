/**
 * Path-scoped exclusions against real Postgres: migration 0168 (and its
 * replay), the partial unique index that now includes the path, the service's
 * duplicate checks, and the DB CHECKs that are the last line behind the API
 * for a value interpolated into a SecRule string.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { closeTestDb, cleanTables, getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { seedDomain, seedPlan, seedRegion, seedTenant } from '../../test-helpers/fixtures.js';
import { ingressRoutes } from '../../db/schema.js';
import {
  WafRuleExclusionError,
  createExclusion,
  createExclusionForTenantRoute,
  listExclusionsForReconciler,
  updateExclusion,
} from './service.js';

const dbAvailable = await isDbAvailable();
const MIGRATION = readFileSync(
  fileURLToPath(new URL('../../db/migrations/0168_waf_exclusion_path_regex.sql', import.meta.url)),
  'utf8',
);
const HOST = '^moodle\\.example\\.test$';
const AJAX = '^/lib/ajax/service\\.php$';

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof WafRuleExclusionError ? err.code : `other: ${(err as Error).message}`;
  }
};

/** The constraint Postgres named when it refused a write (Drizzle wraps the pg error in `cause`). */
const refusedBy = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'accepted';
  } catch (err) {
    const cause = (err as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? `other: ${(err as Error).message}`;
  }
};

/** A direct INSERT, past the API and the service — what only the DB CHECKs stand in front of. */
const rawInsert = (ruleId: string, scope: string, pathRegex: string | null) =>
  getTestDb().execute(sql`
    INSERT INTO waf_rule_exclusions (id, rule_id, hostname_regex, path_regex, scope, reason, created_by)
    VALUES (${randomUUID()}, ${ruleId}, ${HOST}, ${pathRegex}, ${scope}, 'raw', 'test')`);

describe.skipIf(!dbAvailable)('WAF rule exclusions — path scope (integration)', () => {
  const db = () => getTestDb();
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    // Admin-scoped rows have no tenant, so the tenants TRUNCATE CASCADE leaves them.
    await db().execute(sql.raw('DELETE FROM waf_rule_exclusions'));
  });

  it('the migration replays cleanly over rows it already migrated', async () => {
    await createExclusion(db(), { ruleId: '941100', hostnameRegex: HOST, scope: 'args', reason: 'host-wide' }, 'u');
    await createExclusion(db(), { ruleId: '941100', hostnameRegex: HOST, pathRegex: AJAX, scope: 'args', reason: 'path' }, 'u');
    await db().execute(sql.raw(MIGRATION));
    expect(await listExclusionsForReconciler(db())).toHaveLength(2);
  });

  it('host-wide and per-path rows for one rule coexist; the same path twice is a duplicate', async () => {
    const base = { ruleId: '920420', hostnameRegex: HOST, scope: 'full_disable' as const, reason: 'r' };
    await createExclusion(db(), base, 'u');
    const onPath = await createExclusion(db(), { ...base, pathRegex: AJAX }, 'u');
    expect(onPath.pathRegex).toBe(AJAX);
    await createExclusion(db(), { ...base, pathRegex: '^/other\\.php$' }, 'u');

    expect(await codeOf(createExclusion(db(), { ...base, pathRegex: AJAX }, 'u'))).toBe('DUPLICATE');
    expect(await codeOf(createExclusion(db(), base, 'u'))).toBe('DUPLICATE');
    // The partial unique index refuses it too, should the service check ever be skipped.
    expect(await refusedBy(rawInsert('920420', 'full_disable', AJAX))).toBe('waf_rule_exclusions_unique_enabled');
  });

  it('an update can set and clear the path, and is refused when that collides', async () => {
    const hostWide = await createExclusion(db(), { ruleId: '941160', hostnameRegex: HOST, scope: 'args', reason: 'a' }, 'u');
    const scoped = await updateExclusion(db(), hostWide.id, { pathRegex: AJAX });
    expect(scoped.pathRegex).toBe(AJAX);
    // A second host-wide row is now allowed again, and blocks clearing the path.
    await createExclusion(db(), { ruleId: '941160', hostnameRegex: HOST, scope: 'args', reason: 'b' }, 'u');
    expect(await codeOf(updateExclusion(db(), hostWide.id, { pathRegex: null }))).toBe('DUPLICATE');
    // Omitting pathRegex keeps it.
    expect((await updateExclusion(db(), hostWide.id, { reason: 'kept' })).pathRegex).toBe(AJAX);
  });

  it('text_plain_as_json is refused on any rule but 920420, by the service and by the database', async () => {
    expect(await codeOf(createExclusion(db(), {
      ruleId: '941100', hostnameRegex: HOST, scope: 'text_plain_as_json', reason: 'r',
    }, 'u'))).toBe('INVALID_SCOPE');
    const row = await createExclusion(db(), { ruleId: '941100', hostnameRegex: HOST, scope: 'args', reason: 'r' }, 'u');
    expect(await codeOf(updateExclusion(db(), row.id, { scope: 'text_plain_as_json' }))).toBe('INVALID_SCOPE');
    expect(await refusedBy(rawInsert('941100', 'text_plain_as_json', null))).toBe('waf_rule_exclusions_text_plain_as_json_rule');

    const ok = await createExclusion(db(), {
      ruleId: '920420', hostnameRegex: HOST, pathRegex: AJAX, scope: 'text_plain_as_json', reason: 'H5P beacons',
    }, 'u');
    expect(ok.scope).toBe('text_plain_as_json');
  });

  it('the database refuses a path that could break the rendered SecRule', async () => {
    for (const bad of ['^/a"b', '^/a\nb', '^/a\rb', '^/a\\', '/lib/ajax', 'lib/ajax']) {
      expect(await refusedBy(rawInsert('930120', 'args', bad)), JSON.stringify(bad)).toBe('waf_rule_exclusions_path_regex_safe');
    }
  });

  it('a tenant exclusion takes its host from the route and keeps the path it was given', async () => {
    const region = await seedRegion(db());
    const plan = await seedPlan(db());
    const tenant = await seedTenant(db(), region.id, plan.id);
    const domain = await seedDomain(db(), tenant.id, { domainName: 'moodle.example.test' });
    const routeId = randomUUID();
    await db().insert(ingressRoutes).values({
      id: routeId, domainId: domain.id, hostname: 'moodle.example.test', ingressCname: 'unused.example.test',
    });

    const created = await createExclusionForTenantRoute(db(), tenant.id, routeId, {
      ruleId: '920420', pathRegex: AJAX, scope: 'text_plain_as_json', reason: 'H5P',
    }, 'u');
    expect(created).toMatchObject({ hostnameRegex: HOST, pathRegex: AJAX, tenantId: tenant.id, routeId });
    expect(await codeOf(createExclusionForTenantRoute(db(), tenant.id, routeId, {
      ruleId: '920420', pathRegex: AJAX, scope: 'text_plain_as_json', reason: 'again',
    }, 'u'))).toBe('DUPLICATE');
  });
});
