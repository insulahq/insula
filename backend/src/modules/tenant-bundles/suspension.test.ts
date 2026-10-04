import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { assertTenantBackupsAllowed, TENANT_SUSPENDED_BACKUP_MESSAGE } from './suspension.js';

describe('assertTenantBackupsAllowed', () => {
  it('refuses a suspended tenant with 409 TENANT_SUSPENDED', () => {
    expect(() => assertTenantBackupsAllowed({ status: 'suspended' })).toThrow(
      expect.objectContaining({ code: 'TENANT_SUSPENDED', status: 409, message: TENANT_SUSPENDED_BACKUP_MESSAGE }),
    );
  });

  it.each(['active', 'pending'])('lets a %s tenant through', (status) => {
    expect(() => assertTenantBackupsAllowed({ status })).not.toThrow();
  });
});

// Both "Back up now" entry points must refuse a suspended tenant: the admin
// bundle route and the tenant panel's run-now. (The nightly wave filters in
// SQL; see suspended-backups.integration.test.ts.)
describe('every manual bundle route checks suspension', () => {
  const MODULES = join(import.meta.dirname, '..');
  it.each([
    ['admin: POST /admin/tenant-bundles', 'tenant-bundles/routes.ts', "app.post('/admin/tenant-bundles', {"],
    ['tenant: POST /tenants/:tenantId/bundles/run-now', 'backup-restore/tenant-routes.ts', "app.post('/tenants/:tenantId/bundles/run-now', {"],
  ])('%s', (_label, file, routeStart) => {
    const src = readFileSync(join(MODULES, file), 'utf8');
    const start = src.indexOf(routeStart);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('app.post(', start + routeStart.length);
    const handler = src.slice(start, next === -1 ? undefined : next);
    const guard = handler.indexOf('assertTenantBackupsAllowed(tenant)');
    expect(guard).toBeGreaterThan(-1);
    // Before any bundle is reserved or started.
    expect(guard).toBeLessThan(handler.indexOf('runBundle('));
  });
});
