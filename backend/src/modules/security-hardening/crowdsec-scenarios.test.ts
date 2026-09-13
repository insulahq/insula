import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SIMULATED_SCENARIOS,
  parseSimulationYaml,
  renderSimulationYaml,
} from './crowdsec-scenarios.js';
import { deriveAddedBy } from './crowdsec.js';

/**
 * The `addedBy` taxonomy is the whole point of the relabel: CrowdSec's raw
 * `origin` says `cscli` for three different platform actions and `crowdsec` for
 * the platform's OWN agent. Every row below is a real scenario string observed
 * on production 2026-09-13.
 */
describe('deriveAddedBy', () => {
  it('separates the two automatic engines, which both used to read as one thing', () => {
    expect(deriveAddedBy(
      'cscli',
      'admin-panel:autoban-scheduler:auto-ban:rules 920250,920540 count 20',
    )).toBe('auto-ban-waf');
    expect(deriveAddedBy('crowdsec', 'crowdsecurity/http-probing')).toBe('auto-ban-traffic');
  });

  it('does not read an automatic ban as a human action', () => {
    // The scheduler bans through the same helper an operator does, so its
    // scenario ALSO starts with "admin-panel:". Prefix order is load-bearing.
    const auto = deriveAddedBy('cscli', 'admin-panel:autoban-scheduler:auto-ban:rules 1 count 2');
    expect(auto).not.toBe('operator');
  });

  it('distinguishes operator, static list and community', () => {
    expect(deriveAddedBy('cscli', 'admin-panel:manual ban by admin')).toBe('operator');
    expect(deriveAddedBy('cscli', 'admin-panel-static:blocklist entry')).toBe('static-list');
    expect(deriveAddedBy('CAPI', 'crowdsecurity/http-scan')).toBe('community');
  });

  it('calls anything else external rather than guessing', () => {
    expect(deriveAddedBy('lists', 'firehol/blocklist')).toBe('external');
    expect(deriveAddedBy('console', 'some/thing')).toBe('external');
    // cscli WITHOUT a platform prefix was added on the host, not in this panel.
    expect(deriveAddedBy('cscli', 'manual ban')).toBe('external');
  });
});

/**
 * simulation.yaml is the durable form of the toggle. A round-trip bug here is
 * invisible: the file would look right and the agent would enforce a scenario
 * the panel shows as simulated.
 */
describe('simulation.yaml round-trip', () => {
  it('round-trips a list', () => {
    const names = ['crowdsecurity/http-crawl-non_statics', 'crowdsecurity/http-probing'];
    const parsed = parseSimulationYaml(renderSimulationYaml(names));
    expect(parsed.simulated).toEqual(names);
    expect(parsed.global).toBe(false);
  });

  it('round-trips an EMPTY list — every scenario enforcing', () => {
    // `exclusions: []` must parse back to zero names, not to "the key is
    // missing so keep the default". Turning the last scenario off is exactly
    // when a fallback-to-default bug would be most surprising.
    const parsed = parseSimulationYaml(renderSimulationYaml([]));
    expect(parsed.simulated).toEqual([]);
  });

  it('sorts and de-duplicates so the file does not churn', () => {
    const out = renderSimulationYaml(['b/two', 'a/one', 'b/two']);
    expect(out).toContain('  - a/one\n  - b/two\n');
    expect(out.match(/b\/two/g)).toHaveLength(1);
  });

  it('keeps the global switch off — exclusions are INVERTED when it is on', () => {
    expect(renderSimulationYaml([])).toContain('simulation: false');
  });

  it('reads the global switch when an operator has set it by hand', () => {
    expect(parseSimulationYaml('simulation: true\nexclusions:\n  - a/b\n').global).toBe(true);
  });

  it('ignores comments, including a commented-out scenario', () => {
    const text = [
      '# simulation: true',
      'simulation: false',
      'exclusions:',
      '  # - crowdsecurity/disabled-one',
      '  - crowdsecurity/http-crawl-non_statics',
    ].join('\n');
    const parsed = parseSimulationYaml(text);
    expect(parsed.global).toBe(false);
    expect(parsed.simulated).toEqual(['crowdsecurity/http-crawl-non_statics']);
  });

  it('survives a hand-mangled file instead of throwing', () => {
    // The parser is deliberately a scanner: a page that 500s because someone
    // hand-edited a ConfigMap is worse than one that reports fewer names.
    expect(() => parseSimulationYaml('not: yaml: at: all\n\t- [')).not.toThrow();
    expect(parseSimulationYaml('').simulated).toEqual([]);
  });

  it('parses the exact file the platform ships by default', () => {
    const parsed = parseSimulationYaml(renderSimulationYaml(DEFAULT_SIMULATED_SCENARIOS));
    expect(parsed.simulated).toEqual(['crowdsecurity/http-crawl-non_statics']);
  });

  it('keeps the UNDERSCORE in http-crawl-non_statics', () => {
    // cscli accepts a nonexistent scenario name silently and echoes it back, so
    // the hyphen spelling produced a config that looked correct while the real
    // scenario kept banning. Shipped on DEV 2026-09-05.
    expect(DEFAULT_SIMULATED_SCENARIOS).toContain('crowdsecurity/http-crawl-non_statics');
    expect(DEFAULT_SIMULATED_SCENARIOS.join()).not.toContain('non-statics');
  });
});
