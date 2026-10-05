/**
 * Traffic detection — the CrowdSec scenarios running on the log-processing
 * AGENT, and the switch that decides whether each one bans or only alerts.
 *
 * WHY THIS EXISTS
 *
 * Until now the platform counted scenarios (`scenariosLoaded` on the status
 * tile) and offered nothing else: no list, no descriptions, no way to turn one
 * off. An operator seeing `crowdsecurity/http-sensitive-files` in the ban table
 * had no way to find out what that scenario does, how much traffic it sees, or
 * how to stop it banning — the only lever was the whole feed.
 *
 * WHY THE AGENT AND NOT THE LAPI
 *
 * The LAPI Deployment runs `DISABLE_AGENT=true`. It still carries six `ssh-*`
 * hub items, so asking it for scenarios returns a plausible, completely wrong
 * answer — six items, none of which can fire, while the 53 that actually decide
 * bans live on the DaemonSet in platform-system. Every call here targets
 * AGENT_TARGET explicitly.
 *
 * WHY A CONFIGMAP AND NOT `cscli simulation enable`
 *
 * `cscli simulation enable` writes inside the container, so a DaemonSet pod
 * restart silently reverts it — the operator's change would survive exactly
 * until the next node reboot, and nothing would say so. The agent parses
 * simulation.yaml ONCE at startup, so the durable form of this setting is the
 * file, and the file comes from a ConfigMap.
 *
 * WHY THE BACKEND OWNS THAT CONFIGMAP
 *
 * It carries `kustomize.toolkit.fluxcd.io/reconcile: disabled` so Flux cannot
 * revert an operator's toggle — and that annotation makes Flux skip the object
 * during apply ENTIRELY, so Flux inventories it and never creates it (verified
 * on DEV for crowdsec-capi-config). Same division of labour as that
 * switch and the webmail feature flags: the manifest declares the mount, the
 * backend creates and owns the content.
 *
 * The DaemonSet mounts it NON-optionally on purpose. If it is missing the agent
 * stays in ContainerCreating, which is fail-safe: no agent means no traffic
 * bans, and ingress is unaffected because the bouncer reads the LAPI. An
 * `optional: true` mount would instead start the agent with NO simulation file,
 * which promotes http-crawl-non_statics to enforcing — and that scenario bans
 * search-engine crawlers from every tenant site at once. Failing visibly beats
 * silently arming the one scenario the manifest warns about.
 *
 * THE GLOBAL ON/OFF ("Malicious Traffic Detection")
 *
 * Disabled = the agent's GLOBAL simulation switch on: it keeps reading the
 * access log and raising alerts, and no scenario issues a ban. The saved
 * choice lives in platform_settings (traffic-detection-setting.ts) and is
 * re-applied by `ensureAgentSimulationDefault` at startup, so it survives the
 * ConfigMap being deleted and recreated. The per-scenario alert-only list is
 * preserved across a disable/enable cycle — see crowdsec-simulation-config.ts
 * for why that needs a second key.
 */

import * as k8s from '@kubernetes/client-node';
import type {
  CrowdsecLogSource,
  CrowdsecScenario,
  CrowdsecScenariosResponse,
  CrowdsecSetScenarioSimulationResponse,
  CrowdsecSetTrafficDetectionResponse,
} from '@insula/api-contracts';
import { AGENT_TARGET, cscliExec, findCrowdsecPodName, parseCscliJson } from './cscli-exec.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import {
  DEFAULT_SIMULATED_SCENARIOS,
  SIMULATION_CONFIGMAP_NAME,
  agentConfigUnchanged,
  simulationConfigMapData,
  simulationStateFromData,
  type SimulationState,
} from './crowdsec-simulation-config.js';

