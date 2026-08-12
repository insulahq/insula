import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard: WORKER nodes must be able to read the cluster's pinned
 * version.
 *
 * The bug (found 2026-08-11 rolling an RC onto staging): `readRunningVersion`
 * hardcoded `/etc/rancher/k3s/k3s.yaml`, which k3s AGENTS do not have. It then
 * fell through to in-cluster config, which needs a projected ServiceAccount
 * token that a host process has no mount for — so the read always threw on a
 * worker and self-upgrade dropped to the `releases` path. That path returns
 * only the newest STABLE release, so a worker could never select a prerelease:
 * host state (firewall shape, sysctls, packages, host-migrations) diverged from
 * the control plane for the entire life of every RC, which meant nothing
 * host-side was ever really validated before a stable cut.
 *
 * Two halves have to stay true, and NEITHER is observable from a normal unit
 * test of the upgrade logic:
 *   1. the code resolves the kubeconfig the same way the host-config converger
 *      does (admin kubeconfig on servers, scoped kubeconfig on workers), and
 *   2. the scoped ServiceAccount is actually PERMITTED to read the ConfigMap.
 *
 * Half 1 without half 2 is a 403; half 2 without half 1 is never even attempted.
 * Both regress silently — the fallback is by design non-fatal — so they are
 * asserted at the source/manifest level rather than left to a live cluster.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF_UPGRADE_SRC = path.join(HERE, 'index.ts');
const RBAC_MANIFEST = path.resolve(HERE, '../../../../../k8s/base/host-config-reader/rbac.yaml');

describe('worker target resolution — self-upgrade kubeconfig', () => {
  const src = readFileSync(SELF_UPGRADE_SRC, 'utf8');

  it('resolves the kubeconfig via the shared host-config resolver', () => {
    expect(src).toMatch(/resolveHostConfigKubeconfig/);
  });

  it('does not fall back to the control-plane-only k3s admin path on its own', () => {
    // The literal may legitimately appear inside the shared resolver, but not
    // as this file's own hardcoded default — that is precisely the regression.
    expect(src).not.toMatch(/KUBECONFIG\?\.trim\(\)\s*\|\|\s*'\/etc\/rancher\/k3s\/k3s\.yaml'/);
  });
});

describe('worker target resolution — RBAC for platform-version', () => {
  const rbac = readFileSync(RBAC_MANIFEST, 'utf8');

  it('grants the host-config-reader SA get on platform-version', () => {
    expect(rbac).toMatch(/resourceNames:\s*\["platform-version"\]/);
  });

  it('scopes that grant to the platform namespace (where the CM lives)', () => {
    // The pre-existing Role is namespaced to platform-system; platform-version
    // lives in `platform`, which is exactly why it was never covered.
    expect(rbac).toMatch(/name:\s*host-config-reader-platform-version[\s\S]*?namespace:\s*platform\b/);
  });

  it('binds it to the same ServiceAccount the workers already use', () => {
    expect(rbac).toMatch(/kind:\s*ServiceAccount\s*\n\s*name:\s*host-config-reader\s*\n\s*namespace:\s*platform-system/);
  });

  it('stays least-privilege: get only, no list/watch/write on that grant', () => {
    const block = rbac.slice(rbac.indexOf('host-config-reader-platform-version'));
    const verbs = block.match(/verbs:\s*\[([^\]]*)\]/);
    expect(verbs).not.toBeNull();
    expect(verbs?.[1]).toContain('get');
    for (const forbidden of ['list', 'watch', 'create', 'update', 'patch', 'delete']) {
      expect(verbs?.[1]).not.toContain(forbidden);
    }
  });
});
