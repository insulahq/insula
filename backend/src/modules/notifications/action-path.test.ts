import { describe, it, expect } from 'vitest';
import { notificationActionPath } from './action-path.js';
import { ALL_CATEGORIES } from './categories/seed.js';

describe('notificationActionPath', () => {
  it('routes the reported SLO alert to the monitoring page', () => {
    expect(notificationActionPath({
      categoryId: 'admin.slo_alert_warning', resourceType: null, resourceId: null,
    })).toBe('/monitoring');
  });

  it('deep-links a tenant-scoped admin alert to that tenant', () => {
    expect(notificationActionPath({
      categoryId: 'admin.custom_deployment_failed', resourceType: 'tenant', resourceId: 't-123',
    })).toBe('/tenants/t-123');
  });

  it('falls back to the tenant list when a tenant-scoped alert carries no tenant', () => {
    expect(notificationActionPath({
      categoryId: 'admin.tenant_pod_oom', resourceType: null, resourceId: null,
    })).toBe('/tenants');
  });

  it('returns null for the legacy fallback family (no meaningful page)', () => {
    for (const id of ['legacy.info', 'legacy.warning', 'legacy.error', 'legacy.success']) {
      expect(notificationActionPath({ categoryId: id, resourceType: null, resourceId: null })).toBeNull();
    }
    expect(notificationActionPath({ categoryId: null, resourceType: null, resourceId: null })).toBeNull();
  });

  // Guard against the exact complaint: a notification that lands nowhere.
  // Every real (non-legacy) category MUST resolve to a page.
  it('gives EVERY non-legacy category a clickable landing page', () => {
    const orphans = ALL_CATEGORIES
      .filter((c) => !c.id.startsWith('legacy.'))
      .filter((c) => notificationActionPath({
        categoryId: c.id, resourceType: null, resourceId: null,
      }) === null)
      .map((c) => c.id);
    expect(orphans).toEqual([]);
  });
});
