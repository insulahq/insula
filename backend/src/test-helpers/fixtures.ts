import { regions, hostingPlans, tenants, domains, backups } from '../db/schema.js';
import type { Database } from '../db/index.js';

export async function seedRegion(db: Database, overrides: Partial<typeof regions.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  const defaults = {
    id,
    code: `test-region-${id.slice(0, 8)}`,
    name: 'Test Region',
    provider: 'hetzner',
    status: 'active' as const,
  };
  await db.insert(regions).values({ ...defaults, ...overrides });
  return { ...defaults, ...overrides };
}

export async function seedPlan(db: Database, overrides: Partial<typeof hostingPlans.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  const defaults = {
    id,
    code: `plan-${id.slice(0, 8)}`,
    name: 'Test Plan',
    cpuLimit: '1.00',
    memoryLimit: '2.00',
    storageLimit: '20.00',
    monthlyPriceUsd: '10.00',
    status: 'active' as const,
  };
  await db.insert(hostingPlans).values({ ...defaults, ...overrides });
  return { ...defaults, ...overrides };
}

export async function seedTenant(db: Database, regionId: string, planId: string, overrides: Partial<typeof tenants.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  const defaults = {
    id,
    regionId,
    name: `Test Company ${id.slice(0, 8)}`,
    primaryEmail: `test-${id.slice(0, 8)}@example.com`,
    status: 'active' as const,
    kubernetesNamespace: `tenant-test-${id.slice(0, 8)}`,
    planId,
  };
  await db.insert(tenants).values({ ...defaults, ...overrides });
  return { ...defaults, ...overrides };
}

export async function seedDomain(db: Database, tenantId: string, overrides: Partial<typeof domains.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  const defaults = {
    id,
    tenantId,
    domainName: `test-${id.slice(0, 8)}.example.com`,
    status: 'active' as const,
    dnsMode: 'cname' as const,
  };
  await db.insert(domains).values({ ...defaults, ...overrides });
  return { ...defaults, ...overrides };
}

export async function seedBackup(db: Database, tenantId: string, overrides: Partial<typeof backups.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  const defaults = {
    id,
    tenantId,
    backupType: 'manual' as const,
    resourceType: 'full',
    status: 'completed' as const,
    sizeBytes: 1024000,
    storagePath: `/backups/${tenantId}/${id}.tar.gz`,
  };
  await db.insert(backups).values({ ...defaults, ...overrides });
  return { ...defaults, ...overrides };
}
