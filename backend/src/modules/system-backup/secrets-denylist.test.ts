/**
 * Unit + parity tests for the secrets denylist.
 *
 * The unit cases lock in the TS rules. The parity test runs a
 * canonical fixture through BOTH the TS predicate AND the jq filter
 * (via subprocess) and asserts identical decisions — this is the
 * mechanism that catches drift between the two implementations.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { isAutoManaged, DENYLIST_REASONS } from './secrets-denylist.js';

describe('isAutoManaged — TS rules', () => {
  it('denies ServiceAccount tokens by type', () => {
    const r = isAutoManaged({ name: 'default-token-abc', type: 'kubernetes.io/service-account-token', owner: null });
    expect(r.denied).toBe(true);
    expect(r.reason).toBe(DENYLIST_REASONS.SA_TOKEN);
  });

  it('denies docker pull secrets by type', () => {
    expect(isAutoManaged({ name: 'regcred', type: 'kubernetes.io/dockerconfigjson', owner: null }).denied).toBe(true);
    expect(isAutoManaged({ name: 'regcred', type: 'kubernetes.io/dockercfg', owner: null }).denied).toBe(true);
  });

  it('denies Helm release state by name prefix', () => {
    const r = isAutoManaged({ name: 'sh.helm.release.v1.cnpg.v3', type: 'helm.sh/release.v1', owner: null });
    expect(r.denied).toBe(true);
    expect(r.reason).toBe(DENYLIST_REASONS.HELM_STATE);
  });

  it('denies cert-manager-issued TLS by ownerReference', () => {
    const r = isAutoManaged({
      name: 'admin-panel-tls', type: 'kubernetes.io/tls',
      owner: { kind: 'Certificate', apiVersion: 'cert-manager.io/v1' },
    });
    expect(r.denied).toBe(true);
    expect(r.reason).toBe(DENYLIST_REASONS.CERT_MANAGER);
  });

  it('denies SealedSecret unsealed copies', () => {
    const r = isAutoManaged({
      name: 'my-sealed', type: 'Opaque',
      owner: { kind: 'SealedSecret', apiVersion: 'bitnami.com/v1alpha1' },
    });
    expect(r.denied).toBe(true);
    expect(r.reason).toBe(DENYLIST_REASONS.SEALED_SECRET);
  });

  it('denies CNPG-managed cluster credentials', () => {
    const r = isAutoManaged({
      name: 'system-db-superuser', type: 'kubernetes.io/basic-auth',
      owner: { kind: 'Cluster', apiVersion: 'postgresql.cnpg.io/v1' },
    });
    expect(r.denied).toBe(true);
    expect(r.reason).toBe(DENYLIST_REASONS.CNPG);
  });

  it('passes through opaque Secrets with no controller owner', () => {
    const r = isAutoManaged({ name: 'platform-jwt-secret', type: 'Opaque', owner: null });
    expect(r.denied).toBe(false);
    expect(r.reason).toBe(DENYLIST_REASONS.NOT_AUTO_MANAGED);
  });

  it('passes through TLS Secrets without a Certificate owner', () => {
    // Manually-created TLS not from cert-manager — bundles by design.
    const r = isAutoManaged({ name: 'legacy-tls', type: 'kubernetes.io/tls', owner: null });
    expect(r.denied).toBe(false);
  });

  it('passes through Pod-owned Secrets (not auto-managed)', () => {
    const r = isAutoManaged({
      name: 'app-secret', type: 'Opaque',
      owner: { kind: 'Pod', apiVersion: 'v1' },
    });
    expect(r.denied).toBe(false);
  });
});

// ─── Parity with jq filter ─────────────────────────────────────────────

const JQ_FILTER = path.resolve(__dirname, '../../../../scripts/lib/secrets-denylist.jq');

// Canonical fixture exercising every rule. Each entry has the shape
// k8s would actually serialise (with .metadata.ownerReferences as an
// array). We run it through both implementations and assert agreement.
const FIXTURE = [
  { type: 'kubernetes.io/service-account-token', metadata: { name: 'default-token-abc', namespace: 'default', ownerReferences: [] } },
  { type: 'kubernetes.io/dockerconfigjson', metadata: { name: 'regcred', namespace: 'platform', ownerReferences: [] } },
  { type: 'kubernetes.io/dockercfg', metadata: { name: 'regcred-old', namespace: 'kube-system', ownerReferences: [] } },
  { type: 'helm.sh/release.v1', metadata: { name: 'sh.helm.release.v1.cnpg.v3', namespace: 'cnpg-system', ownerReferences: [] } },
  { type: 'kubernetes.io/tls', metadata: { name: 'cert-managed-tls', namespace: 'platform', ownerReferences: [{ kind: 'Certificate', apiVersion: 'cert-manager.io/v1', name: 'foo' }] } },
  { type: 'Opaque', metadata: { name: 'unsealed', namespace: 'platform', ownerReferences: [{ kind: 'SealedSecret', apiVersion: 'bitnami.com/v1alpha1', name: 'foo' }] } },
  { type: 'kubernetes.io/basic-auth', metadata: { name: 'cnpg-superuser', namespace: 'platform', ownerReferences: [{ kind: 'Cluster', apiVersion: 'postgresql.cnpg.io/v1', name: 'system-db' }] } },
  { type: 'Opaque', metadata: { name: 'platform-jwt-secret', namespace: 'platform', ownerReferences: [] } },
  { type: 'kubernetes.io/tls', metadata: { name: 'legacy-tls', namespace: 'platform', ownerReferences: [] } },
  { type: 'Opaque', metadata: { name: 'app-secret', namespace: 'tenant-foo', ownerReferences: [{ kind: 'Pod', apiVersion: 'v1', name: 'pod-x' }] } },
];

describe('isAutoManaged — TS↔jq parity', () => {
  const hasJq = spawnSync('which', ['jq']).status === 0;
  const hasFilter = existsSync(JQ_FILTER);

  it.runIf(hasJq && hasFilter)('every fixture entry yields identical TS + jq decisions', () => {
    const input = JSON.stringify({ items: FIXTURE });
    const result = spawnSync('jq', ['-c', '-f', JQ_FILTER], { input, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`jq failed: ${result.stderr}`);
    }
    const jqRows = result.stdout
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { namespace: string; name: string; decision: { denied: boolean; reason: string } });

    for (const fx of FIXTURE) {
      const ts = isAutoManaged({
        name: fx.metadata.name,
        type: fx.type ?? 'Opaque',
        owner: fx.metadata.ownerReferences[0] ?? null,
      });
      const jq = jqRows.find((r) => r.namespace === fx.metadata.namespace && r.name === fx.metadata.name);
      expect(jq, `jq row missing for ${fx.metadata.namespace}/${fx.metadata.name}`).toBeTruthy();
      expect(jq!.decision.denied, `denied mismatch for ${fx.metadata.name}`).toBe(ts.denied);
      expect(jq!.decision.reason, `reason mismatch for ${fx.metadata.name}`).toBe(ts.reason);
    }
  });

  if (!hasJq || !hasFilter) {
    it.skip('TS↔jq parity (jq or filter missing)', () => undefined);
  }
});