// Re-exported so existing importers keep one entry point for this feature.
export {
  ALERT_ONLY_LIST_KEY,
  DEFAULT_SIMULATED_SCENARIOS,
  SIMULATION_CONFIGMAP_KEY,
  SIMULATION_CONFIGMAP_NAME,
  parseAlertOnlyList,
  parseSimulationYaml,
  renderAlertOnlyList,
  renderSimulationYaml,
  simulationStateFromData,
} from './crowdsec-simulation-config.js';

export const AGENT_NAMESPACE = 'platform-system';
const AGENT_DAEMONSET_NAME = 'crowdsec-agent';

function createKubeConfig(kubeconfigPath: string | undefined): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromDefault();
  return kc;
}

function errorCode(err: unknown): number | undefined {
  return (err as { statusCode?: number; code?: number })?.statusCode
    ?? (err as { code?: number })?.code;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── ConfigMap access ───────────────────────────────────────────────────

async function readSimulationState(kc: k8s.KubeConfig): Promise<SimulationState | null> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  try {
    const cm = await core.readNamespacedConfigMap({
      name: SIMULATION_CONFIGMAP_NAME, namespace: AGENT_NAMESPACE,
    });
    return simulationStateFromData((cm as { data?: Record<string, string> }).data);
  } catch (err) {
    if (errorCode(err) === 404) return null;
    throw err;
  }
}

/** Create the ConfigMap. 'conflict' when another replica created it first. */
async function createSimulationConfigMap(
  kc: k8s.KubeConfig,
  alertOnly: readonly string[],
  detectionEnabled: boolean,
): Promise<'created' | 'conflict'> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  try {
    await core.createNamespacedConfigMap({
      namespace: AGENT_NAMESPACE,
      body: {
        metadata: {
          name: SIMULATION_CONFIGMAP_NAME,
          namespace: AGENT_NAMESPACE,
          labels: {
            'app.kubernetes.io/name': 'crowdsec-agent',
            'app.kubernetes.io/part-of': 'hosting-platform',
            'app.kubernetes.io/component': 'waf',
          },
          annotations: { 'kustomize.toolkit.fluxcd.io/reconcile': 'disabled' },
        },
        data: simulationConfigMapData(alertOnly, detectionEnabled),
      },
    });
    return 'created';
  } catch (err) {
    // HA boots 2-3 platform-api replicas together and every one runs the
    // startup ensure. Losing that race is success, not an error.
    if (errorCode(err) === 409) return 'conflict';
    throw err;
  }
}

/**
 * Write both keys. MERGE_PATCH, never replace: a full PUT would drop the
 * `reconcile: disabled` annotation that stops Flux reverting this very
 * setting. (Also not the SDK default: v1.4 sends `application/json-patch+json`
 * for every PATCH and the apiserver rejects a merge object with "cannot
 * unmarshal object into Go value of type []jsonPatchOp".)
 */
async function writeSimulationConfigMap(
  kc: k8s.KubeConfig,
  alertOnly: readonly string[],
  detectionEnabled: boolean,
): Promise<void> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  await core.patchNamespacedConfigMap(
    {
      name: SIMULATION_CONFIGMAP_NAME,
      namespace: AGENT_NAMESPACE,
      body: { data: simulationConfigMapData(alertOnly, detectionEnabled) },
    },
    MERGE_PATCH,
  );
}

/**
 * Roll the agent DaemonSet so it re-parses simulation.yaml.
 *
 * Deletes the pods rather than annotating the template: Flux treats a restart
 * annotation as git drift and scales the new generation back down, and the
 * DaemonSet controller recreates a deleted pod from the CURRENT template
 * immediately. Best effort — the config is already durable, so a failed roll
 * delays the change rather than losing it, and the caller reports that.
 */
async function rollAgent(kc: k8s.KubeConfig): Promise<number> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const pods = await (core as unknown as {
    listNamespacedPod: (args: { namespace: string; labelSelector: string }) => Promise<{
      items: { metadata?: { name?: string } }[];
    }>;
  }).listNamespacedPod({
    namespace: AGENT_NAMESPACE,
    labelSelector: `app.kubernetes.io/name=${AGENT_DAEMONSET_NAME}`,
  });
  let deleted = 0;
  for (const pod of pods.items ?? []) {
    const name = pod.metadata?.name;
    if (!name) continue;
    try {
      await core.deleteNamespacedPod({ name, namespace: AGENT_NAMESPACE });
      deleted += 1;
    } catch { /* swallow — a pod already gone is the state we wanted */ }
  }
  return deleted;
}

