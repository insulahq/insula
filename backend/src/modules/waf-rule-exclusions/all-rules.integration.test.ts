/**
 * Migration 0184 on real Postgres: the all_rules scope (no rule id, a path
 * required) through the service and the DB CHECKs.
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
  fileURLToPath(new URL('../../db/migrations/0184_waf_pass_reason_trusted_ips.sql', import.meta.url)),
  'utf8',
);
const HOST = '^shop\\.example\\.test$';
const MCP = '^/mcp$';

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof WafRuleExclusionError ? err.code : `other: ${(err as Error).message}`;
  }
};
const refusedBy = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'accepted';
  } catch (err) {
    const cause = (err as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? `other: ${(err as Error).message}`;
  }
};
const rawInsert = (ruleId: string, scope: string, pathRegex: string | null, extra: { tenantId?: string; routeId?: string; host?: string } = {}) =>
  getTestDb().execute(sql`
    INSERT INTO waf_rule_exclusions (id, rule_id, hostname_regex, path_regex, scope, reason, created_by, tenant_id, route_id)
    VALUES (${randomUUID()}, ${ruleId}, ${extra.host ?? HOST}, ${pathRegex}, ${scope}, 'raw', 'test', ${extra.tenantId ?? null}, ${extra.routeId ?? null})`);

describe.skipIf(!dbAvailable)('WAF exclusions — scope all_rules (migration 0184, integration)', () => {
  const db = () => getTestDb();
  beforeAll(async () => {
    await runMigrations();
    // Another file may replay an older migration that redefines the scope
    // CHECK; this one's definition is what is under test. Replay-safe.
    await db().execute(sql.raw(MIGRATION));
  });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('DELETE FROM waf_rule_exclusions'));
  });

  it('the migration replays cleanly over its own result', async () => {
    await createExclusion(db(), { ruleId: '0', hostnameRegex: HOST, pathRegex: MCP, scope: 'all_rules', reason: 'r' }, 'u');
    await db().execute(sql.raw(MIGRATION));
    expect(await listExclusionsForReconciler(db())).toHaveLength(1);
  });

  it('all_rules takes rule 0 and a path, and nothing else takes rule 0 — service and database alike', async () => {
    const row = await createExclusion(db(), { ruleId: '0', hostnameRegex: HOST, pathRegex: MCP, scope: 'all_rules', reason: 'MCP' }, 'u');
    expect(row).toMatchObject({ ruleId: '0', scope: 'all_rules', pathRegex: MCP });

    expect(await codeOf(createExclusion(db(), { ruleId: '0', hostnameRegex: HOST, scope: 'all_rules', reason: 'r' }, 'u'))).toBe('INVALID_SCOPE');
    expect(await codeOf(createExclusion(db(), { ruleId: '941100', hostnameRegex: HOST, pathRegex: MCP, scope: 'all_rules', reason: 'r' }, 'u'))).toBe('INVALID_SCOPE');
    expect(await codeOf(createExclusion(db(), { ruleId: '0', hostnameRegex: HOST, pathRegex: MCP, scope: 'args', reason: 'r' }, 'u'))).toBe('INVALID_SCOPE');
    // An update can neither clear its path nor give it another scope.
    expect(await codeOf(updateExclusion(db(), row.id, { pathRegex: null }))).toBe('INVALID_SCOPE');
    expect(await codeOf(updateExclusion(db(), row.id, { scope: 'full_disable' }))).toBe('INVALID_SCOPE');
    expect(await codeOf(createExclusion(db(), { ruleId: '0', hostnameRegex: HOST, pathRegex: MCP, scope: 'all_rules', reason: 'again' }, 'u'))).toBe('DUPLICATE');

    expect(await refusedBy(rawInsert('0', 'all_rules', null))).toBe('waf_rule_exclusions_all_rules_shape');
    expect(await refusedBy(rawInsert('941100', 'all_rules', '^/x$'))).toBe('waf_rule_exclusions_all_rules_shape');
    expect(await refusedBy(rawInsert('0', 'full_disable', '^/x$'))).toBe('waf_rule_exclusions_all_rules_shape');
  });

  describe('tenant routes', () => {
    const ids = { tenant: '', exact: '' };
    beforeEach(async () => {
      const region = await seedRegion(db());
      const plan = await seedPlan(db());
      const tenant = await seedTenant(db(), region.id, plan.id);
      const domain = await seedDomain(db(), tenant.id, { domainName: 'example.test' });
      ids.tenant = tenant.id;
      ids.exact = randomUUID();
      await db().insert(ingressRoutes).values({ id: ids.exact, domainId: domain.id, hostname: 'shop.example.test', ingressCname: 'unused.example.test' });
    });

    it('a tenant all_rules exclusion takes its host from the route', async () => {
      const row = await createExclusionForTenantRoute(db(), ids.tenant, ids.exact, { ruleId: '0', pathRegex: MCP, scope: 'all_rules', reason: 'MCP' }, 'owner');
      expect(row).toMatchObject({ hostnameRegex: HOST, pathRegex: MCP, tenantId: ids.tenant, routeId: ids.exact });
    });
  });
});
