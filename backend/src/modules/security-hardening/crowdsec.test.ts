import { describe, it, expect, vi, afterEach } from 'vitest';
import * as k8sModule from '../container-console/service.js';
import { ensureCommunityBlocklistDefault } from './crowdsec.js';

afterEach(() => { vi.restoreAllMocks(); });
import { __test } from './crowdsec.js';

const { parseLapiDecision, parseDurationToAbsolute, MANUAL_BAN_REASON_PREFIX, AUTO_BAN_SCENARIO_PREFIX } = __test;

describe('parseDurationToAbsolute', () => {
  it('returns null for empty / unparseable inputs', () => {
    expect(parseDurationToAbsolute('')).toBeNull();
    expect(parseDurationToAbsolute('soon')).toBeNull();
  });
  it('parses simple unit durations', () => {
    const before = Date.now();
    const result = parseDurationToAbsolute('5m');
    const after = Date.now();
    expect(result).not.toBeNull();
    const ts = new Date(result as string).getTime();
    expect(ts).toBeGreaterThanOrEqual(before + 5 * 60_000 - 50);
    expect(ts).toBeLessThanOrEqual(after + 5 * 60_000 + 50);
  });
  it('sums compound durations like CrowdSec emits', () => {
    const ts = new Date(parseDurationToAbsolute('1h30m12s') as string).getTime();
    const expected = Date.now() + (1 * 3_600_000 + 30 * 60_000 + 12 * 1000);
    expect(Math.abs(ts - expected)).toBeLessThan(100);
  });
  it('handles day units', () => {
    const ts = new Date(parseDurationToAbsolute('7d') as string).getTime();
    expect(Math.abs(ts - (Date.now() + 7 * 86_400_000))).toBeLessThan(100);
  });
});

describe('parseLapiDecision', () => {
  it('maps a valid LAPI decision to the contract shape', () => {
    const d = parseLapiDecision({
      id: 42,
      origin: 'crowdsecurity/http-bf',
      type: 'ban',
      scope: 'Ip',
      value: '1.2.3.4',
      scenario: 'crowdsecurity/http-bf',
      duration: '4h',
      simulated: false,
    });
    expect(d).not.toBeNull();
    expect(d!.id).toBe(42);
    expect(d!.scope).toBe('Ip');
    expect(d!.value).toBe('1.2.3.4');
    expect(d!.manualByOperator).toBe(false);
    expect(d!.simulated).toBe(false);
    expect(d!.expiresAt).not.toBeNull();
  });

  it('flags admin-panel-prefixed bans as manualByOperator', () => {
    const d = parseLapiDecision({
      id: 1,
      origin: 'cscli',
      type: 'ban',
      scope: 'Ip',
      value: '198.51.100.5',
      scenario: `${MANUAL_BAN_REASON_PREFIX}user-123:probing /.env`,
      duration: '4h',
    });
    expect(d!.manualByOperator).toBe(true);
    expect(d!.origin).toBe('cscli');
  });

  it('does NOT flag cscli bans without the admin-panel prefix (operator used CLI directly)', () => {
    const d = parseLapiDecision({
      id: 1,
      origin: 'cscli',
      type: 'ban',
      scope: 'Ip',
      value: '198.51.100.5',
      scenario: 'manual scenario name',
      duration: '4h',
    });
    expect(d!.manualByOperator).toBe(false);
  });

  it('drops decisions with unknown type (forward-compat safety)', () => {
    expect(parseLapiDecision({
      id: 1, type: 'mfa-step-up' as unknown as string,
      scope: 'Ip', value: '1.2.3.4', scenario: '', duration: '1h',
    } as unknown as { id: number; type: string; scope: string; value: string; scenario: string; duration: string })).toBeNull();
  });

  it('drops decisions with unknown scope', () => {
    expect(parseLapiDecision({
      id: 1, type: 'ban', scope: 'Region' as unknown as string,
      value: 'XX', scenario: '', duration: '1h',
    } as unknown as { id: number; type: string; scope: string; value: string; scenario: string; duration: string })).toBeNull();
  });

  it('drops decisions missing required fields', () => {
    expect(parseLapiDecision({ id: 1, type: 'ban', scope: 'Ip', value: '', scenario: '', duration: '1h' })).toBeNull();
    expect(parseLapiDecision({ id: NaN, type: 'ban', scope: 'Ip', value: '1.2.3.4', scenario: '', duration: '1h' })).toBeNull();
  });

  it('coerces non-string id to number when valid', () => {
    const d = parseLapiDecision({
      id: '42' as unknown as number,
      type: 'ban',
      scope: 'Ip',
      value: '1.2.3.4',
      scenario: 'cscli',
      duration: '4h',
    });
    expect(d!.id).toBe(42);
  });

  it('passes through simulated flag', () => {
    const d = parseLapiDecision({
      id: 1, origin: 'cscli', type: 'ban', scope: 'Ip',
      value: '1.2.3.4', scenario: 'test', duration: '1h', simulated: true,
    });
    expect(d!.simulated).toBe(true);
  });
});