/**
 * Bring the ConfigMap to (alertOnly, detectionEnabled) and roll the agent when
 * — and only when — what the agent reads changed. Creates the ConfigMap if it
 * is absent. A roll failure is REPORTED, not thrown: the config is saved, and
 * an operator told "nothing happened" would toggle again.
 */
async function applySimulationConfig(
  kc: k8s.KubeConfig,
  current: SimulationState | null,
  alertOnly: readonly string[],
  detectionEnabled: boolean,
): Promise<{ rolledPods: number; rollError: string | null }> {
  const agentChanges = !agentConfigUnchanged(current, alertOnly, detectionEnabled);
  const created = !current
    && (await createSimulationConfigMap(kc, alertOnly, detectionEnabled)) === 'created';
  if (!created) await writeSimulationConfigMap(kc, alertOnly, detectionEnabled);
  if (!agentChanges) return { rolledPods: 0, rollError: null };
  try {
    return { rolledPods: await rollAgent(kc), rollError: null };
  } catch (err) {
    return { rolledPods: 0, rollError: errorMessage(err) };
  }
}

/**
 * Startup: create the ConfigMap if absent, and re-apply the operator's saved
 * on/off choice if the ConfigMap disagrees with it.
 *
 * `desiredEnabled` is the platform_settings value; null = never saved, in
 * which case an existing ConfigMap is left exactly as it is (an upgrading
 * cluster keeps what its agent runs) and a missing one gets the shipped
 * default. Never touches the per-scenario list, and never rolls the agent
 * when nothing changed — booting must not bounce it on every restart.
 */
export async function ensureAgentSimulationDefault(
  kubeconfigPath: string | undefined,
  desiredEnabled: boolean | null,
): Promise<'created' | 'present' | 'reconciled'> {
  const kc = createKubeConfig(kubeconfigPath);
  const existing = await readSimulationState(kc);
  if (!existing) {
    const result = await createSimulationConfigMap(
      kc, DEFAULT_SIMULATED_SCENARIOS, desiredEnabled ?? true,
    );
    return result === 'created' ? 'created' : 'present';
  }
  if (desiredEnabled === null || existing.globalSimulation === !desiredEnabled) return 'present';
  await applySimulationConfig(kc, existing, existing.alertOnly, desiredEnabled);
  return 'reconciled';
}

// ─── cscli readers ──────────────────────────────────────────────────────

interface RawScenarioRow {
  name?: string;
  description?: string;
  status?: string;
}

/**
 * `cscli scenarios list -o json` emits `{ "scenarios": [...] }` on v1.7 but a
 * bare array on older builds. Accept both — this is read-only display data and
 * an empty list here would read as "no detection running", which is the most
 * misleading thing this endpoint could say.
 */
function extractScenarioRows(parsed: unknown): RawScenarioRow[] {
  if (Array.isArray(parsed)) return parsed as RawScenarioRow[];
  const wrapped = (parsed as { scenarios?: unknown })?.scenarios;
  return Array.isArray(wrapped) ? wrapped as RawScenarioRow[] : [];
}

/**
 * `cscli metrics show scenarios -o json` →
 *   { "scenarios": { "<name>": { pour, overflow, underflow, ... } } }
 *
 * `pour` counts events that entered the scenario's buckets; `overflow` counts
 * buckets that tripped, i.e. alerts raised. Both are since the AGENT started,
 * not lifetime — a freshly rolled agent reports zeros for everything, which is
 * why the UI labels them "since the agent last started" rather than implying a
 * total.
 */
