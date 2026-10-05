/**
 * The content of the backend-owned `crowdsec-agent-simulation` ConfigMap —
 * pure rendering and parsing, no cluster access (that is crowdsec-scenarios.ts).
 *
 * TWO KEYS, AND WHY
 *
 *   simulation.yaml       — what the agent reads (subPath-mounted, so it is
 *                           the ONLY key the agent sees).
 *   alert-only-scenarios  — the operator's per-scenario alert-only list.
 *
 * CrowdSec INVERTS `exclusions` with the global switch. With `simulation:
 * false` the listed scenarios are simulated (alert, no ban); with
 * `simulation: true` the listed scenarios are the ones that still BAN. So
 * "disable Malicious Traffic Detection" (every scenario alert-only) must write
 * `simulation: true` with NO exclusions — keeping the per-scenario list in
 * place would arm exactly the scenarios the operator marked alert-only. The
 * list is therefore stashed in its own key while disabled and written back as
 * `exclusions` on re-enable.
 */

export const SIMULATION_CONFIGMAP_NAME = 'crowdsec-agent-simulation';
export const SIMULATION_CONFIGMAP_KEY = 'simulation.yaml';
export const ALERT_ONLY_LIST_KEY = 'alert-only-scenarios';

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

function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

/**
 * Render the agent's simulation.yaml.
 *
 * Enabled: `simulation: false` (the GLOBAL switch, off) and the alert-only
 * scenarios as `exclusions` — which, with the switch off, are the simulated
 * ones. Disabled: `simulation: true` and an EMPTY exclusions list, so every
 * scenario is simulated. The inversion is CrowdSec's and easy to misread,
 * which is why the file carries the explanation.
 */
export function renderSimulationYaml(alertOnly: readonly string[], detectionEnabled: boolean): string {
  const lines = ['# MANAGED BY THE PLATFORM — edit via Security → Web Defense → WAF Settings.', '#'];
  if (!detectionEnabled) {
    lines.push(
      '# MALICIOUS TRAFFIC DETECTION IS DISABLED. `simulation: true` is the GLOBAL',
      '# switch: EVERY scenario runs in SIMULATION — alerts are still raised, no',
      '# ban is issued. With the switch on, `exclusions` would list scenarios that',
      '# DO ban, so it is empty on purpose. The per-scenario alert-only list is',
      `# kept under the \`${ALERT_ONLY_LIST_KEY}\` key of this ConfigMap and is`,
      '# restored when detection is enabled again.',
      '#',
      '# The agent parses this file ONCE at startup; the platform rolls it for you.',
      'simulation: true',
      'exclusions: []',
    );
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    '# `simulation: false` is the GLOBAL switch. With it off, everything in',
    '# `exclusions` is INVERTED and therefore runs in SIMULATION: those scenarios',
    '# still raise alerts (visible in the ban table and `cscli alerts list`) but',
    '# issue no ban. Anything not listed here enforces.',
    '#',
    '# The agent parses this file ONCE at startup, so a change here only takes',
    '# effect when the DaemonSet rolls. The platform rolls it for you.',
    'simulation: false',
  );
  const unique = sortedUnique(alertOnly);
  if (unique.length === 0) {
    lines.push('exclusions: []');
  } else {
    lines.push('exclusions:');
    for (const name of unique) lines.push(`  - ${name}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Pull the global switch and the exclusions back out of simulation.yaml.
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

/** The stash key: one scenario name per line. */
export function renderAlertOnlyList(names: readonly string[]): string {
  const lines = [
    '# MANAGED BY THE PLATFORM. Scenarios the operator set to alert-only. While',
    '# Malicious Traffic Detection is enabled these are the `exclusions` in',
    `# ${SIMULATION_CONFIGMAP_KEY}; while it is disabled they wait here.`,
    ...sortedUnique(names),
  ];
  return `${lines.join('\n')}\n`;
}

export function parseAlertOnlyList(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of (text ?? '').split('\n')) {
    const name = rawLine.replace(/#.*$/, '').trim().replace(/^-\s*/, '');
    if (name) out.push(name);
  }
  return sortedUnique(out);
}

export interface SimulationState {
  /** The agent file's global switch. true = every scenario simulated. */
  readonly globalSimulation: boolean;
  /** The agent file's `exclusions`, exactly as written (meaning depends on the switch). */
  readonly agentExclusions: readonly string[];
  /** The operator's per-scenario alert-only list. */
  readonly alertOnly: readonly string[];
}

/**
 * Read the ConfigMap's data into a state, or null when the agent file is
 * missing (the caller treats that as "the ConfigMap is absent").
 *
 * With the switch OFF the agent file is the truth — that is what runs, even if
 * someone hand-edited it past a stale stash. With it ON the exclusions say
 * nothing about the per-scenario choice, so the stash is read; a hand-set
 * switch with no stash falls back to the shipped default.
 */
export function simulationStateFromData(
  data: Readonly<Record<string, string>> | undefined,
): SimulationState | null {
  const raw = data?.[SIMULATION_CONFIGMAP_KEY];
  if (typeof raw !== 'string') return null;
  const parsed = parseSimulationYaml(raw);
  const agentExclusions = sortedUnique(parsed.simulated);
  if (!parsed.global) return { globalSimulation: false, agentExclusions, alertOnly: agentExclusions };
  const stash = data?.[ALERT_ONLY_LIST_KEY];
  return {
    globalSimulation: true,
    agentExclusions,
    alertOnly: typeof stash === 'string' ? parseAlertOnlyList(stash) : [...DEFAULT_SIMULATED_SCENARIOS],
  };
}

/** Both keys, rendered for a write. */
export function simulationConfigMapData(
  alertOnly: readonly string[],
  detectionEnabled: boolean,
): Record<string, string> {
  return {
    [SIMULATION_CONFIGMAP_KEY]: renderSimulationYaml(alertOnly, detectionEnabled),
    [ALERT_ONLY_LIST_KEY]: renderAlertOnlyList(alertOnly),
  };
}

/**
 * Would the agent run the same thing? Compared semantically — the global
 * switch plus the exclusions it would read — so a comment-only difference in
 * an older file does not bounce the agent.
 */
export function agentConfigUnchanged(
  current: SimulationState | null,
  alertOnly: readonly string[],
  detectionEnabled: boolean,
): boolean {
  if (!current) return false;
  if (current.globalSimulation !== !detectionEnabled) return false;
  const wanted = detectionEnabled ? sortedUnique(alertOnly) : [];
  return current.agentExclusions.join('\n') === wanted.join('\n');
}
