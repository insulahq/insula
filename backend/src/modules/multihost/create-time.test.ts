import { describe, it, expect } from 'vitest';
import { createDeploymentSchema } from '@insula/api-contracts';
import { multihostMountsFor } from './reconciler.js';

const CAP = {
  server: 'apache', web_root: '/var/www/html', sites_root: '/var/www/sites',
  config_dir: '/etc/apache2/insula/sites.d', common_include: '/etc/apache2/insula/site-common.conf',
  listen: 8080, validate: ['apache2ctl', 'configtest'], reload: ['apache2ctl', 'graceful'],
};
const base = { catalog_entry_id: '11111111-1111-4111-8111-111111111111', name: 'sites' };

describe('multi-host at deployment creation', () => {
  it('accepts the flag on create', () => {
    const r = createDeploymentSchema.safeParse({ ...base, multihost_enabled: true });
    expect(r.success).toBe(true);
    expect(r.success && r.data.multihost_enabled).toBe(true);
  });

  it('is optional — every existing caller omits it', () => {
    const r = createDeploymentSchema.safeParse(base);
    expect(r.success).toBe(true);
    expect(r.success && r.data.multihost_enabled).toBeUndefined();
  });

  it('resolves mounts for a capable entry, so the pod is BORN with them', () => {
    // The whole point of offering this at create: enabling it afterwards
    // rewrites the pod template and restarts the app.
    const m = multihostMountsFor({ name: 'sites', multihostEnabled: true }, { multihost: CAP });
    expect(m).toEqual({
      configDir: '/etc/apache2/insula/sites.d',
      sitesRoot: '/var/www/sites',
      configMapName: 'sites-vhosts',
    });
  });

  it('resolves to null when the flag is off, so an ordinary create is untouched', () => {
    expect(multihostMountsFor({ name: 'sites', multihostEnabled: false }, { multihost: CAP })).toBeNull();
  });

  it('resolves to null when the entry declares no capability', () => {
    // The service refuses this combination outright; the helper must not
    // invent mounts for it either.
    expect(multihostMountsFor({ name: 'sites', multihostEnabled: true }, { multihost: null })).toBeNull();
  });
});