describe('parseLapiDecision — auto-ban classification', () => {
  /**
   * The auto-ban scheduler bans through the same addBan helper an operator
   * does, with actor='autoban-scheduler', so its scenario also starts with
   * MANUAL_BAN_REASON_PREFIX. Before AUTO_BAN_SCENARIO_PREFIX existed, every
   * automatic ban came back manualByOperator=true and the Banned IPs table
   * rendered it as though a human had clicked it. This is the exact scenario
   * string observed on the DEV cluster on 2026-09-05.
   */
  const autoScenario = 'admin-panel:autoban-scheduler:auto-ban:rules 920450,930120 count 6';

  const decide = (scenario: string) => parseLapiDecision({
    id: 5, origin: 'cscli', type: 'ban', scope: 'Ip',
    value: '203.0.113.77', scenario, duration: '1h',
  });

  it('flags a scheduler ban as autoBanned', () => {
    expect(decide(autoScenario)!.autoBanned).toBe(true);
  });

  it('does NOT also call it a manual operator ban', () => {
    expect(decide(autoScenario)!.manualByOperator).toBe(false);
  });

  it('still flags a real operator ban as manual, and not auto', () => {
    const d = decide(`${MANUAL_BAN_REASON_PREFIX}user-123:probing /.env`)!;
    expect(d.manualByOperator).toBe(true);
    expect(d.autoBanned).toBe(false);
  });

  it('cannot be spoofed by an operator typing the reason prefix', () => {
    // The actor segment comes from the authenticated caller, so a reason of
    // "auto-ban: ..." from a human still classifies as manual.
    const d = decide(`${MANUAL_BAN_REASON_PREFIX}user-123:auto-ban:pretending`)!;
    expect(d.autoBanned).toBe(false);
    expect(d.manualByOperator).toBe(true);
  });

  it('does not flag community/scenario decisions as auto-ban', () => {
    const d = parseLapiDecision({
      id: 9, origin: 'CAPI', type: 'ban', scope: 'Ip',
      value: '198.51.100.9', scenario: 'crowdsecurity/http-probing', duration: '4h',
    })!;
    expect(d.autoBanned).toBe(false);
    expect(d.manualByOperator).toBe(false);
  });

  it('AUTO_BAN_SCENARIO_PREFIX extends the manual prefix (why the exclusion is needed)', () => {
    expect(AUTO_BAN_SCENARIO_PREFIX.startsWith(MANUAL_BAN_REASON_PREFIX)).toBe(true);
  });
});

