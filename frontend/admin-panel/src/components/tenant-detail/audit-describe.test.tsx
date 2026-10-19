import { describe, it, expect } from 'vitest';
import { describeAuditWhat } from './audit-describe';

const entry = (over: Partial<Parameters<typeof describeAuditWhat>[0]>) => ({
  actionType: 'update', resourceType: 'tenant', httpMethod: 'PATCH', httpPath: '/api/v1/tenants/t1', changes: null, ...over,
});

describe('describeAuditWhat', () => {
  it('names a request by its path first', () => {
    expect(describeAuditWhat(entry({ httpMethod: 'POST', httpPath: '/api/v1/admin/impersonate/t1' }))).toBe('Signed in to the tenant panel as this tenant');
    expect(describeAuditWhat(entry({ httpMethod: 'POST', httpPath: '/api/v1/admin/cpu-migration/tenants/t1/apply' }))).toBe('CPU settings applied to the cluster');
    expect(describeAuditWhat(entry({ httpPath: '/api/v1/tenants/t1/mail/imapsync/j1/resync' }))).toBe('Mail migration re-synced');
  });

  it('then by the fields a tenant update changed', () => {
    expect(describeAuditWhat(entry({ changes: { email_send_rate_limit: 10 } }))).toBe('Send limits changed');
    expect(describeAuditWhat(entry({ changes: { plan_id: 'p2' } }))).toBe('Plan changed');
  });

  it('falls back to the resource and action as recorded, never dropping a row', () => {
    expect(describeAuditWhat(entry({ changes: { contact_name: 'x' } }))).toBe('Tenant settings changed');
    expect(describeAuditWhat(entry({ actionType: 'create', resourceType: 'webhook_endpoint', httpPath: '/api/v1/x' }))).toBe('Webhook endpoint created');
  });
});
