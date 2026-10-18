import { describe, it, expect } from 'vitest';
import { failoverTargetState, usableFailoverTargets, type FailoverNode } from './failover-targets.js';

const node = (name: string, o: { cordoned?: boolean; ready?: boolean } = {}): FailoverNode => ({
  metadata: { name },
  spec: { unschedulable: o.cordoned ?? false },
  status: { conditions: [{ type: 'Ready', status: o.ready === false ? 'False' : 'True' }] },
});

describe('mail failover targets', () => {
  it('a cordoned node is Ready but not a target', () => {
    expect(failoverTargetState(node('s2', { cordoned: true }))).toBe('cordoned');
    expect(failoverTargetState(node('s2', { ready: false }))).toBe('not-ready');
    expect(failoverTargetState(undefined)).toBe('missing');
    expect(failoverTargetState(node('s2'))).toBe('usable');
  });

  it('production: the only target cordoned → nothing usable, and says why', () => {
    expect(usableFailoverTargets(['s2', null], 's1', [node('s1'), node('s2', { cordoned: true }), node('s3')]))
      .toEqual({ usable: [], skipped: ['s2 (cordoned)'] });
  });

  it('keeps priority order and never offers the node mail runs on', () => {
    expect(usableFailoverTargets(['s1', 's3', 's2'], 's1', [node('s1'), node('s2'), node('s3', { ready: false })]))
      .toEqual({ usable: ['s2'], skipped: ['s3 (not Ready)'] });
  });
});
