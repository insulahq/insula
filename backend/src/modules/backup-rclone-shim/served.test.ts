import { describe, expect, it } from 'vitest';
import { daemonSetServes } from './served.js';

// A binding change reaches the database first and the shim pods only once the
// reconciler has stamped its input hash on the template and the pods rolled.
// Until both, the shim still serves the previous target.
describe('does the shim serve the current bindings', () => {
  const ds = (over: {
    hash?: string; generation?: number; observed?: number; desired?: number; updated?: number; available?: number;
  } = {}) => ({
    metadata: { generation: over.generation ?? 7 },
    spec: { template: { metadata: { annotations: { 'insula.host/input-hash': over.hash ?? 'h-now' } } } },
    status: {
      observedGeneration: over.observed ?? 7,
      desiredNumberScheduled: over.desired ?? 3,
      updatedNumberScheduled: over.updated ?? 3,
      numberAvailable: over.available ?? 3,
    },
  });

  it('settled: the current hash, observed, every pod updated and available', () => {
    expect(daemonSetServes(ds(), 'h-now')).toBe(true);
  });

  it('not yet: the reconciler has not stamped the current inputs', () => {
    expect(daemonSetServes(ds({ hash: 'h-before' }), 'h-now')).toBe(false);
  });

  it('not yet: the controller has not seen the new template, or pods are still rolling', () => {
    expect(daemonSetServes(ds({ observed: 6 }), 'h-now')).toBe(false);
    expect(daemonSetServes(ds({ updated: 2 }), 'h-now')).toBe(false);
    expect(daemonSetServes(ds({ available: 2 }), 'h-now')).toBe(false);
  });

  it('no annotation at all is not the current hash', () => {
    expect(daemonSetServes({ status: {} }, 'h-now')).toBe(false);
  });
});
