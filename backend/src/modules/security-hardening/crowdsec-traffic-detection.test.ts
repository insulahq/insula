/**
 * Malicious Traffic Detection on/off — the agent's GLOBAL simulation switch.
 *
 * The trap this file pins: CrowdSec INVERTS `exclusions` when the global
 * switch is on. With `simulation: true` every scenario listed under
 * `exclusions` ENFORCES. So "disable" cannot just flip the switch and keep the
 * per-scenario list in place — that would arm exactly the scenarios the
 * operator marked alert-only (http-crawl-non_statics bans search-engine
 * crawlers from every tenant site). The list is stashed in its own key and
 * restored on re-enable.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as k8s from '@kubernetes/client-node';
import * as cscli from './cscli-exec.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import {
  ALERT_ONLY_LIST_KEY,
  DEFAULT_SIMULATED_SCENARIOS,
  SIMULATION_CONFIGMAP_KEY,
  ensureAgentSimulationDefault,
  listScenarios,
  parseAlertOnlyList,
  parseSimulationYaml,
  renderAlertOnlyList,
  renderSimulationYaml,
  setScenarioSimulation,
  setTrafficDetectionEnabled,
  simulationStateFromData,
  MAX_CAS_ATTEMPTS,
  SimulationConfigConflictError,
  LAST_LISTING_MAX_AGE_MS,
  resetLastListingForTests,
} from './crowdsec-scenarios.js';
import { WRITTEN_AT_ANNOTATION } from './crowdsec-simulation-store.js';

afterEach(() => { vi.restoreAllMocks(); resetLastListingForTests(); });

const CRAWL = 'crowdsecurity/http-crawl-non_statics';
const PROBING = 'crowdsecurity/http-probing';
const SENSITIVE = 'crowdsecurity/http-sensitive-files';

/** The ConfigMap as the platform shipped it before this change: one key. */
function legacyData(alertOnly: readonly string[]): Record<string, string> {
  return { [SIMULATION_CONFIGMAP_KEY]: renderSimulationYaml(alertOnly, true) };
}

/** A saved-choice reader, as the routes and startup pass one. */
const saved = (v: boolean | null) => vi.fn(async () => v);

type PatchBody = { metadata?: { resourceVersion?: string; annotations?: Record<string, string> }; data: Record<string, string> };

/**
 * An in-memory ConfigMap + agent pod list behind the CoreV1Api surface the
 * module uses, so a disable → enable CYCLE can be asserted end to end rather
 * than one call at a time.
 *
 * It enforces the apiserver's optimistic concurrency the way DEV did when
 * probed: a patch carrying a resourceVersion that is no longer current is
 * answered 409. `beforePatch` hooks run (once each) just before a patch is
 * judged — that is where another writer's change is injected.
 * `patchBarrier: n` holds the first n patches until all n are pending, so
 * every one of them was computed from a read taken before ANY write landed.
 */
function fakeCluster(
  initial: Record<string, string> | null,
  opts: { rollFails?: boolean; patchBarrier?: number } = {},
) {
  let data: Record<string, string> | null = initial ? { ...initial } : null;
  let annotations: Record<string, string> = {};
  let rv = 1;
  const beforePatch: Array<() => void> = [];
  const gate = { need: opts.patchBarrier ?? 0, waiters: [] as Array<() => void> };
  const notFound = () => Object.assign(new Error('not found'), { code: 404 });
  const conflict = () => Object.assign(new Error('the object has been modified'), { code: 409 });
  const core = {
    readNamespacedConfigMap: vi.fn(async () => {
      if (!data) throw notFound();
      return { data: { ...data }, metadata: { resourceVersion: String(rv), annotations: { ...annotations } } };
    }),
    createNamespacedConfigMap: vi.fn(async ({ body }: { body: PatchBody }) => {
      if (data) throw conflict();
      data = { ...body.data };
      annotations = { ...(body.metadata?.annotations ?? {}) };
      rv += 1;
      return body;
    }),
    patchNamespacedConfigMap: vi.fn(async ({ body }: { body: PatchBody }) => {
      if (gate.need > 0) {
        await new Promise<void>((release) => {
          gate.waiters.push(release);
          if (gate.waiters.length >= gate.need) {
            gate.need = 0;
            gate.waiters.forEach((w) => w());
          }
        });
      }
      beforePatch.shift()?.();
      if (!data) throw notFound();
      if (body.metadata?.resourceVersion !== undefined && body.metadata.resourceVersion !== String(rv)) {
        throw conflict();
      }
      data = { ...data, ...body.data };
      annotations = { ...annotations, ...(body.metadata?.annotations ?? {}) };
      rv += 1;
      return {};
    }),
    listNamespacedPod: vi.fn(async () => {
      if (opts.rollFails) throw new Error('pods is forbidden');
      return { items: [{ metadata: { name: 'crowdsec-agent-a' } }, { metadata: { name: 'crowdsec-agent-b' } }] };
    }),
    deleteNamespacedPod: vi.fn(async () => ({})),
  };
  vi.spyOn(k8s.KubeConfig.prototype, 'loadFromDefault').mockImplementation(() => undefined);
  vi.spyOn(k8s.KubeConfig.prototype, 'makeApiClient').mockReturnValue(core as never);
  return {
    core,
    beforePatch,
    data: () => data,
    rv: () => rv,
    annotations: () => annotations,
    agentFile: () => parseSimulationYaml(data?.[SIMULATION_CONFIGMAP_KEY] ?? ''),
    stash: () => parseAlertOnlyList(data?.[ALERT_ONLY_LIST_KEY] ?? ''),
    /** Another writer (replica, tab) changes the object: new content, new resourceVersion. */
    externalWrite: (next: Record<string, string> | null) => {
      data = next ? { ...(data ?? {}), ...next } : data;
      annotations = { ...annotations, [WRITTEN_AT_ANNOTATION]: `external-${rv}` };
      rv += 1;
    },
  };
}

