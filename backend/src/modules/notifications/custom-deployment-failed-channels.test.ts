/**
 * tenant.custom_deployment_failed must reach the tenant IN THE PANEL — the
 * complaint it answers is "no in-app notification". An `availability` class
 * would resolve to email only (see workload-disk-limit-channels.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { effectiveChannels } from './routing/effective-channels.js';
import { ALL_SEED_TEMPLATES } from './templates/seed-data.js';
import { notificationActionPath } from './action-path.js';

describe('tenant.custom_deployment_failed', () => {
  it('resolves to in_app AND email for the tenant, never a broadcast topic', () => {
    const r = effectiveChannels({
      categoryId: 'tenant.custom_deployment_failed',
      storedChannels: ['in_app', 'email', 'ntfy'],
      tenantId: '11111111-1111-4111-8111-111111111111',
    });
    expect(r.channels).toContain('in_app');
    expect(r.channels).toContain('email');
    expect(r.channels).not.toContain('ntfy');
  });

  it('has an email and an in-app template (ntfy is derived from in-app), naming the container and the reason', () => {
    const seeds = ALL_SEED_TEMPLATES.filter((t) => t.categoryId === 'tenant.custom_deployment_failed');
    expect(seeds.map((t) => t.channel)).toEqual(expect.arrayContaining(['email', 'in_app']));
    for (const t of seeds) {
      expect(t.bodyTemplate).toContain('{{deploymentName}}');
      expect(t.bodyTemplate).toContain('{{reason}}');
    }
  });

  it('opens the Custom Containers tab', () => {
    expect(notificationActionPath({ categoryId: 'tenant.custom_deployment_failed', resourceType: null, resourceId: null })).toBe('/applications/custom');
  });
});