function extractScenarioMetrics(parsed: unknown): Map<string, { poured: number; alerts: number }> {
  const out = new Map<string, { poured: number; alerts: number }>();
  const tree = (parsed as { scenarios?: Record<string, Record<string, unknown>> })?.scenarios;
  if (!tree || typeof tree !== 'object') return out;
  for (const [name, counters] of Object.entries(tree)) {
    const num = (k: string) => {
      const v = Number((counters as Record<string, unknown>)?.[k]);
      return Number.isFinite(v) && v >= 0 ? v : 0;
    };
    out.set(name, { poured: num('pour'), alerts: num('overflow') });
  }
  return out;
}

// ─── Public surface ─────────────────────────────────────────────────────

// ─── Public surface ─────────────────────────────────────────────────────

/**
 * List the scenarios the agent has loaded, with the operator's per-scenario
 * choice, the global switch, and real activity counters.
 *
 * Never throws for a cluster-side problem: an operator opening the WAF settings
 * while the agent is rolling should see "could not reach the agent", not a
 * broken page and not an empty list that reads as "nothing is running". The
 * ConfigMap is read even when the agent is unreachable, so the on/off switch
 * still reports the truth — disabling detection is exactly what an operator
 * may want while the agent misbehaves.
 *
 * `desiredEnabled` is the saved on/off choice (null = never saved).
 */
