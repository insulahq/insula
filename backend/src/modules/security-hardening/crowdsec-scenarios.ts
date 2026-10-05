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
import { DEFAULT_SIMULATED_SCENARIOS } from './crowdsec-simulation-config.js';
import {
  convergeDetection,
  errorMessage,
  readSnapshot,
  updateAlertOnly,
} from './crowdsec-simulation-store.js';

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
export {
  AGENT_NAMESPACE,
  MAX_CAS_ATTEMPTS,
  SimulationConfigConflictError,
} from './crowdsec-simulation-store.js';

function createKubeConfig(kubeconfigPath: string | undefined): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromDefault();
  return kc;
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

/** What the agent itself reports — everything except the per-scenario modes. */
interface AgentListing {
  readonly scenarios: ReadonlyArray<Omit<CrowdsecScenario, 'simulated'>>;
  readonly logSources: CrowdsecLogSource[];
}

/**
 * The last listing the agent reported (per replica), served while it restarts.
 *
 * Every config change deletes the agent pods, and a DaemonSet only creates the
 * replacement once the old pod is gone — so for some seconds after each toggle
 * there is no agent to ask. Without this, the list refetched right after a
 * toggle came back empty and the NEXT toggle failed its name validation: two
 * changes in a row were impossible. The window is seconds; LAST_LISTING_MAX_AGE_MS
 * is long enough to cover it and short enough that a real outage still shows
 * as one instead of as a stale list.
 */
export const LAST_LISTING_MAX_AGE_MS = 3 * 60_000;
let lastListing: { readonly listing: AgentListing; readonly at: number } | null = null;

/** Test hook: forget the cached listing. */
export function resetLastListingForTests(): void {
  lastListing = null;
}

