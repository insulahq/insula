import { describe, it, expect } from 'vitest';
import type { CrowdsecDecision } from '@insula/api-contracts';
import {
  addedByMeta,
  compareAddresses,
  compareGroups,
  describeDecision,
  groupDecisions,
  parseWafAutoBanScenario,
  scenarioDescriptionMap,
} from './ban-presentation';

const decision = (over: Partial<CrowdsecDecision> = {}): CrowdsecDecision => ({
  id: 1,
  origin: 'crowdsec',
  type: 'ban',
  scope: 'Ip',
  value: '203.0.113.10',
  scenario: 'crowdsecurity/http-probing',
  duration: '1h',
  expiresAt: '2026-09-13T18:00:00.000Z',
  manualByOperator: false,
  staticByOperator: false,
  autoBanned: false,
  simulated: false,
  addedBy: 'auto-ban-traffic',
  ...over,
});

describe('addedByMeta', () => {
  it('labels both automatic engines distinctly and marks them automatic', () => {
    // The old table gave the "auto-ban" pill only to the WAF engine, so the
    // agent's bans looked like they had no provenance at all.
    expect(addedByMeta('auto-ban-waf').automatic).toBe(true);
    expect(addedByMeta('auto-ban-traffic').automatic).toBe(true);
    expect(addedByMeta('auto-ban-waf').label).not.toBe(addedByMeta('auto-ban-traffic').label);
  });

  it('never shows a CrowdSec internal name to an operator', () => {
    const labels = (['operator', 'static-list', 'auto-ban-waf', 'auto-ban-traffic', 'community', 'external'] as const)
      .map((a) => addedByMeta(a).label.toLowerCase());
    for (const label of labels) {
      expect(label).not.toContain('cscli');
      expect(label).not.toContain('capi');
    }
    // "crowdsec" as a bare origin was the specific complaint.
    expect(labels).not.toContain('crowdsec');
  });

  it('carries a dark: variant on every pill', () => {
    for (const a of ['operator', 'static-list', 'auto-ban-waf', 'auto-ban-traffic', 'community', 'external'] as const) {
      expect(addedByMeta(a).cls).toMatch(/dark:/);
    }
  });
});

describe('parseWafAutoBanScenario', () => {
  it('extracts the rules and the hit count from a real scheduler scenario', () => {
    const ev = parseWafAutoBanScenario(
      'admin-panel:autoban-scheduler:auto-ban:rules 920250,920540,932140,942550 count 20',
    );
    expect(ev?.ruleIds).toEqual(['920250', '920540', '932140', '942550']);
    expect(ev?.eventCount).toBe(20);
  });

  it('returns null for anything that is not a scheduler ban', () => {
    expect(parseWafAutoBanScenario('crowdsecurity/http-probing')).toBeNull();
    expect(parseWafAutoBanScenario('admin-panel:manual ban')).toBeNull();
  });
});

describe('describeDecision', () => {
  const descriptions = scenarioDescriptionMap([
    {
      name: 'crowdsecurity/http-sensitive-files',
      description: 'Detect attempt to access to sensitive files (.log, .db ..) or folders (.git)',
      status: 'enabled', simulated: false, eventsPoured: 0, alertsRaised: 0,
    },
  ]);

  it('replaces a raw scenario name with the hub description', () => {
    const text = describeDecision(
      decision({ scenario: 'crowdsecurity/http-sensitive-files' }),
      descriptions,
    );
    expect(text).toContain('sensitive files');
    expect(text).not.toBe('crowdsecurity/http-sensitive-files');
  });

  it('falls back to the raw name rather than inventing an explanation', () => {
    // A wrong reason for a block is worse than no reason.
    expect(describeDecision(decision({ scenario: 'crowdsecurity/unknown-one' }), descriptions))
      .toBe('crowdsecurity/unknown-one');
  });

  it('turns a WAF auto-ban into rules + hit count', () => {
    const text = describeDecision(decision({
      addedBy: 'auto-ban-waf',
      scenario: 'admin-panel:autoban-scheduler:auto-ban:rules 920250,920540 count 20',
    }), descriptions);
    expect(text).toContain('2 WAF rules');
    expect(text).toContain('20 blocked requests');
  });

  it('singularises a one-rule, one-request ban', () => {
    const text = describeDecision(decision({
      addedBy: 'auto-ban-waf',
      scenario: 'admin-panel:autoban-scheduler:auto-ban:rules 920250 count 1',
    }), descriptions);
    expect(text).toContain('WAF rule 920250');
    expect(text).toContain('1 blocked request');
    expect(text).not.toContain('requests');
  });

  it('shows the operator’s own words for a manual ban', () => {
    expect(describeDecision(
      decision({ addedBy: 'operator', scenario: 'admin-panel:persistent scanner from OVH' }),
      descriptions,
    )).toBe('persistent scanner from OVH');
  });

  it('never renders an empty reason', () => {
    expect(describeDecision(decision({ scenario: '' }), new Map())).toBe('No reason recorded');
    expect(describeDecision(decision({ addedBy: 'operator', scenario: 'admin-panel:' }), new Map()))
      .toBe('Added by an operator');
  });
});