/** An agent that reports three scenarios, for the paths that validate names. */
function fakeAgent(reachable = true) {
  const find = vi.spyOn(cscli, 'findCrowdsecPodName');
  if (!reachable) {
    find.mockRejectedValue(new Error('no crowdsec-agent pod is Running'));
    return find;
  }
  find.mockResolvedValue('crowdsec-agent-a');
  vi.spyOn(cscli, 'cscliExec').mockImplementation(async (_kc, _pod, args) => {
    if (args[0] === 'scenarios') {
      return {
        stdout: JSON.stringify({ scenarios: [CRAWL, PROBING, SENSITIVE].map((name) => ({ name, description: name, status: 'enabled' })) }),
        stderr: '',
      } as never;
    }
    return { stdout: '{}', stderr: '' } as never;
  });
  return find;
}

describe('renderSimulationYaml with detection DISABLED', () => {
  it('turns the global switch on and lists NO exclusions — with it on, exclusions ENFORCE', () => {
    const parsed = parseSimulationYaml(renderSimulationYaml([CRAWL, PROBING], false));
    expect(parsed.global).toBe(true);
    // Not [CRAWL, PROBING]: under `simulation: true` those two would be the
    // only scenarios issuing bans — the inverse of what the operator asked.
    expect(parsed.simulated).toEqual([]);
  });

  it('says in the file itself what disabled means', () => {
    const text = renderSimulationYaml([CRAWL], false);
    expect(text).toMatch(/DISABLED/);
    expect(text).toContain(ALERT_ONLY_LIST_KEY);
  });
});

describe('alert-only list key', () => {
  it('round-trips, sorted and de-duplicated', () => {
    expect(parseAlertOnlyList(renderAlertOnlyList([PROBING, CRAWL, PROBING]))).toEqual([CRAWL, PROBING]);
  });

  it('round-trips an EMPTY list — every scenario enforcing once re-enabled', () => {
    expect(parseAlertOnlyList(renderAlertOnlyList([]))).toEqual([]);
  });

  it('ignores comments and tolerates a YAML-style dash', () => {
    expect(parseAlertOnlyList(`# note\n- ${CRAWL}\n\n  ${PROBING}  # trailing\n`)).toEqual([CRAWL, PROBING]);
  });
});

