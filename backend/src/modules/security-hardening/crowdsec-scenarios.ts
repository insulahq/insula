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
 */

import * as k8s from '@kubernetes/client-node';
import type {
  CrowdsecLogSource,
  CrowdsecScenario,
  CrowdsecScenariosResponse,
} from '@insula/api-contracts';
import { AGENT_TARGET, cscliExec, findCrowdsecPodName, parseCscliJson } from './cscli-exec.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';

export const AGENT_NAMESPACE = 'platform-system';
export const SIMULATION_CONFIGMAP_NAME = 'crowdsec-agent-simulation';
export const SIMULATION_CONFIGMAP_KEY = 'simulation.yaml';
const AGENT_DAEMONSET_NAME = 'crowdsec-agent';

/**
 * Scenarios that ship simulated on a cluster that has never used this switch.
 *
 * NOTE THE UNDERSCORE in `non_statics`. The hub scenario is
 * crowdsecurity/http-crawl-non_statics while every piece of documentation —
 * including CrowdSec's own — writes it with a hyphen. cscli does NOT validate
 * these names: an exclusion naming a scenario that does not exist is accepted
 * silently and `cscli simulation status` echoes it back, so the config LOOKS
 * correct while the real scenario runs live and bans. That exact bug shipped on
 * DEV, which is why `setScenarioSimulation` rejects any name the
 * agent does not report.
 *
 * Why this one: the bouncer sits on the shared `websecure` entrypoint, so a
 * decision is CLUSTER-WIDE — one false positive blocks that IP from every
 * protected tenant site. On a multi-tenant host "many non-static requests from
 * one IP" is also an accurate description of a legitimate search-engine
 * crawler.
 */
export const DEFAULT_SIMULATED_SCENARIOS: readonly string[] = [
  'crowdsecurity/http-crawl-non_statics',
];

function createKubeConfig(kubeconfigPath: string | undefined): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromDefault();
  return kc;
}

function isNotFound(err: unknown): boolean {
  const code = (err as { statusCode?: number; code?: number })?.statusCode
    ?? (err as { code?: number })?.code;
  return code === 404;
}

// ─── simulation.yaml rendering + parsing ────────────────────────────────

/**
 * Render the agent's simulation.yaml from a list of simulated scenarios.
 *
 * `simulation: false` is the GLOBAL switch and stays off; with it off the
 * `exclusions` list is the set of scenarios that ARE simulated. That inversion
 * is CrowdSec's, it is easy to misread, and it is why the file carries the
 * explanation rather than the operator having to remember it.
 */
