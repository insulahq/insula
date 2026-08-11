import { describe, it, expect } from 'vitest';
import { stripHostnamePin } from './service.js';

/**
 * Regression (2026-08-10, multi-node VM run): a drain re-pinned workloads by
 * patching `nodeSelector` only, while buildDrainImpact counts a workload as
 * pinned via nodeSelector OR nodeAffinity. A nodeAffinity-pinned workload was
 * therefore never released: pods moved, volumes moved, tenants.node_name
 * cleared — and drain-impact still reported "Σ workloads=4 / pinnedTenants=3"
 * for an empty node, which is the counter the delete gate reads. The node
 * became permanently undeletable.
 *
 * The removal has to be SURGICAL. Anti-affinity, preferred terms and unrelated
 * required terms live under the same key, so `affinity: null` would quietly
 * delete an operator's scheduling rules — turning a routine drain into a
 * scheduling change nobody asked for.
 */
describe('stripHostnamePin', () => {
  const NODE = 'worker-1';
  const pinTerm = { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [NODE] }] };

  it('removes the hostname pin and drops the now-empty term', () => {
    const r = stripHostnamePin(
      { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [pinTerm] } } },
      NODE,
    );
    expect(r.changed).toBe(true);
    expect(r.affinity).toBeNull();
  });

  it('leaves a pin to a DIFFERENT node alone', () => {
    const other = { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [
      { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: ['worker-2'] }] },
    ] } } };
    const r = stripHostnamePin(other, NODE);
    expect(r.changed).toBe(false);
    expect(r.affinity).toEqual(other);
  });

  it('KEEPS unrelated required expressions in the same term', () => {
    const r = stripHostnamePin(
      { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{
        matchExpressions: [
          { key: 'kubernetes.io/hostname', operator: 'In', values: [NODE] },
          { key: 'insula.host/host-tenant-workloads', operator: 'In', values: ['true'] },
        ],
      }] } } },
      NODE,
    );
    expect(r.changed).toBe(true);
    const terms = r.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
    expect(terms).toHaveLength(1);
    expect(terms?.[0].matchExpressions).toEqual([
      { key: 'insula.host/host-tenant-workloads', operator: 'In', values: ['true'] },
    ]);
  });

  it('KEEPS podAntiAffinity and preferred terms — a drain is not a scheduling change', () => {
    const r = stripHostnamePin(
      {
        podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{ topologyKey: 'kubernetes.io/hostname' }] },
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [pinTerm] },
          preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 1, preference: {} }],
        },
      },
      NODE,
    );
    expect(r.changed).toBe(true);
    expect(r.affinity?.podAntiAffinity).toBeDefined();
    expect(r.affinity?.nodeAffinity?.preferredDuringSchedulingIgnoredDuringExecution).toBeDefined();
    expect(r.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution).toBeUndefined();
  });

  it('keeps a term that still has matchFields, without an empty matchExpressions', () => {
    const r = stripHostnamePin(
      { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{
        matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [NODE] }],
        matchFields: [{ key: 'metadata.name', operator: 'In', values: [NODE] }],
      }] } } },
      NODE,
    );
    expect(r.changed).toBe(true);
    const terms = r.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
    expect(terms).toHaveLength(1);
    expect(terms?.[0].matchExpressions).toBeUndefined();
    expect(terms?.[0].matchFields).toHaveLength(1);
  });

  it('is a no-op on undefined / plain affinity', () => {
    expect(stripHostnamePin(undefined, NODE)).toEqual({ changed: false, affinity: null });
    const plain = { podAffinity: {} };
    expect(stripHostnamePin(plain, NODE)).toEqual({ changed: false, affinity: plain });
  });

  it('does not match a multi-value In — that is not a pin to ONE node', () => {
    const multi = { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [
      { matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [NODE, 'worker-2'] }] },
    ] } } };
    expect(stripHostnamePin(multi, NODE).changed).toBe(false);
  });
});
