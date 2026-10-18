/**
 * admin.tenant_workloads_down must reach the operator IN THE PANEL. It
 * shipped as class `availability` (the platform's own reachability — never
 * relies on the panel), so on production a tenant left FAILED by
 * the auto-heal was announced by push and by an email queued behind a mail
 * outage, and the bell showed nothing. Migration 0158 fixes the stored value.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { effectiveChannels } from './routing/effective-channels.js';

describe('workloads down / running again — routing', () => {
  it('admin.tenant_workloads_down reaches the bell, email and push', () => {
    const r = effectiveChannels({ categoryId: 'admin.tenant_workloads_down', storedChannels: ['in_app', 'email', 'ntfy'] });
    expect(r.channels).toEqual(expect.arrayContaining(['in_app', 'email', 'ntfy']));
  });

  it('the "running again" notices reach the panel for both audiences', () => {
    expect(effectiveChannels({ categoryId: 'admin.tenant_workloads_recovered', storedChannels: ['in_app', 'email', 'ntfy'] }).channels)
      .toContain('in_app');
    const tenant = effectiveChannels({
      categoryId: 'tenant.workloads_recovered',
      storedChannels: ['in_app', 'email', 'ntfy'],
      tenantId: '11111111-1111-4111-8111-111111111111',
    });
    expect(tenant.channels).toContain('in_app');
    expect(tenant.channels).not.toContain('ntfy');
  });

  it('migration 0158 rewrites only the exact first-seed value', () => {
    const sql = readFileSync(fileURLToPath(new URL('../../db/migrations/0158_tenant_workloads_down_in_app.sql', import.meta.url)), 'utf8');
    expect(sql).toContain(`WHERE "id" = 'admin.tenant_workloads_down'`);
    expect(sql).toContain(`AND "default_channels" = ARRAY['email', 'ntfy']::text[]`);
  });
});