export function renderSimulationYaml(simulated: readonly string[]): string {
  const lines = [
    '# MANAGED BY THE PLATFORM — edit via Security → Web Defense → WAF Settings.',
    '#',
    '# `simulation: false` is the GLOBAL switch. With it off, everything in',
    '# `exclusions` is INVERTED and therefore runs in SIMULATION: those scenarios',
    '# still raise alerts (visible in the ban table and `cscli alerts list`) but',
    '# issue no ban. Anything not listed here enforces.',
    '#',
    '# The agent parses this file ONCE at startup, so a change here only takes',
    '# effect when the DaemonSet rolls. The platform rolls it for you.',
    'simulation: false',
  ];
  const unique = [...new Set(simulated)].sort();
  if (unique.length === 0) {
    lines.push('exclusions: []');
  } else {
    lines.push('exclusions:');
    for (const name of unique) lines.push(`  - ${name}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Pull the simulated-scenario names back out of simulation.yaml.
 *
 * Deliberately a line scanner rather than a YAML parse: the backend has no YAML
 * dependency, the file shape is ours, and a scanner cannot throw on a file an
 * operator hand-edited into something slightly odd — it just finds fewer names,
 * which the UI then shows as "enforcing" rather than crashing the page.
 */
export function parseSimulationYaml(text: string): { global: boolean; simulated: string[] } {
  const simulated: string[] = [];
  let global = false;
  let inExclusions = false;
  for (const rawLine of (text ?? '').split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const globalMatch = /^simulation:\s*(true|false)\s*$/.exec(line.trim());
    if (globalMatch) {
      global = globalMatch[1] === 'true';
      inExclusions = false;
      continue;
    }
    if (/^exclusions:\s*(\[\s*\])?\s*$/.test(line.trim())) {
      inExclusions = true;
      continue;
    }
    if (inExclusions) {
      const item = /^\s*-\s*(\S+)\s*$/.exec(line);
      if (item) { simulated.push(item[1]); continue; }
      // A non-list line ends the block.
      if (!/^\s/.test(line)) inExclusions = false;
    }
  }
  return { global, simulated };
}

// ─── ConfigMap access ───────────────────────────────────────────────────

async function readSimulationConfigMap(
  kc: k8s.KubeConfig,
): Promise<{ global: boolean; simulated: string[] } | null> {
  const core = kc.makeApiClient(k8s.CoreV1Api);
  try {
    const cm = await core.readNamespacedConfigMap({
      name: SIMULATION_CONFIGMAP_NAME, namespace: AGENT_NAMESPACE,
    });
    const raw = (cm as { data?: Record<string, string> }).data?.[SIMULATION_CONFIGMAP_KEY];
    if (typeof raw !== 'string') return null;
    return parseSimulationYaml(raw);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Create the simulation ConfigMap with the shipped default if it is absent.
 *
 * Called at startup. Idempotent, and it never overwrites an existing object —
 * doing so would silently undo every operator toggle on each API restart.
 */
export async function ensureAgentSimulationDefault(
  kubeconfigPath: string | undefined,
): Promise<'created' | 'present'> {
  const kc = createKubeConfig(kubeconfigPath);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const existing = await readSimulationConfigMap(kc);
  if (existing) return 'present';
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
      data: { [SIMULATION_CONFIGMAP_KEY]: renderSimulationYaml(DEFAULT_SIMULATED_SCENARIOS) },
    },
  });
  return 'created';
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

/**
 * List the scenarios the agent has loaded, with their simulation state and
 * real activity counters.
 *
 * Never throws for a cluster-side problem: an operator opening the WAF settings
 * while the agent is rolling should see "could not reach the agent", not a
 * broken page and not an empty list that reads as "nothing is running".
 */
export async function listScenarios(
  kubeconfigPath: string | undefined,
): Promise<CrowdsecScenariosResponse> {
  const kc = createKubeConfig(kubeconfigPath);
  const empty: CrowdsecScenariosResponse = {
    scenarios: [], globalSimulation: false, logSources: [], error: null,
  };
  let podName: string;
  try {
    podName = await findCrowdsecPodName(kc, AGENT_TARGET);
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }

  const [listRes, metricsRes, acquisRes, cmRes] = await Promise.allSettled([
    cscliExec(kc, podName, ['scenarios', 'list', '-o', 'json'], AGENT_TARGET),
    cscliExec(kc, podName, ['metrics', 'show', 'scenarios', '-o', 'json'], AGENT_TARGET),
    readAcquisitionSources(kc, podName),
    readSimulationConfigMap(kc),
  ]);

  if (listRes.status !== 'fulfilled') {
    return {
      ...empty,
      error: listRes.reason instanceof Error ? listRes.reason.message : String(listRes.reason),
    };
  }

  let rows: RawScenarioRow[] = [];
  try {
    rows = extractScenarioRows(parseCscliJson<unknown>(listRes.value.stdout));
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }

  const metrics = metricsRes.status === 'fulfilled'
    ? (() => {
      try { return extractScenarioMetrics(parseCscliJson<unknown>(metricsRes.value.stdout)); }
      catch { return new Map<string, { poured: number; alerts: number }>(); }
    })()
    : new Map<string, { poured: number; alerts: number }>();

  const sim = cmRes.status === 'fulfilled' && cmRes.value
    ? cmRes.value
    : { global: false, simulated: [...DEFAULT_SIMULATED_SCENARIOS] };
  const simulatedSet = new Set(sim.simulated);

  const scenarios: CrowdsecScenario[] = rows
    .filter((r) => typeof r.name === 'string' && r.name.length > 0)
    .map((r) => {
      const name = String(r.name);
      const m = metrics.get(name);
      return {
        name,
        description: String(r.description ?? ''),
        status: String(r.status ?? ''),
        simulated: simulatedSet.has(name),
        eventsPoured: m?.poured ?? 0,
        alertsRaised: m?.alerts ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    scenarios,
    globalSimulation: sim.global,
    logSources: acquisRes.status === 'fulfilled' ? acquisRes.value : [],
    error: null,
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
 */
export async function setScenarioSimulation(
  kubeconfigPath: string | undefined,
  name: string,
  simulated: boolean,
): Promise<{ simulated: string[]; rolledPods: number; rollError: string | null }> {
  const kc = createKubeConfig(kubeconfigPath);
  const known = await listScenarios(kubeconfigPath);
  if (known.error) {
    throw new Error(`cannot reach the CrowdSec agent to validate the scenario name: ${known.error}`);
  }
  if (!known.scenarios.some((s) => s.name === name)) {
    throw new Error(
      `unknown scenario "${name}" — the agent reports ${known.scenarios.length} scenario(s) `
      + 'and cscli silently accepts names that do not exist, so this is rejected here',
    );
  }

  const current = await readSimulationConfigMap(kc);
  const set = new Set(current?.simulated ?? DEFAULT_SIMULATED_SCENARIOS);
  if (simulated) set.add(name); else set.delete(name);
  const next = [...set].sort();

  const core = kc.makeApiClient(k8s.CoreV1Api);
  const body = { data: { [SIMULATION_CONFIGMAP_KEY]: renderSimulationYaml(next) } };
  // Create first if the ConfigMap is absent — a PATCH cannot create it, and an
  // absent one means this cluster has not booted the current API yet.
  if (!current) await ensureAgentSimulationDefault(kubeconfigPath);
  // MERGE_PATCH, not the SDK default: v1.4 sends `application/json-patch+json`
  // for every PATCH regardless of body shape, and the apiserver rejects a merge
  // object with "cannot unmarshal object into Go value of type []jsonPatchOp".
  await core.patchNamespacedConfigMap(
    { name: SIMULATION_CONFIGMAP_NAME, namespace: AGENT_NAMESPACE, body },
    MERGE_PATCH,
  );

  // The file is durable now; the roll is what makes it live. Report a failure
  // instead of throwing, so the operator learns the change is saved but pending
  // rather than believing nothing happened and toggling again.
  let rolledPods = 0;
  let rollError: string | null = null;
  try {
    rolledPods = await rollAgent(kc);
  } catch (err) {
    rollError = err instanceof Error ? err.message : String(err);
  }
  return { simulated: next, rolledPods, rollError };
}
