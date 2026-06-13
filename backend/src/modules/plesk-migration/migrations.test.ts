import { describe, it, expect } from 'vitest';
import { toMigrationResponse, type MigrationRow } from './migrations.js';

function row(extra: Partial<MigrationRow> = {}): MigrationRow {
  return {
    id: 'm1',
    sourceId: 's1',
    discoveryId: 'd1',
    subscriptionName: 'acme.example',
    subscriptionSnapshot: { name: 'acme.example' },
    // tenant-first mapping: tenant is set at create, plan is derived (nullable).
    targetPlanId: 'plan-basic',
    contactEmail: null,
    targetTenantId: 'tenant-1',
    status: 'pending',
    legs: {},
    error: null,
    createdBy: 'u1',
    createdAt: new Date('2026-06-13T00:00:00.000Z'),
    updatedAt: new Date('2026-06-13T00:00:00.000Z'),
    ...extra,
  } as MigrationRow;
}

describe('toMigrationResponse', () => {
  it('NEVER leaks the frozen snapshot, contactEmail, or createdBy to clients', () => {
    const resp = toMigrationResponse(row({ contactEmail: 'admin@acme.example' }));
    const json = JSON.stringify(resp);
    expect(json).not.toContain('subscriptionSnapshot');
    expect(json).not.toContain('contactEmail');
    expect(json).not.toContain('createdBy');
    expect('subscriptionSnapshot' in resp).toBe(false);
  });

  it('maps the operator-facing fields', () => {
    const resp = toMigrationResponse(row({ status: 'running', targetTenantId: 't1' }));
    expect(resp).toMatchObject({
      id: 'm1', sourceId: 's1', discoveryId: 'd1',
      subscriptionName: 'acme.example', targetPlanId: 'plan-basic',
      targetTenantId: 't1', status: 'running',
    });
  });

  it('tolerates a null targetPlanId (derived; nullable under tenant-first)', () => {
    const resp = toMigrationResponse(row({ targetPlanId: null }));
    expect(resp.targetPlanId).toBeNull();
    expect(resp.targetTenantId).toBe('tenant-1');
  });

  it('passes the legs jsonb through, and null legs become null', () => {
    const withLegs = toMigrationResponse(row({
      legs: { tenant: { status: 'completed', detail: 'tenant t1' } },
    }));
    expect(withLegs.legs?.tenant?.status).toBe('completed');

    const noLegs = toMigrationResponse(row({ legs: null as unknown as Record<string, unknown> }));
    expect(noLegs.legs).toBeNull();
  });
});