describe('groupDecisions', () => {
  it('collapses the per-scenario fan-out into one row per address', () => {
    // Production 2026-09-13: 192.236.217.91 held seven decisions.
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((sc, i) => decision({
      id: i, value: '192.236.217.91', scenario: `crowdsecurity/${sc}`,
    }));
    const groups = groupDecisions(many);
    expect(groups).toHaveLength(1);
    expect(groups[0].decisions).toHaveLength(7);
  });

  it('reports the LATEST expiry — when the address is actually free', () => {
    // Taking the earliest would say the ban had lapsed while other decisions
    // still held the address blocked.
    const groups = groupDecisions([
      decision({ id: 1, expiresAt: '2026-09-13T18:00:00.000Z' }),
      decision({ id: 2, expiresAt: '2026-09-14T06:00:00.000Z', scenario: 'x/y' }),
    ]);
    expect(groups[0].expiresAt).toBe('2026-09-14T06:00:00.000Z');
  });

  it('keeps different scopes apart even when the value matches', () => {
    const groups = groupDecisions([
      decision({ id: 1, scope: 'Ip', value: '203.0.113.10' }),
      decision({ id: 2, scope: 'Range', value: '203.0.113.10' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('lists each distinct engine once', () => {
    const groups = groupDecisions([
      decision({ id: 1, addedBy: 'auto-ban-traffic', scenario: 'a/b' }),
      decision({ id: 2, addedBy: 'auto-ban-traffic', scenario: 'c/d' }),
      decision({ id: 3, addedBy: 'operator', scenario: 'admin-panel:x' }),
    ]);
    expect([...groups[0].addedBy].sort()).toEqual(['auto-ban-traffic', 'operator']);
  });

  it('flags a group where NOTHING is actually enforced', () => {
    // A simulated scenario raises alerts and issues no ban. An operator
    // reading "banned" for an address that is not blocked is the worst
    // possible thing this table can say.
    const simulated = groupDecisions([decision({ simulated: true })]);
    expect(simulated[0].allSimulated).toBe(true);
    const mixed = groupDecisions([
      decision({ id: 1, simulated: true }),
      decision({ id: 2, simulated: false, scenario: 'x/y' }),
    ]);
    expect(mixed[0].allSimulated).toBe(false);
  });
});

describe('sorting', () => {
  it('orders IPv4 numerically, not lexically', () => {
    // A plain string sort puts 10.0.0.1 before 9.9.9.9 and the column looks
    // broken to anyone scanning for an address.
    expect(compareAddresses('9.9.9.9', '10.0.0.1')).toBeLessThan(0);
    expect(['10.0.0.1', '9.9.9.9', '192.168.0.1'].sort(compareAddresses))
      .toEqual(['9.9.9.9', '10.0.0.1', '192.168.0.1']);
  });

  it('falls back to lexical order for IPv6 and CIDRs without throwing', () => {
    expect(() => ['2602:80d::1', '203.0.113.0/24', 'US'].sort(compareAddresses)).not.toThrow();
  });

  it('sorts groups with no expiry LAST, not first', () => {
    // A static ban is the longest-lived row in the table, not the shortest.
    const withExpiry = groupDecisions([decision({ id: 1, value: '1.1.1.1' })])[0];
    const noExpiry = groupDecisions([
      decision({ id: 2, value: '2.2.2.2', expiresAt: null }),
    ])[0];
    expect(compareGroups(noExpiry, withExpiry, 'expiresAt', new Map())).toBeGreaterThan(0);
    expect(compareGroups(withExpiry, noExpiry, 'expiresAt', new Map())).toBeLessThan(0);
  });

  it('sorts by decision count', () => {
    const one = groupDecisions([decision({ id: 1, value: '1.1.1.1' })])[0];
    const two = groupDecisions([
      decision({ id: 2, value: '2.2.2.2' }),
      decision({ id: 3, value: '2.2.2.2', scenario: 'x/y' }),
    ])[0];
    expect(compareGroups(one, two, 'count', new Map())).toBeLessThan(0);
  });
});
