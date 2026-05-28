/**
 * Tests for the CRITICAL safety wiring caught in code review:
 * config-tables executor MUST redact denied columns when invoked
 * from a tenant cart. Without the redaction, a tenant could
 * overwrite tenants.plan_id, tenants.is_system, *_override quotas,
 * region_id, etc — i.e. escalate via a self-restore.
 *
 * We test at the executor boundary: stub the bundle dump, stub
 * upsertRow, run execConfigTablesItem with + without policy, assert
 * the rows actually upserted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertedRows: Array<{ table: string; row: Record<string, unknown> }> = [];

// Mock _shared.upsertRow BEFORE importing the executor.
vi.mock('./_shared.js', () => ({
  upsertRow: vi.fn(async (_tx: unknown, sqlTable: string, row: Record<string, unknown>) => {
    upsertedRows.push({ table: sqlTable, row });
  }),
  readAndAuthorizeConfigDump: vi.fn(async () => ({
    tables: {
      tenants: [
        {
          id: 'tenant-victim',
          name: 'Victim Tenant',
          plan_id: 'premium-tier',      // billing — must be redacted
          is_system: true,              // privilege flag — must be redacted
          storage_limit_override: 99999999, // operator quota — must be redacted
          region_id: 'other-region',    // placement — must be redacted
          status: 'active',             // benign — must be preserved
        },
      ],
      domains: [
        {
          id: 'domain-1',
          hostname: 'example.com',
          tenant_id: 'tenant-victim',
        },
      ],
    },
  })),
}));

const { execConfigTablesItem } = await import('./config-tables.js');
const { DEFAULT_TENANT_RESTORE_POLICY } = await import('../tenant-restore-policy.js');

interface MinimalDb {
  transaction: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

function makeApp(): {
  app: { db: MinimalDb; log: { info: () => void; warn: () => void; error: () => void; debug: () => void } };
} {
  const db: MinimalDb = {
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
    execute: vi.fn(),
  };
  return {
    app: {
      db,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    },
  };
}

describe('execConfigTablesItem — tenant policy redaction', () => {
  beforeEach(() => {
    upsertedRows.length = 0;
  });

  it('strips denied columns from the tenants row when tenantPolicy is passed', async () => {
    const { app } = makeApp();
    const item = {
      id: 'item-1',
      bundleId: 'bundle-1',
      type: 'config-tables',
      selector: { kind: 'tables', tables: ['tenants'] },
    } as unknown as Parameters<typeof execConfigTablesItem>[0]['item'];

    await execConfigTablesItem({
      app: app as unknown as Parameters<typeof execConfigTablesItem>[0]['app'],
      item,
      store: {} as unknown as Parameters<typeof execConfigTablesItem>[0]['store'],
      tenantPolicy: DEFAULT_TENANT_RESTORE_POLICY,
    });

    expect(upsertedRows.length).toBe(1);
    const upserted = upsertedRows[0]!.row;

    // Benign fields preserved.
    expect(upserted.id).toBe('tenant-victim');
    expect(upserted.name).toBe('Victim Tenant');
    expect(upserted.status).toBe('active');

    // Denied fields removed.
    expect(upserted).not.toHaveProperty('plan_id');
    expect(upserted).not.toHaveProperty('is_system');
    expect(upserted).not.toHaveProperty('storage_limit_override');
    expect(upserted).not.toHaveProperty('region_id');
  });

  it('leaves the row untouched when tenantPolicy is undefined (admin path)', async () => {
    const { app } = makeApp();
    const item = {
      id: 'item-2',
      bundleId: 'bundle-1',
      type: 'config-tables',
      selector: { kind: 'tables', tables: ['tenants'] },
    } as unknown as Parameters<typeof execConfigTablesItem>[0]['item'];

    await execConfigTablesItem({
      app: app as unknown as Parameters<typeof execConfigTablesItem>[0]['app'],
      item,
      store: {} as unknown as Parameters<typeof execConfigTablesItem>[0]['store'],
      // No tenantPolicy => admin path.
    });

    expect(upsertedRows.length).toBe(1);
    const upserted = upsertedRows[0]!.row;
    // Admin gets the raw row, including operator-only fields.
    expect(upserted.plan_id).toBe('premium-tier');
    expect(upserted.is_system).toBe(true);
    expect(upserted.storage_limit_override).toBe(99999999);
  });

  it('does not redact columns of other tables (e.g. domains have no policy entry)', async () => {
    const { app } = makeApp();
    const item = {
      id: 'item-3',
      bundleId: 'bundle-1',
      type: 'config-tables',
      selector: { kind: 'tables', tables: ['domains'] },
    } as unknown as Parameters<typeof execConfigTablesItem>[0]['item'];

    await execConfigTablesItem({
      app: app as unknown as Parameters<typeof execConfigTablesItem>[0]['app'],
      item,
      store: {} as unknown as Parameters<typeof execConfigTablesItem>[0]['store'],
      tenantPolicy: DEFAULT_TENANT_RESTORE_POLICY,
    });

    expect(upsertedRows.length).toBe(1);
    const upserted = upsertedRows[0]!.row;
    expect(upserted.id).toBe('domain-1');
    expect(upserted.hostname).toBe('example.com');
    expect(upserted.tenant_id).toBe('tenant-victim');
  });
});
