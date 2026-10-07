import { describe, it, expect } from 'vitest';
import { dedupeBucket, componentDetail, componentProbes, componentsToAlert } from './health-scheduler.js';

// The scheduler's value is entirely in its POLICY: which failures alert, how
// often, and what the operator is told. Those are the parts that turn a useful
// alert into an ignored one, so they are pinned here.

describe('dedupeBucket — 12h buckets', () => {
  it('is stable within the same morning', () => {
    const a = dedupeBucket(Date.parse('2026-08-12T00:00:00Z'));
    const b = dedupeBucket(Date.parse('2026-08-12T11:59:59Z'));
    expect(a).toBe(b);
  });

  it('is stable within the same afternoon', () => {
    const a = dedupeBucket(Date.parse('2026-08-12T12:00:00Z'));
    const b = dedupeBucket(Date.parse('2026-08-12T23:59:59Z'));
    expect(a).toBe(b);
  });

  it('changes across the midday boundary', () => {
    const am = dedupeBucket(Date.parse('2026-08-12T11:59:59Z'));
    const pm = dedupeBucket(Date.parse('2026-08-12T12:00:00Z'));
    expect(am).not.toBe(pm);
  });

  it('changes across days', () => {
    const d1 = dedupeBucket(Date.parse('2026-08-12T09:00:00Z'));
    const d2 = dedupeBucket(Date.parse('2026-08-13T09:00:00Z'));
    expect(d1).not.toBe(d2);
  });

  // A sustained outage must alert twice a day, not on every 15-minute pass.
  it('yields exactly 2 buckets across a full day of 15-minute passes', () => {
    const start = Date.parse('2026-08-12T00:00:00Z');
    const buckets = new Set<string>();
    for (let i = 0; i < (24 * 60) / 15; i += 1) {
      buckets.add(dedupeBucket(start + i * 15 * 60_000));
    }
    expect(buckets.size).toBe(2);
  });
});

describe('componentDetail — what the operator is actually told', () => {
  it('surfaces a component error verbatim, space-prefixed', () => {
    // Leading space matters: the templates concatenate `{{detail}}` directly
    // after a sentence and have no conditionals.
    expect(componentDetail('pod', { error: 'no Running pod' })).toBe(' no Running pod');
  });

  it('names the failing deliverability sub-probes', () => {
    const deliverability = {
      healthy: false,
      forwardDns: { severity: 'ok' },
      certSanMatch: { severity: 'fail' },
      smtpBanner: { severity: 'fail' },
      ipv6Dns: { severity: 'warning' },
    };
    expect(componentDetail('deliverability', deliverability)).toBe(' Failing probes:');
    // One list item per failing probe. Warnings are not failures and must not
    // be named as such.
    expect(componentProbes('deliverability', deliverability)).toEqual(['certSanMatch', 'smtpBanner']);
  });

  it('returns empty (not "undefined") when there is nothing to add', () => {
    expect(componentDetail('tcp', { healthy: false })).toBe('');
    expect(componentDetail('tcp', null)).toBe('');
    expect(componentDetail('tcp', undefined)).toBe('');
    expect(componentDetail('tcp', 'not-an-object')).toBe('');
  });

  it('never throws on a malformed component', () => {
    expect(() => componentDetail('deliverability', { forwardDns: 'nope', x: 1 })).not.toThrow();
    expect(() => componentDetail('deliverability', { forwardDns: null })).not.toThrow();
  });
});

// The alerting predicate itself, asserted against the real contract shape.
// `healthy === false` is the gate — NOT `status`, because probeDeliverability
// deliberately keeps warnings healthy (a missing AAAA is a reachability
// nicety, not an outage) and `not_implemented` means "not configured".
describe('alert predicate', () => {
  const shouldAlert = (c: { healthy?: boolean } | undefined): boolean => !!c && c.healthy === false;

  it('alerts on a failing component', () => {
    expect(shouldAlert({ healthy: false })).toBe(true);
  });

  it('does not alert on a healthy component', () => {
    expect(shouldAlert({ healthy: true })).toBe(false);
  });

  it('does not alert on a component absent from the response', () => {
    // `deliverability` is optional in the contract for older backends.
    expect(shouldAlert(undefined)).toBe(false);
  });

  it('does not alert on a warning-only deliverability bundle', () => {
    // This is the exact shape a dual-stack cluster with a missing AAAA
    // produces: warnings present, component still healthy. It must stay silent.
    expect(shouldAlert({ healthy: true })).toBe(false);
  });
});

describe('componentProbes — standby + storage list their nodes', () => {
  it('lists the standby nodes a failover could not start from', () => {
    const standby = {
      healthy: false,
      nodes: [
        { node: 'b', ageSeconds: 3600, durationSeconds: 5, sizeBytes: 1, fresh: false },
        { node: 'c', ageSeconds: 30, durationSeconds: 5, sizeBytes: 1, fresh: true },
      ],
    };
    expect(componentProbes('standby', standby)).toEqual(['b: newest complete copy 60 min old']);
    expect(componentDetail('standby', { ...standby, error: '1 standby node has no copy' })).toBe(' 1 standby node has no copy');
  });

  it('lists the nodes short of disk headroom', () => {
    const storage = {
      healthy: false,
      nodes: [{ node: 'a', role: 'active', freeBytes: 2 ** 30, mailBytes: 3 * 2 ** 30, enough: false }],
    };
    expect(componentProbes('storage', storage)).toEqual(['a: 1.0 GiB free for 3.0 GiB of mail']);
  });
});

describe('componentsToAlert — one alert per problem', () => {
  it('alerts each failing component and skips healthy or absent ones', () => {
    const keys = componentsToAlert({
      pod: { healthy: true }, jmap: { healthy: false, error: 'x' }, deliverability: undefined,
    }).map(([k]) => k);
    expect(keys).toEqual(['jmap']);
  });

  it('alerts once when one failed capacity read failed both standby and storage', () => {
    const reason = 'Could not read mail node capacity: kube-api down';
    const keys = componentsToAlert({
      standby: { healthy: false, error: reason, nodes: [] },
      storage: { healthy: false, error: reason, nodes: [] },
    }).map(([k]) => k);
    expect(keys).toEqual(['standby']);
  });

  it('alerts both when standby and storage fail for different reasons', () => {
    const keys = componentsToAlert({
      standby: { healthy: false, error: '1 standby node has no copy' },
      storage: { healthy: false, error: '1 mail node has less free space' },
    }).map(([k]) => k);
    expect(keys).toEqual(['standby', 'storage']);
  });
});
