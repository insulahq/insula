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
} from './crowdsec-scenarios.js';

afterEach(() => { vi.restoreAllMocks(); });

const CRAWL = 'crowdsecurity/http-crawl-non_statics';
const PROBING = 'crowdsecurity/http-probing';
const SENSITIVE = 'crowdsecurity/http-sensitive-files';

/** The ConfigMap as the platform shipped it before this change: one key. */
function legacyData(alertOnly: readonly string[]): Record<string, string> {
  return { [SIMULATION_CONFIGMAP_KEY]: renderSimulationYaml(alertOnly, true) };
}

/**
 * An in-memory ConfigMap + agent pod list behind the CoreV1Api surface the
 * module uses, so a disable → enable CYCLE can be asserted end to end rather
 * than one call at a time.
 */
function fakeCluster(initial: Record<string, string> | null, opts: { rollFails?: boolean } = {}) {
  let data: Record<string, string> | null = initial ? { ...initial } : null;
  const notFound = () => Object.assign(new Error('not found'), { code: 404 });
  const core = {
    readNamespacedConfigMap: vi.fn(async () => {
      if (!data) throw notFound();
      return { data: { ...data } };
    }),
    createNamespacedConfigMap: vi.fn(async ({ body }: { body: { data: Record<string, string> } }) => {
      if (data) throw Object.assign(new Error('already exists'), { code: 409 });
      data = { ...body.data };
      return body;
    }),
    patchNamespacedConfigMap: vi.fn(async ({ body }: { body: { data: Record<string, string> } }) => {
      if (!data) throw notFound();
      data = { ...data, ...body.data };
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
    data: () => data,
    agentFile: () => parseSimulationYaml(data?.[SIMULATION_CONFIGMAP_KEY] ?? ''),
  };
}

/** An agent that reports three scenarios, for the paths that validate names. */
function fakeAgent(reachable = true) {
  if (!reachable) {
    vi.spyOn(cscli, 'findCrowdsecPodName').mockRejectedValue(new Error('no crowdsec-agent pod is Running'));
    return;
  }
  vi.spyOn(cscli, 'findCrowdsecPodName').mockResolvedValue('crowdsec-agent-a');
  vi.spyOn(cscli, 'cscliExec').mockImplementation(async (_kc, _pod, args) => {
    if (args[0] === 'scenarios') {
      return {
        stdout: JSON.stringify({ scenarios: [CRAWL, PROBING, SENSITIVE].map((name) => ({ name, description: name, status: 'enabled' })) }),
        stderr: '',
      } as never;
    }
    return { stdout: '{}', stderr: '' } as never;
  });
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
    const out = await setTrafficDetectionEnabled(undefined, false);

    expect(cluster.agentFile()).toEqual({ global: true, simulated: [] });
    expect(parseAlertOnlyList(cluster.data()?.[ALERT_ONLY_LIST_KEY] ?? '')).toEqual([CRAWL, PROBING]);
    // CrowdSec reads simulation.yaml only at startup: without the roll the
    // switch is saved and NOT running.
    expect(cluster.core.deleteNamespacedPod).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ enabled: false, alertOnly: [CRAWL, PROBING], rolledPods: 2, rollError: null });
  });

  it('disable → enable restores the original exclusions exactly', async () => {
    const cluster = fakeCluster(legacyData([CRAWL, PROBING]));
    await setTrafficDetectionEnabled(undefined, false);
    const out = await setTrafficDetectionEnabled(undefined, true);

    expect(cluster.agentFile()).toEqual({ global: false, simulated: [CRAWL, PROBING] });
    expect(out.alertOnly).toEqual([CRAWL, PROBING]);
    expect(cluster.core.deleteNamespacedPod).toHaveBeenCalledTimes(4);
  });

  it('writes with a MERGE patch so the reconcile-disabled annotation survives', async () => {
    const cluster = fakeCluster(legacyData([CRAWL]));
    await setTrafficDetectionEnabled(undefined, false);
    const [, options] = cluster.core.patchNamespacedConfigMap.mock.calls[0] as unknown as [unknown, unknown];
    expect(options).toBe(MERGE_PATCH);
  });

  it('does not roll the agent when nothing it reads changes', async () => {
    const cluster = fakeCluster(legacyData([CRAWL]));
    const out = await setTrafficDetectionEnabled(undefined, true);
    expect(cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
    expect(out.rolledPods).toBe(0);
  });

  it('creates the ConfigMap in the requested state when it is absent', async () => {
    const cluster = fakeCluster(null);
    await setTrafficDetectionEnabled(undefined, false);
    expect(cluster.agentFile().global).toBe(true);
    expect(parseAlertOnlyList(cluster.data()?.[ALERT_ONLY_LIST_KEY] ?? '')).toEqual([...DEFAULT_SIMULATED_SCENARIOS]);
  });

  it('reports a failed roll instead of throwing — the config is already saved', async () => {
    const cluster = fakeCluster(legacyData([CRAWL]), { rollFails: true });
    const out = await setTrafficDetectionEnabled(undefined, false);
    expect(cluster.agentFile().global).toBe(true);
    expect(out.rollError).toMatch(/forbidden/);
  });
});

