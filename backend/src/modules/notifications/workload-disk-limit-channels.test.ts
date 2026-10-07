/**
 * tenant.workload_disk_limit must reach the tenant IN THE PANEL. It first
 * shipped as class `availability`, which deliberately never relies on the panel
 * and so resolved to email only — on DEV the tenant got nothing they would
 * read (no email provider configured), while the admin side was fine.
 */
import { describe, it, expect } from 'vitest';
import { effectiveChannels } from './routing/effective-channels.js';

describe('tenant.workload_disk_limit routing', () => {
  it('resolves to in_app AND email for a tenant-scoped event', () => {
    const r = effectiveChannels({
      categoryId: 'tenant.workload_disk_limit',
      // What the seed stores: every channel, filtered by the class rules.
      storedChannels: ['in_app', 'email', 'ntfy'],
      tenantId: '11111111-1111-4111-8111-111111111111',
    });
    expect(r.channels).toContain('in_app');
    expect(r.channels).toContain('email');
    // Tenant data never goes to a broadcast topic.
    expect(r.channels).not.toContain('ntfy');
  });
});
