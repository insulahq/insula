import { describe, it, expect } from 'vitest';
import {
  assessNode,
  reclaimableMillis,
  podRequestMillis,
  cpuToMillis,
  buildCpuReservationAlert,
  type NodeReservation,
  type PodReservation,
} from './cpu-reservation.js';

const node = (o: Partial<NodeReservation> = {}): NodeReservation => ({
  name: 'n1', allocatableMillis: 7500, requestedMillis: 7400, usedMillis: 1500, ...o,
});
const pod = (o: Partial<PodReservation> = {}): PodReservation => ({
  namespace: 'tenant-example', name: 'website-abc', requestedMillis: 100, usedMillis: 0, ...o,
});

describe('assessNode', () => {
  // The condition this finding exists for: reserved high, used low.
  it('fires when the node is reserved-full but running idle', () => {
    const v = assessNode(node({ requestedMillis: 7400, usedMillis: 1500 }));
    expect(v).toEqual({ severity: 'critical', reservedPct: 99, usedPct: 20 });
  });

  // ★ The case that must stay silent. A node that is reserved AND busy is
  // correctly provisioned; a finding here would be noise on exactly the
  // clusters that got it right, and noise is how a finding gets ignored.
  it('stays silent on a genuinely busy node', () => {
    expect(assessNode(node({ requestedMillis: 7400, usedMillis: 7100 }))).toBeNull();
  });

  it('stays silent below the reservation floor, however idle', () => {
    // 40% reserved, 1% used — a huge ratio, but nothing is being refused.
    expect(assessNode(node({ requestedMillis: 3000, usedMillis: 75 }))).toBeNull();
  });

  it('warns rather than criticals between 85% and 95% reserved', () => {
    const v = assessNode(node({ requestedMillis: 6800, usedMillis: 750 }));
    expect(v?.severity).toBe('warning');
  });

  // Unknown usage cannot establish a gap. Substituting 0 would manufacture
  // the strongest possible version of this finding out of a broken metrics
  // call — "98% reserved, 0% used" — and send an operator chasing nothing.
  it('returns null when usage is unknown rather than assuming zero', () => {
    expect(assessNode(node({ usedMillis: null }))).toBeNull();
  });

  it('survives a node reporting zero allocatable', () => {
    expect(assessNode(node({ allocatableMillis: 0 }))).toBeNull();
  });
});

describe('reclaimableMillis', () => {
  it('is the unused part of a reservation', () => {
    expect(reclaimableMillis(pod({ requestedMillis: 250, usedMillis: 1 }))).toBe(249);
  });

  // A pod over its request is bursting — the model working as designed, with
  // no CPU limit to stop it. That is not slack to reclaim.
  it('is zero for a pod bursting above its request, never negative', () => {
    expect(reclaimableMillis(pod({ requestedMillis: 100, usedMillis: 450 }))).toBe(0);
  });
});

describe('podRequestMillis', () => {
  it('sums the containers', () => {
    expect(podRequestMillis({
      containers: [{ resources: { requests: { cpu: '100m' } } }, { resources: { requests: { cpu: '150m' } } }],
    })).toBe(250);
  });

  // k8s charges max(sum(containers), max(initContainers)) for the pod's WHOLE
  // life. Summing containers alone under-reports exactly the shape that once
  // produced a byte-identical "not enough memory" error after an operator
  // shrank the smaller of the two numbers.
  it('charges the init container when it is the larger term', () => {
    expect(podRequestMillis({
      containers: [{ resources: { requests: { cpu: '100m' } } }],
      initContainers: [{ resources: { requests: { cpu: '400m' } } }],
    })).toBe(400);
  });

  it('charges the containers when they are the larger term', () => {
    expect(podRequestMillis({
      containers: [{ resources: { requests: { cpu: '500m' } } }],
      initContainers: [{ resources: { requests: { cpu: '32m' } } }],
    })).toBe(500);
  });
});