async function readAgentListing(kc: k8s.KubeConfig): Promise<AgentListing> {
  const podName = await findCrowdsecPodName(kc, AGENT_TARGET);
  const [listRes, metricsRes, acquisRes] = await Promise.allSettled([
    cscliExec(kc, podName, ['scenarios', 'list', '-o', 'json'], AGENT_TARGET),
    cscliExec(kc, podName, ['metrics', 'show', 'scenarios', '-o', 'json'], AGENT_TARGET),
    readAcquisitionSources(kc, podName),
  ]);
  if (listRes.status !== 'fulfilled') throw listRes.reason;
  const rows = extractScenarioRows(parseCscliJson<unknown>(listRes.value.stdout));

  const metrics = metricsRes.status === 'fulfilled'
    ? (() => {
      try { return extractScenarioMetrics(parseCscliJson<unknown>(metricsRes.value.stdout)); }
      catch { return new Map<string, { poured: number; alerts: number }>(); }
    })()
    : new Map<string, { poured: number; alerts: number }>();

  const scenarios = rows
    .filter((r) => typeof r.name === 'string' && r.name.length > 0)
    .map((r) => {
      const name = String(r.name);
      const m = metrics.get(name);
      return {
        name,
        description: String(r.description ?? ''),
        status: String(r.status ?? ''),
        eventsPoured: m?.poured ?? 0,
        alertsRaised: m?.alerts ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { scenarios, logSources: acquisRes.status === 'fulfilled' ? acquisRes.value : [] };
}

/**
 * List the scenarios the agent has loaded, with the operator's per-scenario
 * choice, the global switch, and real activity counters.
 *
 * Never throws for a cluster-side problem: an operator opening the WAF settings
 * while the agent is rolling should see the list it reported moments ago
 * (flagged `cachedAt`), or "could not reach the agent" — not a broken page and
 * not an empty list that reads as "nothing is running". The modes and the
 * on/off switch always come from the ConfigMap, read even when the agent is
 * unreachable — disabling detection is exactly what an operator may want while
 * the agent misbehaves.
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
  const state = await readSnapshot(kc).then((snap) => snap?.state ?? null, () => null);
  const globalSimulation = state?.globalSimulation ?? false;
  const alertOnly = new Set(state?.alertOnly ?? DEFAULT_SIMULATED_SCENARIOS);
  const base: CrowdsecScenariosResponse = {
    scenarios: [],
    globalSimulation,
    detectionEnabled: desiredEnabled ?? !globalSimulation,
    logSources: [],
    error: null,
    cachedAt: null,
  };
  const withModes = (listing: AgentListing): Pick<CrowdsecScenariosResponse, 'scenarios' | 'logSources'> => ({
    scenarios: listing.scenarios.map((s) => ({ ...s, simulated: alertOnly.has(s.name) })),
    logSources: [...listing.logSources],
  });

  try {
    const listing = await readAgentListing(kc);
    lastListing = { listing, at: Date.now() };
    return { ...base, ...withModes(listing) };
  } catch (err) {
    if (lastListing && Date.now() - lastListing.at <= LAST_LISTING_MAX_AGE_MS) {
      return { ...base, ...withModes(lastListing.listing), cachedAt: new Date(lastListing.at).toISOString() };
    }
    return { ...base, error: errorMessage(err) };
  }
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
 * The write is compare-and-swap (crowdsec-simulation-store.ts): a concurrent
 * toggle of ANOTHER scenario is re-read and kept, never overwritten. The
 * global on/off is kept as the agent runs it — a per-scenario change never
 * re-enables or disables detection as a side effect. While detection is
 * disabled the change only updates the stashed list and the agent is not
 * rolled. `readDesired` (the saved on/off) is consulted only when the
 * ConfigMap has to be created. Throws SimulationConfigConflictError when
 * every attempt lost to a concurrent writer.
 */
export async function setScenarioSimulation(
  kubeconfigPath: string | undefined,
  name: string,
  simulated: boolean,
  readDesired: () => Promise<boolean | null>,
): Promise<CrowdsecSetScenarioSimulationResponse> {
  const kc = createKubeConfig(kubeconfigPath);
  const known = await listScenarios(kubeconfigPath, null);
  if (known.error) {
    throw new Error(`cannot reach the CrowdSec agent to validate the scenario name: ${known.error}`);
  }
  if (!known.scenarios.some((s) => s.name === name)) {
    throw new Error(
      `unknown scenario "${name}" — the agent reports ${known.scenarios.length} scenario(s) `
      + 'and cscli silently accepts names that do not exist, so this is rejected here',
    );
  }
  return updateAlertOnly(kc, name, simulated, readDesired);
}

/**
 * Apply the SAVED Malicious Traffic Detection on/off to the agent.
 *
 * Off = `simulation: true` with no exclusions: every scenario keeps raising
 * alerts and none bans. The per-scenario list is carried over untouched, so
 * re-enabling restores exactly the exclusions that were in force before.
 *
 * The caller saves the choice to platform_settings FIRST and passes a reader
 * for it; this applies whatever is saved at write time (so of two racing
 * toggles the later SAVE wins on the agent too), and always writes — that
 * write invalidates any concurrent startup re-apply that read the old value.
 * A failure here is re-applied at the next startup rather than forgotten.
 */
export async function setTrafficDetectionEnabled(
  kubeconfigPath: string | undefined,
  readDesired: () => Promise<boolean | null>,
): Promise<CrowdsecSetTrafficDetectionResponse> {
  const kc = createKubeConfig(kubeconfigPath);
  const out = await convergeDetection(kc, readDesired, { touch: true });
  return {
    enabled: out.enabled,
    alertOnly: [...out.alertOnly].sort(),
    rolledPods: out.rolledPods,
    rollError: out.rollError,
  };
}

/**
 * Startup: create the ConfigMap if absent, and re-apply the operator's saved
 * on/off choice if the ConfigMap disagrees with it.
 *
 * `readDesired` reads platform_settings (null = never saved) and is called
 * again right before every write, after the ConfigMap read — so a toggle
 * that lands on another replica during a rolling deploy is never overwritten
 * with this replica's boot-time value (see convergeDetection). Never saved
 * leaves an existing ConfigMap exactly as it is. Never touches the
 * per-scenario list, and never writes or rolls the agent when nothing changed.
 */
export async function ensureAgentSimulationDefault(
  kubeconfigPath: string | undefined,
  readDesired: () => Promise<boolean | null>,
): Promise<'created' | 'present' | 'reconciled'> {
  const kc = createKubeConfig(kubeconfigPath);
  return (await convergeDetection(kc, readDesired, { touch: false })).outcome;
}
