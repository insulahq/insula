import { describe, it, expect } from 'vitest';
import {
  dedupeBucket, componentDetail, componentImpact, componentProbes, componentsToAlert, confirmedFailures, failingChecks, unansweredLookups,
} from './health-scheduler.js';

describe('componentImpact — what the failure means for mail', () => {
  it('the standby copy and the disk headroom do not stop delivery; the rest likely does', () => {
    expect(componentImpact('standby')).toBe('Mail delivery is not affected.');
    expect(componentImpact('storage')).toMatch(/^Mail delivery is not affected yet; a full disk would stop the mail server/);
    for (const k of ['pod', 'jmap', 'rocksdb', 'cert', 'tcp', 'deliverability', 'exposure', 'something-new']) {
      expect(componentImpact(k)).toBe('Mail delivery is likely affected.');
    }
  });
});

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

  // The shape probeDeliverability really returns: an `error` line of its own,
  // single probes, and — for reverse DNS and the blocklists — a LIST per address.
  // The first version of this test left `error` and the lists out, and so never
  // saw that production alerts said "1 deliverability failure — open Details to
  // inspect" and named nothing.
  const deliverability = (over: Record<string, unknown> = {}) => ({
    healthy: false,
    error: '1 deliverability failure — open Details to inspect',
    status: 'ok',
    hostname: 'mail.example.test',
    expectedMailIps: ['198.51.100.10', '198.51.100.11'],
    forwardDns: { severity: 'ok', actual: '198.51.100.10, 198.51.100.11' },
    ipv6Dns: { severity: 'warning', actual: '(no AAAA)' },
    reverseDns: [
      { severity: 'ok', ip: '198.51.100.10', node: 'node-a', actual: 'mail.example.test' },
      { severity: 'ok', ip: '198.51.100.11', node: 'node-b', actual: 'mail.example.test' },
    ],
    blocklists: [
      { severity: 'ok', ip: '198.51.100.10', node: 'node-a', list: 'Spamhaus ZEN', actual: 'not listed' },
      { severity: 'skipped', ip: '198.51.100.11', node: 'node-b', list: 'Spamhaus ZEN', actual: 'lookup refused (open_resolver)' },
    ],
    certSanMatch: { severity: 'ok', actual: 'SAN: mail.example.test' },
    smtpBanner: { severity: 'ok', actual: 'banner=mail.example.test' },
    summary: { ok: 6, warning: 1, fail: 1, advisory: 0, skipped: 1 },
    ...over,
  });

  it('names a failing reverse-DNS check WITH its address and what was found', () => {
    const d = deliverability({
      reverseDns: [
        { severity: 'ok', ip: '198.51.100.10', node: 'node-a', actual: 'mail.example.test' },
        { severity: 'fail', ip: '198.51.100.11', node: 'node-b', actual: 'static-198-51-100-11.isp.example.net' },
      ],
    });
    expect(componentProbes('deliverability', d)).toEqual([
      'reverse DNS for 198.51.100.11 (node-b): static-198-51-100-11.isp.example.net',
    ]);
    expect(componentDetail('deliverability', d)).toBe(' 1 failing check:');
  });

  it('names a blocklist listing by address and list, with the reason the list gives', () => {
    const d = deliverability({
      blocklists: [
        { severity: 'fail', ip: '198.51.100.10', node: 'node-a', list: 'SpamCop', listed: true, reasonTxt: 'Blocked - see https://www.spamcop.net/bl.shtml?198.51.100.10', actual: 'listed' },
        { severity: 'warning', ip: '198.51.100.10', node: 'node-a', list: 'PSBL', listed: true, actual: 'listed' },
        { severity: 'fail', ip: '198.51.100.11', node: null, list: 'Barracuda', listed: true, reasonTxt: null, actual: 'listed' },
      ],
    });
    expect(componentProbes('deliverability', d)).toEqual([
      '198.51.100.10 (node-a) is listed on SpamCop: Blocked - see https://www.spamcop.net/bl.shtml?198.51.100.10',
      '198.51.100.11 is listed on Barracuda',
    ]);
  });

  it('names the single checks by what they are, not by their key', () => {
    const d = deliverability({
      forwardDns: { severity: 'fail', actual: '198.51.100.10' },
      certSanMatch: { severity: 'fail', actual: 'SAN: localhost' },
      smtpBanner: { severity: 'fail', actual: 'banner=localhost, ehlo=localhost' },
    });
    expect(componentProbes('deliverability', d)).toEqual([
      'forward DNS: 198.51.100.10',
      'TLS certificate name: SAN: localhost',
      'SMTP banner: banner=localhost, ehlo=localhost',
    ]);
    expect(componentDetail('deliverability', d)).toBe(' 3 failing checks:');
  });

  it('never names a warning, an advisory or a skipped check as failing', () => {
    expect(componentProbes('deliverability', deliverability())).toEqual([]);
    // Nothing to list: the component's own line is all there is to say.
    expect(componentDetail('deliverability', deliverability())).toBe(' 1 deliverability failure — open Details to inspect');
  });

  it('counts the checks it was GIVEN — the ones a second pass confirmed, not all that failed', () => {
    const d = deliverability({ certSanMatch: { severity: 'fail', actual: 'SAN: localhost' }, smtpBanner: { severity: 'fail', actual: 'x' } });
    expect(componentDetail('deliverability', d, ['TLS certificate name: SAN: localhost'])).toBe(' 1 failing check:');
  });

  it('names a check it has never heard of by its key, and keeps a long finding to one line', () => {
    const d = deliverability({ dkimSelector: { severity: 'fail', actual: `no\n  record ${'x'.repeat(400)}` } });
    const [line] = componentProbes('deliverability', d);
    expect(line).toMatch(/^dkimSelector: no record x+$/);
    expect(line!.length).toBeLessThanOrEqual(240);
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

describe('confirmedFailures — a failure has to be seen twice', () => {
  const ptr = (ip: string, severity = 'fail') => ({ severity, ip, node: null, actual: '(no records)' });
  const deliverability = (reverseDns: unknown[], healthy = false) => ({ healthy, error: 'n failures', reverseDns });

  it('drops a component that failed once and is fine on the second look', () => {
    expect(confirmedFailures(
      { pod: { healthy: false, error: 'Pod probe failed: fetch failed' } },
      { pod: { healthy: true } },
    )).toEqual([]);
  });

  it('keeps a component failing both times, with the second look\'s wording', () => {
    const second = { healthy: false, error: 'no Running pod' };
    expect(confirmedFailures({ pod: { healthy: false, error: 'Pod probe failed: fetch failed' } }, { pod: second }))
      .toEqual([{ key: 'pod', component: second, items: [] }]);
  });

  it('does not alert a component that only fails on the second look — it has not been seen twice', () => {
    expect(confirmedFailures({ pod: { healthy: true } }, { pod: { healthy: false, error: 'x' } })).toEqual([]);
    expect(confirmedFailures({}, { pod: { healthy: false, error: 'x' } })).toEqual([]);
  });

  it('for deliverability the SAME check must fail twice: two different blips are not one fault', () => {
    const first = { deliverability: deliverability([ptr('198.51.100.10'), ptr('198.51.100.11', 'ok')]) };
    const second = { deliverability: deliverability([ptr('198.51.100.10', 'ok'), ptr('198.51.100.11')]) };
    expect(confirmedFailures(first, second)).toEqual([]);
  });

  it('lists only the checks that failed in both passes', () => {
    const first = { deliverability: deliverability([ptr('198.51.100.10'), ptr('198.51.100.11')]) };
    const second = { deliverability: deliverability([ptr('198.51.100.10', 'ok'), ptr('198.51.100.11')]) };
    const [f] = confirmedFailures(first, second);
    expect(f?.key).toBe('deliverability');
    expect(f?.items).toEqual(['reverse DNS for 198.51.100.11: (no records)']);
  });

  it('recognises the same fault when DNS hands its answer back in another order (a resolver may rotate records)', () => {
    // A persistent wrong PTR and a persistent missing A record. Compared by
    // their wording, these two passes share no line and the fault is dropped.
    const pass = (ptrs: string, addrs: string, reason: string) => ({
      deliverability: {
        healthy: false,
        error: '3 failures',
        forwardDns: { severity: 'fail', actual: addrs },
        reverseDns: [{ severity: 'fail', ip: '198.51.100.11', node: 'node-b', actual: ptrs }],
        blocklists: [{ severity: 'fail', ip: '198.51.100.11', node: 'node-b', list: 'SpamCop', reasonTxt: reason }],
      },
    });
    const [f] = confirmedFailures(
      pass('a.isp.example.net, b.isp.example.net', '198.51.100.10, 198.51.100.12', 'Blocked - see X'),
      pass('b.isp.example.net, a.isp.example.net', '198.51.100.12, 198.51.100.10', 'Blocked - see Y'),
    );
    // All three confirmed, in the SECOND look's words.
    expect(f?.items).toEqual([
      'forward DNS: 198.51.100.12, 198.51.100.10',
      'reverse DNS for 198.51.100.11 (node-b): b.isp.example.net, a.isp.example.net',
      '198.51.100.11 (node-b) is listed on SpamCop: Blocked - see Y',
    ]);
  });

  it('tells apart two addresses, and two blocklists for one address', () => {
    const ids = failingChecks({
      reverseDns: [{ severity: 'fail', ip: '198.51.100.10' }, { severity: 'fail', ip: '198.51.100.11' }],
      blocklists: [
        { severity: 'fail', ip: '198.51.100.10', list: 'SpamCop' },
        { severity: 'fail', ip: '198.51.100.10', list: 'Barracuda' },
      ],
      certSanMatch: { severity: 'fail', actual: 'SAN: localhost' },
    }).map((c) => c.id);
    expect(new Set(ids).size).toBe(5);
    // A listing on one list does not confirm a listing on another.
    const first = { deliverability: { healthy: false, blocklists: [{ severity: 'fail', ip: '198.51.100.10', list: 'SpamCop' }] } };
    const second = { deliverability: { healthy: false, blocklists: [{ severity: 'fail', ip: '198.51.100.10', list: 'Barracuda' }] } };
    expect(confirmedFailures(first, second)).toEqual([]);
  });

  it('still confirms a deliverability failure neither pass could itemise', () => {
    const bare = { healthy: false, error: 'Deliverability probes exceeded the wall timeout' };
    expect(confirmedFailures({ deliverability: bare }, { deliverability: bare })).toEqual([
      { key: 'deliverability', component: bare, items: [] },
    ]);
  });

  it('applies the one-alert-per-problem rule to what is confirmed', () => {
    const reason = 'Could not read mail node capacity: kube-api down';
    const both = { standby: { healthy: false, error: reason, nodes: [] }, storage: { healthy: false, error: reason, nodes: [] } };
    expect(confirmedFailures(both, both).map((f) => f.key)).toEqual(['standby']);
  });
});

describe('unansweredLookups', () => {
  it('names the deliverability lookups that got no answer, single and per address', () => {
    expect(unansweredLookups({
      deliverability: {
        healthy: true,
        forwardDns: { severity: 'skipped', actual: 'lookup got no answer: Forward DNS lookup for mail.example.test timed out' },
        reverseDns: [
          { severity: 'skipped', ip: '198.51.100.10', node: 'node-a', actual: 'lookup got no answer: queryPtr ETIMEOUT' },
          { severity: 'ok', ip: '198.51.100.11', actual: 'mail.example.test' },
        ],
        // Skipped for another reason: a policy refusal, not a lost lookup.
        blocklists: [{ severity: 'skipped', ip: '198.51.100.10', list: 'Spamhaus ZEN', actual: 'lookup refused (open_resolver)' }],
      },
    })).toEqual(['forward DNS', 'reverse DNS for 198.51.100.10 (node-a)']);
  });

  it('is empty for a clean or absent component, and never throws on a malformed one', () => {
    expect(unansweredLookups({})).toEqual([]);
    expect(unansweredLookups({ deliverability: null })).toEqual([]);
    expect(unansweredLookups({ deliverability: { reverseDns: [null, 'x', 3], forwardDns: 'nope' } })).toEqual([]);
  });
});