describe('ensureAgentSimulationDefault — the saved choice is re-applied', () => {
  it('creates a missing ConfigMap DISABLED when that is the saved choice', async () => {
    const cluster = fakeCluster(null);
    expect(await ensureAgentSimulationDefault(undefined, false)).toBe('created');
    expect(cluster.agentFile()).toEqual({ global: true, simulated: [] });
    expect(parseAlertOnlyList(cluster.data()?.[ALERT_ONLY_LIST_KEY] ?? '')).toEqual([...DEFAULT_SIMULATED_SCENARIOS]);
  });

  it('creates the shipped default when nothing was ever saved', async () => {
    const cluster = fakeCluster(null);
    expect(await ensureAgentSimulationDefault(undefined, null)).toBe('created');
    expect(cluster.agentFile()).toEqual({ global: false, simulated: [...DEFAULT_SIMULATED_SCENARIOS] });
  });

  it('leaves a present ConfigMap alone when nothing was ever saved', async () => {
    const cluster = fakeCluster({ [SIMULATION_CONFIGMAP_KEY]: 'simulation: true\nexclusions: []\n' });
    expect(await ensureAgentSimulationDefault(undefined, null)).toBe('present');
    expect(cluster.core.patchNamespacedConfigMap).not.toHaveBeenCalled();
    expect(cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it('re-applies a saved DISABLE the ConfigMap does not reflect, keeping the per-scenario list', async () => {
    const cluster = fakeCluster(legacyData([CRAWL, PROBING]));
    expect(await ensureAgentSimulationDefault(undefined, false)).toBe('reconciled');
    expect(cluster.agentFile()).toEqual({ global: true, simulated: [] });
    expect(parseAlertOnlyList(cluster.data()?.[ALERT_ONLY_LIST_KEY] ?? '')).toEqual([CRAWL, PROBING]);
    expect(cluster.core.deleteNamespacedPod).toHaveBeenCalled();
  });

  it('does nothing on boot when the ConfigMap already matches — no agent bounce per restart', async () => {
    const cluster = fakeCluster(legacyData([CRAWL]));
    expect(await ensureAgentSimulationDefault(undefined, true)).toBe('present');
    expect(cluster.core.patchNamespacedConfigMap).not.toHaveBeenCalled();
    expect(cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it('treats losing the create race to another replica as present', async () => {
    const cluster = fakeCluster(null);
    cluster.core.readNamespacedConfigMap.mockRejectedValueOnce(Object.assign(new Error('nf'), { code: 404 }));
    cluster.core.createNamespacedConfigMap.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 409 }));
    expect(await ensureAgentSimulationDefault(undefined, false)).toBe('present');
  });
});

describe('setScenarioSimulation keeps the global switch', () => {
  it('while DISABLED, edits the stash only — the agent file and the pods are untouched', async () => {
    fakeAgent();
    const cluster = fakeCluster({
      [SIMULATION_CONFIGMAP_KEY]: renderSimulationYaml([CRAWL], false),
      [ALERT_ONLY_LIST_KEY]: renderAlertOnlyList([CRAWL]),
    });
    const out = await setScenarioSimulation(undefined, PROBING, true, false);

    expect(cluster.agentFile()).toEqual({ global: true, simulated: [] });
    expect(parseAlertOnlyList(cluster.data()?.[ALERT_ONLY_LIST_KEY] ?? '')).toEqual([CRAWL, PROBING]);
    expect(cluster.core.deleteNamespacedPod).not.toHaveBeenCalled();
    expect(out).toEqual({ simulated: [CRAWL, PROBING], rolledPods: 0, rollError: null });
  });

  it('while ENABLED, changes the exclusions and rolls the agent', async () => {
    fakeAgent();
    const cluster = fakeCluster(legacyData([CRAWL]));
    await setScenarioSimulation(undefined, PROBING, true, null);
    expect(cluster.agentFile()).toEqual({ global: false, simulated: [CRAWL, PROBING] });
    expect(cluster.core.deleteNamespacedPod).toHaveBeenCalledTimes(2);
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
