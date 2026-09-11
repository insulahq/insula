/**
 * Guard: the CNPG backup plugin must scale with the platform tier.
 *
 * Regression test for the 2026-09-11 node-outage drill. `barman-cloud` ran
 * at `replicas: 1`, so killing its node left the CNPG operator unable to
 * load the plugin. CNPG then refused to reconcile the Cluster at all and
 * never promoted a new Postgres primary — the platform database and the
 * whole management API were down ~6.5 min until Kubernetes' 300 s
 * not-ready eviction rescheduled the pod.
 *
 * Scaling the operator without its plugin is not HA, so both must be in the
 * leader-elect tier together. These tests fail if either is dropped, or if
 * the manifest stops being shaped for multi-replica scheduling.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  LEADER_ELECT_DEPLOYMENTS,
  leaderElectReplicasForSystemTier,
} from './service.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const cnpgDir = resolve(repoRoot, 'k8s/base/cnpg-system');

describe('CNPG plugin HA', () => {
  it('scales barman-cloud alongside the CNPG operator', () => {
    const names = LEADER_ELECT_DEPLOYMENTS
      .filter((d) => d.namespace === 'cnpg-system')
      .map((d) => d.name)
      .sort();
    // Both, not either: a reachable operator that cannot reach its plugin
    // does not reconcile, which is exactly the wedge the drill produced.
    expect(names).toEqual(['barman-cloud', 'cnpg-cloudnative-pg']);
  });

  it('gives the plugin a warm standby in HA and a single pod in local tier', () => {
    expect(leaderElectReplicasForSystemTier('ha', 3)).toBe(2);
    expect(leaderElectReplicasForSystemTier('local', 3)).toBe(1);
  });

  it('strips the vendored replicas field so Flux does not fight the reconciler', () => {
    // The vendored upstream manifest DOES ship `replicas: 1` — assert that,
    // so this test proves the kustomize patch is load-bearing rather than
    // passing vacuously against a manifest that never had the field.
    const vendored = readFileSync(
      resolve(cnpgDir, 'plugin-barman-cloud-v0.13.0.yaml'),
      'utf8',
    );
    expect(vendored).toMatch(/^\s*replicas:\s*1\s*$/m);

    const kustomization = readFileSync(resolve(cnpgDir, 'kustomization.yaml'), 'utf8');
    expect(kustomization).toContain('op: remove');
    expect(kustomization).toContain('/spec/replicas');
  });

  it('ships the topology spread and PDB that multi-replica scaling depends on', () => {
    const patch = readFileSync(resolve(cnpgDir, 'patch-barman-cloud-ha.yaml'), 'utf8');
    // Two replicas on one node would not have survived the drill.
    expect(patch).toContain('topologySpreadConstraints');
    expect(patch).toContain('whenUnsatisfiable: DoNotSchedule');
    // Recreate would drop the plugin to zero on every image bump.
    expect(patch).toContain('RollingUpdate');
    // maxUnavailable MUST be 1. Only the leader is ever Ready (the readiness
    // probe is a TCP check on :9090, which the plugin opens only after winning
    // the leader lease), so `maxUnavailable: 0` deadlocks the rollout: the old
    // leader is never removed because no new pod can become Ready while it
    // holds the lease. Observed on staging v2026.9.18-rc.2.
    // Anchored to a real YAML line: the comment above it deliberately mentions
    // `maxUnavailable: 0` to explain why that value is wrong, and a bare
    // substring check would match the explanation instead of the setting.
    expect(patch).toMatch(/^\s+maxUnavailable: 1$/m);
    expect(patch).not.toMatch(/^\s+maxUnavailable: 0$/m);

    // Deliberately NO PodDisruptionBudget. Readiness here reflects LEADERSHIP,
    // not health — exactly one pod is ever Ready — so every non-trivial PDB
    // computes `disruptionsAllowed: 0` and blocks node drains forever. Both
    // `minAvailable: 1` and `maxUnavailable: 1` were measured on a live
    // cluster and both reported 0. topologySpread (asserted above) is what
    // actually stops one drain taking both replicas.
    expect(existsSync(resolve(cnpgDir, 'barman-cloud-pdb.yaml'))).toBe(false);

    const kustomization = readFileSync(resolve(cnpgDir, 'kustomization.yaml'), 'utf8');
    expect(kustomization).not.toContain('barman-cloud-pdb.yaml');
    expect(kustomization).toContain('patch-barman-cloud-ha.yaml');
  });
});