describe('simulationStateFromData', () => {
  it('reads a pre-existing single-key ConfigMap as enabled with its exclusions', () => {
    const state = simulationStateFromData(legacyData([CRAWL]));
    expect(state).toMatchObject({ globalSimulation: false, alertOnly: [CRAWL] });
  });

  it('while disabled, takes the per-scenario choice from the stash key', () => {
    const state = simulationStateFromData({
      [SIMULATION_CONFIGMAP_KEY]: renderSimulationYaml([CRAWL, PROBING], false),
      [ALERT_ONLY_LIST_KEY]: renderAlertOnlyList([CRAWL, PROBING]),
    });
    expect(state).toMatchObject({ globalSimulation: true, alertOnly: [CRAWL, PROBING] });
  });

  it('while enabled, reports what the agent actually runs even if the stash disagrees', () => {
    const state = simulationStateFromData({
      [SIMULATION_CONFIGMAP_KEY]: renderSimulationYaml([PROBING], true),
      [ALERT_ONLY_LIST_KEY]: renderAlertOnlyList([CRAWL]),
    });
    expect(state?.alertOnly).toEqual([PROBING]);
  });

  it('falls back to the shipped default for a hand-set global switch with no stash', () => {
    const state = simulationStateFromData({ [SIMULATION_CONFIGMAP_KEY]: 'simulation: true\nexclusions: []\n' });
    expect(state).toMatchObject({ globalSimulation: true, alertOnly: [...DEFAULT_SIMULATED_SCENARIOS] });
  });

  it('is null when the agent file is missing', () => {
    expect(simulationStateFromData(undefined)).toBeNull();
    expect(simulationStateFromData({ other: 'x' })).toBeNull();
  });
});

describe('setTrafficDetectionEnabled', () => {
  it('disable → every scenario alert-only, the per-scenario list stashed, the agent rolled', async () => {
    const cluster = fakeCluster(legacyData([CRAWL, PROBING]));
    const out = await setTrafficDetectionEnabled(undefined, saved(false));

    expect(cluster.agentFile()).toEqual({ global: true, simulated: [] });
    expect(cluster.stash()).toEqual([CRAWL, PROBING]);
    // CrowdSec reads simulation.yaml only at startup: without the roll the
    // switch is saved and NOT running.
    expect(cluster.core.deleteNamespacedPod).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ enabled: false, alertOnly: [CRAWL, PROBING], rolledPods: 2, rollError: null });
  });

  it('disable → enable restores the original exclusions exactly', async () => {
    const cluster = fakeCluster(legacyData([CRAWL, PROBING]));
    await setTrafficDetectionEnabled(undefined, saved(false));
    const out = await setTrafficDetectionEnabled(undefined, saved(true));

    expect(cluster.agentFile()).toEqual({ global: false, simulated: [CRAWL, PROBING] });
    expect(out.alertOnly).toEqual([CRAWL, PROBING]);
    expect(cluster.core.deleteNamespacedPod).toHaveBeenCalledTimes(4);
  });

  it('writes with a MERGE patch carrying the read resourceVersion', async () => {
    const cluster = fakeCluster(legacyData([CRAWL]));
    const rvBefore = String(cluster.rv());
    await setTrafficDetectionEnabled(undefined, saved(false));
    const [args, options] = cluster.core.patchNamespacedConfigMap.mock.calls[0] as unknown as [{ body: PatchBody }, unknown];
    expect(options).toBe(MERGE_PATCH);
    expect(args.body.metadata?.resourceVersion).toBe(rvBefore);
  });

  it('always writes — even when nothing changes — so a concurrent stale writer conflicts; no agent roll', async () => {
    const cluster = fakeCluster(legacyData([CRAWL]));
    const rvBefore = cluster.rv();
    const out = await setTrafficDetectionEnabled(undefined, saved(true));
    expect(cluster.rv()).toBeGreaterThan(rvBefore);
    expect(cluster.annotations()[WRITTEN_AT_ANNOTATION]).toBeTruthy();
    expect(cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
    expect(out.rolledPods).toBe(0);
  });

  it('applies the value SAVED at write time — of two racing toggles the later save wins', async () => {
    const cluster = fakeCluster(legacyData([CRAWL]));
    // This request saved "disabled", but a later toggle saved "enabled"
    // before this one wrote the ConfigMap.
    const out = await setTrafficDetectionEnabled(undefined, saved(true));
    expect(out.enabled).toBe(true);
    expect(cluster.agentFile().global).toBe(false);
  });

  it('creates the ConfigMap in the requested state when it is absent', async () => {
    const cluster = fakeCluster(null);
    await setTrafficDetectionEnabled(undefined, saved(false));
    expect(cluster.agentFile().global).toBe(true);
    expect(cluster.stash()).toEqual([...DEFAULT_SIMULATED_SCENARIOS]);
  });

  it('reports a failed roll instead of throwing — the config is already saved', async () => {
    const cluster = fakeCluster(legacyData([CRAWL]), { rollFails: true });
    const out = await setTrafficDetectionEnabled(undefined, saved(false));
    expect(cluster.agentFile().global).toBe(true);
    expect(out.rollError).toMatch(/forbidden/);
  });

  it('retries a conflict on fresh reads and keeps the other writer\'s scenario change', async () => {
    const cluster = fakeCluster(legacyData([CRAWL]));
    // Between our read and our write, a scenario toggle elsewhere adds PROBING.
    cluster.beforePatch.push(() => cluster.externalWrite(legacyData([CRAWL, PROBING])));
    await setTrafficDetectionEnabled(undefined, saved(false));
    expect(cluster.core.patchNamespacedConfigMap).toHaveBeenCalledTimes(2);
    expect(cluster.agentFile()).toEqual({ global: true, simulated: [] });
    expect(cluster.stash()).toEqual([CRAWL, PROBING]);
  });
});

