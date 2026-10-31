/**
 * The tenants each node's loss would affect, read from tenant_placement_state.
 * A local-tier tenant depends on every node with its workloads, volumes or
 * data; an HA-tier tenant only on where it runs or has its volume attached.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { loadTenantNodes } from './node-loss.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('loadTenantNodes (integration)', () => {
  const db = () => getTestDb();
  let regionId = '';
  let planId = '';

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql`TRUNCATE TABLE tenant_placement_state CASCADE`);
    regionId = (await seedRegion(db())).id;
    planId = (await seedPlan(db())).id;
  });

  const place = async (
    over: Parameters<typeof seedTenant>[3],
    p: { tier: 'local' | 'ha'; workload: string[]; attached: string[]; data: string[] },
  ) => {
    const t = await seedTenant(db(), regionId, planId, over);
    await db().execute(sql`
      INSERT INTO tenant_placement_state (tenant_id, status, primary_node, storage_tier, workload_nodes, attached_nodes, data_nodes)
      VALUES (${t.id}, 'placed', ${p.workload[0] ?? null}, ${p.tier},
              ${`{${p.workload.join(',')}}`}::text[], ${`{${p.attached.join(',')}}`}::text[], ${`{${p.data.join(',')}}`}::text[])
    `);
  };

  it('counts each active customer tenant once per node it depends on', async () => {
    // Local, with its data also on sv2 (a replica being built elsewhere).
    await place({}, { tier: 'local', workload: ['sv1'], attached: ['sv1'], data: ['sv1', 'sv2'] });
    // HA: replicas on three nodes, but it only runs on sv1.
    await place({}, { tier: 'ha', workload: ['sv1'], attached: ['sv1'], data: ['sv1', 'sv2', 'sv3'] });
    // No workloads at all (mail only): depends on no node.
    await place({}, { tier: 'local', workload: [], attached: [], data: [] });
    // Not counted: suspended, and the system tenant.
    await place({ status: 'suspended' }, { tier: 'local', workload: [], attached: [], data: ['sv3'] });
    await place({ isSystem: true }, { tier: 'local', workload: ['sv3'], attached: ['sv3'], data: ['sv3'] });

    const rows = (await loadTenantNodes(db())).map((ns) => [...ns].sort());
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expect.arrayContaining([['sv1', 'sv2'], ['sv1'], []]));
  });
});