export async function listScenarios(
  kubeconfigPath: string | undefined,
  desiredEnabled: boolean | null,
): Promise<CrowdsecScenariosResponse> {
  const kc = createKubeConfig(kubeconfigPath);
  // An unreadable ConfigMap falls back to the shipped default instead of
  // failing the page, as before; reaching the agent is what reports errors.
  const state = await readSimulationState(kc).catch(() => null);
  const globalSimulation = state?.globalSimulation ?? false;
  const alertOnly = new Set(state?.alertOnly ?? DEFAULT_SIMULATED_SCENARIOS);
  const base: CrowdsecScenariosResponse = {
    scenarios: [],
    globalSimulation,
    detectionEnabled: desiredEnabled ?? !globalSimulation,
    logSources: [],
    error: null,
  };

  let podName: string;
  try {
    podName = await findCrowdsecPodName(kc, AGENT_TARGET);
  } catch (err) {
    return { ...base, error: errorMessage(err) };
  }

  const [listRes, metricsRes, acquisRes] = await Promise.allSettled([
    cscliExec(kc, podName, ['scenarios', 'list', '-o', 'json'], AGENT_TARGET),
    cscliExec(kc, podName, ['metrics', 'show', 'scenarios', '-o', 'json'], AGENT_TARGET),
    readAcquisitionSources(kc, podName),
  ]);

  if (listRes.status !== 'fulfilled') {
    return { ...base, error: errorMessage(listRes.reason) };
  }

  let rows: RawScenarioRow[] = [];
  try {
    rows = extractScenarioRows(parseCscliJson<unknown>(listRes.value.stdout));
  } catch (err) {
    return { ...base, error: errorMessage(err) };
  }

  const metrics = metricsRes.status === 'fulfilled'
    ? (() => {
      try { return extractScenarioMetrics(parseCscliJson<unknown>(metricsRes.value.stdout)); }
      catch { return new Map<string, { poured: number; alerts: number }>(); }
    })()
    : new Map<string, { poured: number; alerts: number }>();

  const scenarios: CrowdsecScenario[] = rows
    .filter((r) => typeof r.name === 'string' && r.name.length > 0)
    .map((r) => {
      const name = String(r.name);
      const m = metrics.get(name);
      return {
        name,
        description: String(r.description ?? ''),
        status: String(r.status ?? ''),
        simulated: alertOnly.has(name),
        eventsPoured: m?.poured ?? 0,
        alertsRaised: m?.alerts ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    ...base,
    scenarios,
    logSources: acquisRes.status === 'fulfilled' ? acquisRes.value : [],
  };
}

/**
 * The agent's acquisition sources.
 *
 * `cscli metrics show acquisition -o json` keys by the datasource string the
 * agent actually opened, which is the truth we want — it reflects what the
 * process is reading, not what a file on disk asks for.
 */
async function readAcquisitionSources(
  kc: k8s.KubeConfig, podName: string,
): Promise<CrowdsecLogSource[]> {
  try {
    const { stdout } = await cscliExec(
      kc, podName, ['metrics', 'show', 'acquisition', '-o', 'json'], AGENT_TARGET,
    );
    const parsed = parseCscliJson<{ acquisition?: Record<string, unknown> }>(stdout);
    const tree = parsed?.acquisition ?? {};
    const out: CrowdsecLogSource[] = [];
    for (const key of Object.keys(tree)) {
      // Keys look like "file:/var/log/traefik/access.log".
      const idx = key.indexOf(':');
      out.push(idx === -1
        ? { type: 'unknown', source: key }
        : { type: key.slice(0, idx), source: key.slice(idx + 1) });
    }
    return out.sort((a, b) => a.source.localeCompare(b.source));
  } catch {
    return [];
  }
}


/**
 * Simulate (alert-only) or enforce one scenario.
 *
 * The name is validated against what the agent REPORTS, not against a regex.
 * cscli accepts an exclusion naming a scenario that does not exist and echoes
 * it straight back, so a typo produces a config that looks correct while the
 * real scenario keeps banning — exactly what shipped on DEV with a
 * hyphen in place of the underscore in `http-crawl-non_statics`.
 *
 * The global on/off is kept as the agent runs it: a per-scenario change never
 * re-enables (or disables) detection as a side effect. While detection is
 * disabled the change only updates the stashed list — the agent file stays
 * "everything simulated" and the agent is not rolled.
 */
export async function setScenarioSimulation(
  kubeconfigPath: string | undefined,
  name: string,
  simulated: boolean,
  desiredEnabled: boolean | null,
): Promise<CrowdsecSetScenarioSimulationResponse> {
  const kc = createKubeConfig(kubeconfigPath);
  const known = await listScenarios(kubeconfigPath, desiredEnabled);
  if (known.error) {
    throw new Error(`cannot reach the CrowdSec agent to validate the scenario name: ${known.error}`);
  }
  if (!known.scenarios.some((s) => s.name === name)) {
    throw new Error(
      `unknown scenario "${name}" — the agent reports ${known.scenarios.length} scenario(s) `
      + 'and cscli silently accepts names that do not exist, so this is rejected here',
    );
  }

  const current = await readSimulationState(kc);
  const set = new Set(current?.alertOnly ?? DEFAULT_SIMULATED_SCENARIOS);
  if (simulated) set.add(name); else set.delete(name);
  const next = [...set].sort();
  const detectionEnabled = current ? !current.globalSimulation : (desiredEnabled ?? true);

  const roll = await applySimulationConfig(kc, current, next, detectionEnabled);
  return { simulated: next, ...roll };
}

/**
 * Turn Malicious Traffic Detection on or off on the agent.
 *
 * Off = `simulation: true` with no exclusions: every scenario keeps raising
 * alerts and none bans. The per-scenario list is carried over untouched, so
 * re-enabling restores exactly the exclusions that were in force before.
 * The caller persists the choice in platform_settings FIRST, so a failure
 * here is re-applied at the next startup rather than forgotten.
 */
export async function setTrafficDetectionEnabled(
  kubeconfigPath: string | undefined,
  enabled: boolean,
): Promise<CrowdsecSetTrafficDetectionResponse> {
  const kc = createKubeConfig(kubeconfigPath);
  const current = await readSimulationState(kc);
  const alertOnly = [...(current?.alertOnly ?? DEFAULT_SIMULATED_SCENARIOS)].sort();
  const roll = await applySimulationConfig(kc, current, alertOnly, enabled);
  return { enabled, alertOnly, ...roll };
}