describe('ensureAgentSimulationDefault — the saved choice is re-applied', () => {
  it('creates a missing ConfigMap DISABLED when that is the saved choice', async () => {
    const cluster = fakeCluster(null);
    expect(await ensureAgentSimulationDefault(undefined, saved(false))).toBe('created');
    expect(cluster.agentFile()).toEqual({ global: true, simulated: [] });
    expect(cluster.stash()).toEqual([...DEFAULT_SIMULATED_SCENARIOS]);
  });

  it('creates the shipped default when nothing was ever saved', async () => {
    const cluster = fakeCluster(null);
    expect(await ensureAgentSimulationDefault(undefined, saved(null))).toBe('created');
    expect(cluster.agentFile()).toEqual({ global: false, simulated: [...DEFAULT_SIMULATED_SCENARIOS] });
  });

  it('leaves a present ConfigMap alone when nothing was ever saved', async () => {
    const cluster = fakeCluster({ [SIMULATION_CONFIGMAP_KEY]: 'simulation: true\nexclusions: []\n' });
    expect(await ensureAgentSimulationDefault(undefined, saved(null))).toBe('present');
    expect(cluster.core.patchNamespacedConfigMap).not.toHaveBeenCalled();
    expect(cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it('re-applies a saved DISABLE the ConfigMap does not reflect, keeping the per-scenario list', async () => {
    const cluster = fakeCluster(legacyData([CRAWL, PROBING]));
    expect(await ensureAgentSimulationDefault(undefined, saved(false))).toBe('reconciled');
    expect(cluster.agentFile()).toEqual({ global: true, simulated: [] });
    expect(cluster.stash()).toEqual([CRAWL, PROBING]);
    expect(cluster.core.deleteNamespacedPod).toHaveBeenCalled();
  });

  it('does nothing on boot when the ConfigMap already matches — no write, no agent bounce', async () => {
    const cluster = fakeCluster(legacyData([CRAWL]));
    expect(await ensureAgentSimulationDefault(undefined, saved(true))).toBe('present');
    expect(cluster.core.patchNamespacedConfigMap).not.toHaveBeenCalled();
    expect(cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it('treats losing the create race to another replica as present', async () => {
    const cluster = fakeCluster(null);
    cluster.core.createNamespacedConfigMap.mockImplementationOnce(async () => {
      // The other replica created it — in the saved (disabled) state.
      cluster.externalWrite({
        [SIMULATION_CONFIGMAP_KEY]: renderSimulationYaml([CRAWL], false),
        [ALERT_ONLY_LIST_KEY]: renderAlertOnlyList([CRAWL]),
      });
      throw Object.assign(new Error('already exists'), { code: 409 });
    });
    expect(await ensureAgentSimulationDefault(undefined, saved(false))).toBe('present');
    expect(cluster.core.patchNamespacedConfigMap).not.toHaveBeenCalled();
  });

  it('reads the saved choice AFTER the ConfigMap, on every attempt', async () => {
    const cluster = fakeCluster(legacyData([CRAWL]));
    const desired = saved(false);
    await ensureAgentSimulationDefault(undefined, desired);
    expect(cluster.core.readNamespacedConfigMap.mock.invocationCallOrder[0])
      .toBeLessThan(desired.mock.invocationCallOrder[0]);
  });

  it('never overwrites a toggle that lands between its DB read and its write (rolling deploy)', async () => {
    // Detection is enabled. This booting replica reads the saved choice while
    // it is still the OLD value (disabled); before it writes, the operator
    // enables detection on another replica — saved first, then the ConfigMap
    // touched (it already said enabled, but the toggle always writes).
    const cluster = fakeCluster(legacyData([CRAWL]));
    let reads = 0;
    const desired = vi.fn(async () => {
      reads += 1;
      if (reads === 1) {
        cluster.externalWrite(null);
        return false;
      }
      return true;
    });

    const outcome = await ensureAgentSimulationDefault(undefined, desired);

    // Its stale write conflicted, it re-read BOTH and found nothing to do.
    expect(outcome).toBe('present');
    expect(desired).toHaveBeenCalledTimes(2);
    expect(cluster.agentFile()).toEqual({ global: false, simulated: [CRAWL] });
    expect(cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
  });
});

describe('setScenarioSimulation keeps the global switch', () => {
  it('while DISABLED, edits the stash only — the agent file and the pods are untouched', async () => {
    fakeAgent();
    const cluster = fakeCluster({
      [SIMULATION_CONFIGMAP_KEY]: renderSimulationYaml([CRAWL], false),
      [ALERT_ONLY_LIST_KEY]: renderAlertOnlyList([CRAWL]),
    });
    const out = await setScenarioSimulation(undefined, PROBING, true, saved(false));

    expect(cluster.agentFile()).toEqual({ global: true, simulated: [] });
    expect(cluster.stash()).toEqual([CRAWL, PROBING]);
    expect(cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
    expect(out).toEqual({ simulated: [CRAWL, PROBING], rolledPods: 0, rollError: null });
  });

  it('while ENABLED, changes the exclusions and rolls the agent', async () => {
    fakeAgent();
    const cluster = fakeCluster(legacyData([CRAWL]));
    await setScenarioSimulation(undefined, PROBING, true, saved(null));
    expect(cluster.agentFile()).toEqual({ global: false, simulated: [CRAWL, PROBING] });
    expect(cluster.core.deleteNamespacedPod).toHaveBeenCalledTimes(2);
  });

  it('does not write at all when the scenario is already in that mode', async () => {
    fakeAgent();
    const cluster = fakeCluster(legacyData([CRAWL]));
    await setScenarioSimulation(undefined, CRAWL, true, saved(null));
    expect(cluster.core.patchNamespacedConfigMap).not.toHaveBeenCalled();
  });
});

describe('setScenarioSimulation — concurrent changes are never lost', () => {
  it('two overlapping toggles on DIFFERENT scenarios both survive', async () => {
    fakeAgent();
    // Both patches are held until both are pending: each was computed from a
    // read taken before either write landed — the lost-update window.
    const cluster = fakeCluster(legacyData([CRAWL]), { patchBarrier: 2 });
    const [a, b] = await Promise.all([
      setScenarioSimulation(undefined, PROBING, true, saved(null)),
      setScenarioSimulation(undefined, SENSITIVE, true, saved(null)),
    ]);

    expect(cluster.agentFile()).toEqual({ global: false, simulated: [CRAWL, PROBING, SENSITIVE].sort() });
    expect(cluster.stash()).toEqual([CRAWL, PROBING, SENSITIVE].sort());
    // One of them lost the race once and re-applied its change on a fresh read.
    expect(cluster.core.patchNamespacedConfigMap).toHaveBeenCalledTimes(3);
    expect([a.simulated, b.simulated].map((l) => l.length).sort()).toEqual([2, 3]);
  });

  it('retries a conflict: the concurrent change and ours both land', async () => {
    fakeAgent();
    const cluster = fakeCluster(legacyData([CRAWL]));
    cluster.beforePatch.push(() => cluster.externalWrite(legacyData([CRAWL, SENSITIVE])));
    const out = await setScenarioSimulation(undefined, PROBING, true, saved(null));

    expect(cluster.core.patchNamespacedConfigMap).toHaveBeenCalledTimes(2);
    expect(out.simulated).toEqual([CRAWL, PROBING, SENSITIVE].sort());
    expect(cluster.agentFile().simulated).toEqual([CRAWL, PROBING, SENSITIVE].sort());
  });

  it('gives up after a bounded number of conflicts, overwriting nothing', async () => {
    fakeAgent();
    const cluster = fakeCluster(legacyData([CRAWL]));
    for (let i = 0; i < MAX_CAS_ATTEMPTS; i += 1) {
      cluster.beforePatch.push(() => cluster.externalWrite(legacyData([CRAWL, SENSITIVE])));
    }
    await expect(setScenarioSimulation(undefined, PROBING, true, saved(null)))
      .rejects.toBeInstanceOf(SimulationConfigConflictError);
    expect(cluster.core.patchNamespacedConfigMap).toHaveBeenCalledTimes(MAX_CAS_ATTEMPTS);
    expect(cluster.agentFile().simulated).toEqual([CRAWL, SENSITIVE]);
  });
});

describe('listScenarios — detection state', () => {
  it('reports the saved choice and the per-scenario stash while disabled', async () => {
    fakeAgent();
    fakeCluster({
      [SIMULATION_CONFIGMAP_KEY]: renderSimulationYaml([CRAWL], false),
      [ALERT_ONLY_LIST_KEY]: renderAlertOnlyList([CRAWL]),
    });
    const out = await listScenarios(undefined, false);
    expect(out.detectionEnabled).toBe(false);
    expect(out.globalSimulation).toBe(true);
    expect(out.scenarios.find((s) => s.name === CRAWL)?.simulated).toBe(true);
    expect(out.scenarios.find((s) => s.name === PROBING)?.simulated).toBe(false);
  });

  it('falls back to what the agent runs when no choice was ever saved', async () => {
    fakeAgent();
    fakeCluster(legacyData([CRAWL]));
    expect((await listScenarios(undefined, null)).detectionEnabled).toBe(true);
  });

  it('still reports the switch when the agent itself is unreachable', async () => {
    // Disabling detection is exactly what an operator may want while the
    // agent misbehaves, so the toggle state must not depend on reaching it.
    fakeAgent(false);
    fakeCluster({
      [SIMULATION_CONFIGMAP_KEY]: renderSimulationYaml([CRAWL], false),
      [ALERT_ONLY_LIST_KEY]: renderAlertOnlyList([CRAWL]),
    });
    const out = await listScenarios(undefined, null);
    expect(out.error).toMatch(/no crowdsec-agent pod/);
    expect(out.globalSimulation).toBe(true);
    expect(out.detectionEnabled).toBe(false);
  });
});

describe('while the agent restarts after a change', () => {
  // Every change deletes the agent pods; a DaemonSet creates the replacement
  // only once the old pod is gone, so for some seconds there is no agent.

  it('serves the list the agent reported moments ago, flagged, with CURRENT modes', async () => {
    const find = fakeAgent();
    const cluster = fakeCluster(legacyData([CRAWL]));
    const live = await listScenarios(undefined, null);
    expect(live.cachedAt).toBeNull();

    find.mockRejectedValue(new Error('no crowdsec-agent pod is Running'));
    cluster.externalWrite(legacyData([CRAWL, PROBING]));
    const during = await listScenarios(undefined, null);

    expect(during.error).toBeNull();
    expect(during.cachedAt).not.toBeNull();
    expect(during.scenarios.map((s) => s.name)).toEqual(live.scenarios.map((s) => s.name));
    expect(during.scenarios.find((s) => s.name === PROBING)?.simulated).toBe(true);
  });

  it('lets the NEXT toggle validate against that list — two changes in a row work', async () => {
    const find = fakeAgent();
    const cluster = fakeCluster(legacyData([CRAWL]));
    await setScenarioSimulation(undefined, PROBING, true, saved(null));
    find.mockRejectedValue(new Error('no crowdsec-agent pod is Running'));
    await setScenarioSimulation(undefined, SENSITIVE, true, saved(null));
    expect(cluster.agentFile().simulated).toEqual([CRAWL, PROBING, SENSITIVE].sort());
  });

  it('still rejects a name the agent never reported', async () => {
    const find = fakeAgent();
    fakeCluster(legacyData([CRAWL]));
    await listScenarios(undefined, null);
    find.mockRejectedValue(new Error('no crowdsec-agent pod is Running'));
    await expect(setScenarioSimulation(undefined, 'crowdsecurity/http-crawl-non-statics', true, saved(null)))
      .rejects.toThrow(/unknown scenario/);
  });

  it('reports a real outage once the last list is too old to stand in', async () => {
    const find = fakeAgent();
    fakeCluster(legacyData([CRAWL]));
    await listScenarios(undefined, null);
    find.mockRejectedValue(new Error('no crowdsec-agent pod is Running'));
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + LAST_LISTING_MAX_AGE_MS + 1);
    const out = await listScenarios(undefined, null);
    expect(out.cachedAt).toBeNull();
    expect(out.error).toMatch(/no crowdsec-agent pod/);
    expect(out.scenarios).toEqual([]);
  });
});
