import { describe, it, expect } from 'vitest';
import { assertKnownCategory, alert, rankAlerts } from './alerts.js';
import { ALL_CATEGORIES } from '../notifications/categories/seed.js';

/**
 * The invariant: a dashboard alert tile may only exist where a notification
 * category exists to raise it.
 *
 * Two tiles in the first draft failed this and nobody noticed, because a tile
 * that can never fire looks exactly like a tile that simply has nothing to
 * report: "low free memory" and "mailbox count near the plan limit". Both read
 * as monitoring. Neither had a category, so no code path could ever have
 * produced them.
 */
describe('alert category guard', () => {
  it('accepts a category that exists and is actionable', () => {
    expect(() => assertKnownCategory('admin.cert_expiring')).not.toThrow();
    expect(() => assertKnownCategory('mailbox.quota_threshold')).not.toThrow();
    expect(() => assertKnownCategory('tenant.bandwidth_warning')).not.toThrow();
  });

  it('refuses a category that does not exist', () => {
    // The shape of the two tiles this guard was written for.
    expect(() => assertKnownCategory('admin.low_free_memory'))
      .toThrow(/unknown notification category/);
    expect(() => assertKnownCategory('tenant.mailbox_count_near_limit'))
      .toThrow(/unknown notification category/);
  });

  it('refuses a real category that is not actionable', () => {
    // `record` and `ambient` categories are history. An alert tile says
    // "something needs you", and a receipt does not.
    const record = ALL_CATEGORIES.find((c) => c.cls === 'record');
    expect(record).toBeDefined();
    expect(() => assertKnownCategory(record!.id)).toThrow(/non-actionable/);
  });

  it('the guard runs on construction, not just on demand', () => {
    expect(() => alert({
      categoryId: 'admin.not_a_real_category',
      severity: 'warning', value: '1', title: 'x', subtitle: '', href: '/x',
      detail: [], note: null,
    })).toThrow(/unknown notification category/);
  });

  it('every category the builders reference is real', () => {
    // Pinned so a category RENAMED in seed.ts fails here rather than silently
    // removing a tile from the dashboard.
    const referenced = [
      'admin.cert_expiring', 'admin.cluster_storage_capacity',
      'admin.mailbox_quota_fleet', 'admin.tenant_resource_saturation_warning',
      'admin.tenant_resource_saturation_critical', 'admin.slo_alert_critical',
      'admin.slo_alert_warning', 'admin.node_event',
      'tenant.resource_saturation_warning', 'tenant.resource_saturation_critical',
      'mailbox.quota_threshold', 'mailbox.quota_exceeded',
      'tenant.bandwidth_warning', 'tenant.bandwidth_exceeded',
      'tasks.scheduled_failure', 'tenant.domain_verification',
    ];
    const missing = referenced.filter((id) => {
      try { assertKnownCategory(id); return false; } catch { return true; }
    });
    expect(missing).toEqual([]);
  });
});

describe('rankAlerts', () => {
  const mk = (severity: 'warning' | 'critical', value: string) => ({
    categoryId: 'admin.cert_expiring', severity, value,
    title: 't', subtitle: '', href: '/x', detail: [], note: null,
  });

  it('puts critical before warning whatever the figures say', () => {
    const out = rankAlerts([mk('warning', '900'), mk('critical', '1')]);
    expect(out.map((a) => a.severity)).toEqual(['critical', 'warning']);
  });

  it('orders within a severity by the headline figure', () => {
    const out = rankAlerts([mk('warning', '3'), mk('warning', '12'), mk('warning', '7')]);
    expect(out.map((a) => a.value)).toEqual(['12', '7', '3']);
  });

  it('reads a percentage as a number, not as text', () => {
    // "94%" must sort above "9%" — string ordering would invert them.
    const out = rankAlerts([mk('warning', '9%'), mk('warning', '94%')]);
    expect(out.map((a) => a.value)).toEqual(['94%', '9%']);
  });
});