describe('cpuToMillis', () => {
  // Three spellings for one quantity; reading nanocores as cores overstates
  // usage by a factor of a billion.
  it.each([
    ['3500m', 3500], ['3.5', 3500], ['2', 2000],
    ['897123456n', 897.123456], ['500u', 0.5], [undefined, 0],
  ])('parses %s', (input, want) => {
    expect(cpuToMillis(input as string | undefined)).toBeCloseTo(want, 4);
  });
});

describe('fleet usage summing', () => {
  /**
   * Found in review, and it contradicted a convention this codebase already
   * had: `sumUsage` in dashboard/admin-service.ts returns null the moment any
   * node is unmeasured, with a comment saying why. The preview did the
   * opposite — folded an unmeasured node in as 0 — which UNDERSTATES fleet
   * usage, and understated usage widens the reserved-versus-used gap that is
   * the entire point of the report. The direction of the error flatters the
   * finding, which is the worst direction for it to go.
   *
   * The rule is asserted here against the same helper the preview uses.
   */
  it('a node with no metrics sample makes the fleet figure unknown, not smaller', () => {
    const nodes = [
      node({ name: 'a', usedMillis: 1500 }),
      node({ name: 'b', usedMillis: null }),
    ];
    const known = nodes.every((n) => n.usedMillis !== null);
    expect(known).toBe(false);
    // And the per-node assessment already refuses to judge the unmeasured one.
    expect(assessNode(nodes[1])).toBeNull();
  });

  it('sums only when every node reported', () => {
    const nodes = [node({ usedMillis: 1000 }), node({ usedMillis: 500 })];
    expect(nodes.every((n) => n.usedMillis !== null)).toBe(true);
    expect(nodes.reduce((s, n) => s + (n.usedMillis ?? 0), 0)).toBe(1500);
  });
});

describe('buildCpuReservationAlert', () => {
  it('returns null when no node shows the gap', () => {
    expect(buildCpuReservationAlert([node({ requestedMillis: 3000 })], [])).toBeNull();
  });

  it('states both numbers in the subtitle, because either alone is the misreading', () => {
    const a = buildCpuReservationAlert([node()], [pod({ requestedMillis: 250, usedMillis: 1 })]);
    expect(a).not.toBeNull();
    expect(a!.subtitle).toMatch(/99% reserved/);
    expect(a!.subtitle).toMatch(/20% actually in use/);
    // The schedulable remainder is the number that explains the refusals.
    expect(a!.subtitle).toMatch(/0\.10 of 7\.50 cores schedulable/);
  });

  it('names the biggest over-reservers and totals the slack', () => {
    const pods = [
      pod({ name: 'moodle', requestedMillis: 250, usedMillis: 1 }),
      pod({ name: 'site-a', requestedMillis: 100, usedMillis: 0 }),
      pod({ name: 'site-b', requestedMillis: 100, usedMillis: 0 }),
      pod({ name: 'busy', requestedMillis: 100, usedMillis: 400 }),
    ];
    const a = buildCpuReservationAlert([node()], pods)!;
    const rows = Object.fromEntries(a.detail!.map(([k, v]) => [k, v]));
    expect(rows['Reserved and unused']).toBe('0.45 cores across 3 pods');
    // The bursting pod contributes nothing and is not named.
    expect(JSON.stringify(a.detail)).not.toContain('busy');
    expect(JSON.stringify(a.detail)).toContain('moodle');
  });

  it('ignores rounding-level slack so the list stays worth reading', () => {
    const a = buildCpuReservationAlert([node()], [pod({ requestedMillis: 55, usedMillis: 40 })])!;
    expect(JSON.stringify(a.detail)).not.toContain('Reserved and unused');
  });

  it('picks the worst node when several qualify', () => {
    const a = buildCpuReservationAlert([
      node({ name: 'quiet', requestedMillis: 6500, usedMillis: 500 }),
      node({ name: 'worst', requestedMillis: 7450, usedMillis: 500 }),
    ], [])!;
    expect(a.subtitle).toMatch(/^worst /);
    expect(a.severity).toBe('critical');
  });
});