describe('applyDecisionFilters — source scoping and paging', () => {
  const { applyDecisionFilters } = __test;

  const dec = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 1, origin: 'CAPI', type: 'ban', scope: 'Ip', value: '1.2.3.4',
    scenario: 'crowdsecurity/http-scan', duration: '4h', expiresAt: null,
    manualByOperator: false, staticByOperator: false, autoBanned: false, simulated: false,
    ...over,
  } as never);

  // Production 2026-09-06: 16,220 CAPI decisions against 2 platform ones. A
  // combined table buried every operator action and made the static-ban list
  // read as empty when the ban was present in the LAPI.
  const community = Array.from({ length: 50 }, (_, i) => dec({ id: 100 + i, value: `10.0.0.${i}` }));
  const platform = [
    dec({ id: 1, origin: 'cscli', value: '203.0.113.7', scenario: 'admin-panel:alice:manual ban', manualByOperator: true }),
    dec({ id: 2, origin: 'cscli', value: '203.0.113.8', scenario: 'admin-panel-static:alice:WAF rule 930130', staticByOperator: true }),
  ];
  const all = [...community, ...platform];

  it('defaults to PLATFORM decisions only', () => {
    const r = applyDecisionFilters(all, {});
    expect(r.decisions).toHaveLength(2);
    expect(r.decisions.every((d) => d.origin === 'cscli')).toBe(true);
    // totalActive still reports everything the LAPI holds.
    expect(r.totalActive).toBe(52);
    expect(r.totalMatching).toBe(2);
  });

  it('returns ONLY community decisions when asked', () => {
    const r = applyDecisionFilters(all, { source: 'community' });
    expect(r.decisions).toHaveLength(50);
    expect(r.decisions.every((d) => d.origin !== 'cscli')).toBe(true);
  });

  it('can still return both', () => {
    expect(applyDecisionFilters(all, { source: 'all' }).decisions).toHaveLength(52);
  });

  it('finds a static ban that used to be buried under the community feed', () => {
    const r = applyDecisionFilters(all, { staticOnly: true });
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].value).toBe('203.0.113.8');
  });

  it('pages the community list and reports the pre-paging total', () => {
    const p0 = applyDecisionFilters(all, { source: 'community', limit: 20, offset: 0 });
    expect(p0.decisions).toHaveLength(20);
    expect(p0.totalMatching).toBe(50);
    expect(p0.limit).toBe(20);
    expect(p0.offset).toBe(0);

    const p2 = applyDecisionFilters(all, { source: 'community', limit: 20, offset: 40 });
    expect(p2.decisions).toHaveLength(10);
    // Without totalMatching the UI could not tell this short page from "no
    // matches" — the exact ambiguity that made the static list look broken.
    expect(p2.totalMatching).toBe(50);
  });

  it('applies the search within the selected source', () => {
    const r = applyDecisionFilters(all, { source: 'platform', q: '203.0.113.8' });
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0].staticByOperator).toBe(true);
  });

  it('does not leak community rows into a platform search', () => {
    const r = applyDecisionFilters(all, { source: 'platform', q: '10.0.0.' });
    expect(r.decisions).toHaveLength(0);
    expect(r.totalMatching).toBe(0);
  });
});

describe('ensureCommunityBlocklistDefault', () => {
  // Flux inventories capi-config.yaml but never applies it: the
  // `reconcile: disabled` annotation that protects an operator's toggle makes
  // Flux SKIP the object entirely. Verified on DEV 2026-09-06 — the inventory
  // listed the ConfigMap while `kubectl get cm` returned NotFound, so the
  // "off by default" default never landed. The backend therefore creates it.
  it('creates the ConfigMap with the community blocklist OFF when absent', async () => {
    const notFound = Object.assign(new Error('not found'), { code: 404 });
    const create = vi.fn().mockResolvedValue({});
    const core = { readNamespacedConfigMap: vi.fn().mockRejectedValue(notFound), createNamespacedConfigMap: create };
    vi.spyOn(k8sModule, 'createKubeConfig').mockReturnValue({ makeApiClient: () => core } as never);

    const result = await ensureCommunityBlocklistDefault(undefined);
    expect(result).toBe('created');
    const body = create.mock.calls[0][0].body;
    expect(body.data.DISABLE_ONLINE_API).toBe('true');
    // The annotation must be on the CREATED object too, or Flux would start
    // fighting the operator's very first toggle.
    expect(body.metadata.annotations['kustomize.toolkit.fluxcd.io/reconcile']).toBe('disabled');
  });

  it('never overwrites an operator who already opted IN', async () => {
    const create = vi.fn();
    const core = {
      readNamespacedConfigMap: vi.fn().mockResolvedValue({ data: { DISABLE_ONLINE_API: 'false' } }),
      createNamespacedConfigMap: create,
    };
    vi.spyOn(k8sModule, 'createKubeConfig').mockReturnValue({ makeApiClient: () => core } as never);

    expect(await ensureCommunityBlocklistDefault(undefined)).toBe('present');
    expect(create).not.toHaveBeenCalled();
  });
});
