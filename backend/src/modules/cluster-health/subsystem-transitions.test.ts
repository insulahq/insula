/**
 * Per-node Calico / Longhorn CSI transitions. A joining node has no Calico or
 * CSI pod yet and used to be reported "Calico is missing" the moment it
 * registered; it is now held for its join grace window.
 */
import { describe, it, expect } from 'vitest';
import { computeSubsystemTransitions, type SubsystemState } from './subsystem-transitions.js';
import type { NodeSubsystemReport } from './service.js';

const healthy = (nodeName: string): NodeSubsystemReport => ({
  nodeName, calico: 'healthy', longhornCsi: 'healthy', csiDriverRegistered: true,
});
const missing = (nodeName: string): NodeSubsystemReport => ({
  nodeName,
  calico: 'missing',
  calicoMessage: 'No calico-node pod scheduled on this node',
  longhornCsi: 'missing',
  csiDriverRegistered: false,
});
const joining = new Map([['worker-new', { until: new Date(), reason: 'new-node' }]]);
const none = new Map<string, unknown>();
const empty: ReadonlyMap<string, SubsystemState> = new Map();

describe('computeSubsystemTransitions', () => {
  it('reports nothing for a joining node and remembers nothing about it', () => {
    const r = computeSubsystemTransitions([missing('worker-new')], empty, joining);
    expect(r.transitions).toEqual([]);
    expect(r.suppressed).toEqual(['worker-new']);
    expect(r.nextState.has('worker-new')).toBe(false);
  });

  it('reports a node still degraded when its window closes, exactly once', () => {
    const during = computeSubsystemTransitions([missing('worker-new')], empty, joining);
    const after = computeSubsystemTransitions([missing('worker-new')], during.nextState, none);
    expect(after.transitions.map((t) => t.severity)).toEqual(['error', 'error']);
    expect(after.transitions[0].reason).toContain("Calico is missing on 'worker-new'");
    expect(computeSubsystemTransitions([missing('worker-new')], after.nextState, none).transitions).toEqual([]);
  });

  it('stays silent for a node that came up healthy inside its window', () => {
    const during = computeSubsystemTransitions([missing('worker-new')], empty, joining);
    expect(computeSubsystemTransitions([healthy('worker-new')], during.nextState, none).transitions).toEqual([]);
  });

  it('forgets a healthy state remembered for a name that re-registers, so the window ends in a fresh sighting', () => {
    const before = computeSubsystemTransitions([healthy('worker-new')], empty, none);
    const during = computeSubsystemTransitions([missing('worker-new')], before.nextState, joining);
    expect(during.transitions).toEqual([]);
    expect(during.nextState.has('worker-new')).toBe(false);
    const after = computeSubsystemTransitions([missing('worker-new')], during.nextState, none);
    expect(after.transitions[0].reason).toContain("Calico is missing on 'worker-new'");
  });

  it('keeps the established rules for every other node', () => {
    const first = computeSubsystemTransitions([healthy('w1')], empty, joining);
    expect(first.transitions).toEqual([]);
    const regressed = computeSubsystemTransitions([missing('w1')], first.nextState, joining);
    expect(regressed.transitions.map((t) => t.reason)).toEqual([
      "Calico regressed on 'w1' — No calico-node pod scheduled on this node",
      "Longhorn CSI regressed on 'w1' — missing",
    ]);
    const recovered = computeSubsystemTransitions([healthy('w1')], regressed.nextState, none);
    expect(recovered.transitions.map((t) => t.severity)).toEqual(['success', 'success']);
  });

  it('does not mutate the state it was given', () => {
    const prev = new Map([['w1', { calicoHealthy: true, longhornCsiHealthy: true }]]);
    computeSubsystemTransitions([missing('w1')], prev, none);
    expect(prev.get('w1')).toEqual({ calicoHealthy: true, longhornCsiHealthy: true });
  });
});

describe('computeSubsystemTransitions — an already-announced problem', () => {
  it('keeps the normal rules so the recovery is still reported', () => {
    const degraded = new Map([['w1', { calicoHealthy: false, longhornCsiHealthy: true }]]);
    const peerGrace = new Map([['w1', { until: new Date(), reason: 'pending-peer' }]]);
    const r = computeSubsystemTransitions([healthy('w1')], degraded, peerGrace);
    expect(r.suppressed).toEqual([]);
    expect(r.transitions.map((t) => t.reason)).toEqual(["Calico recovered on 'w1'"]);
  });
});
