/**
 * Turning CrowdSec's internal vocabulary into something an operator can act on.
 *
 * Pure functions, separated from the table so the parts that were actually
 * WRONG can be tested without rendering: what a row is labelled, what its
 * reason says, and how many rows one IP produces.
 *
 * The three complaints this answers, all from the same production table:
 *
 *   1. The Origin column printed `crowdsec`, which reads as a third-party
 *      product. Those rows are THIS platform's own log-processing agent.
 *   2. Only the WAF engine got an "auto-ban" pill, because the pill was a
 *      prefix check on a scenario string. The agent's bans are equally
 *      automatic and looked like they had no provenance at all.
 *   3. One IP produced one row PER SCENARIO — 192.236.217.91 held seven — and
 *      each row said `crowdsecurity/http-sensitive-files` with nothing about
 *      what that means or how the ban came to exist.
 */
import type { CrowdsecAddedBy, CrowdsecDecision, CrowdsecScenario } from '@insula/api-contracts';

export interface AddedByMeta {
  /** Column text. */
  readonly label: string;
  /** Tailwind classes for the pill, light + dark. */
  readonly cls: string;
  /** Hover text — says which engine, in one sentence. */
  readonly title: string;
  /** True for the two engines that act without a human. */
  readonly automatic: boolean;
}

const ADDED_BY: Record<CrowdsecAddedBy, AddedByMeta> = {
  operator: {
    label: 'Operator',
    cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    title: 'A human added this ban from this panel.',
    automatic: false,
  },
  'static-list': {
    label: 'Static list',
    cls: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
    title: 'A human added this to the long-term static blocklist. It does not expire on its own.',
    automatic: false,
  },
  'auto-ban-waf': {
    label: 'Auto · WAF',
    cls: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
    title: 'The auto-ban scheduler, from ModSecurity rule hits on this platform’s own hosts.',
    automatic: true,
  },
  'auto-ban-traffic': {
    label: 'Auto · Traffic',
    cls: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
    title: 'This platform’s CrowdSec agent, from behaviour in the ingress access log.',
    automatic: true,
  },
  community: {
    label: 'Community feed',
    cls: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    title: 'CrowdSec’s shared threat feed. Decided elsewhere, on evidence you cannot inspect.',
    automatic: true,
  },
  external: {
    label: 'External',
    cls: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    title: 'Added outside this panel — a console blocklist, a third-party list, or cscli on the host.',
    automatic: true,
  },
};

export function addedByMeta(addedBy: CrowdsecAddedBy): AddedByMeta {
  return ADDED_BY[addedBy] ?? ADDED_BY.external;
}

/**
 * The WAF scheduler encodes its evidence in the scenario string:
 *
 *   admin-panel:autoban-scheduler:auto-ban:rules 920250,920540,932140 count 20
 *
 * That is genuinely the useful part — which rules, how many hits — and it was
 * being rendered as one truncated monospace blob.
 */
export interface WafAutoBanEvidence {
  readonly ruleIds: readonly string[];
  readonly eventCount: number | null;
}

export function parseWafAutoBanScenario(scenario: string): WafAutoBanEvidence | null {
  if (!scenario.includes('autoban-scheduler')) return null;
  const rules = /rules\s+([0-9,\s]+?)(?:\s+count|$)/.exec(scenario);
  const count = /count\s+(\d+)/.exec(scenario);
  const ruleIds = rules
    ? rules[1].split(',').map((r) => r.trim()).filter((r) => /^\d+$/.test(r))
    : [];
  return { ruleIds, eventCount: count ? Number(count[1]) : null };
}

/**
 * A one-line, plain-English reason.
 *
 * `scenarioDescriptions` comes from the agent's own hub metadata, so the copy
 * is the upstream author's rather than a guess maintained here. When it is
 * missing — the agent is unreachable, or the scenario is one we have no
 * metadata for — fall back to the raw name instead of inventing a description.
 * A wrong explanation of why an address is blocked is worse than none.
 */
export function describeDecision(
  d: Pick<CrowdsecDecision, 'addedBy' | 'scenario'>,
  scenarioDescriptions: ReadonlyMap<string, string>,
): string {
  if (d.addedBy === 'auto-ban-waf') {
    const ev = parseWafAutoBanScenario(d.scenario);
    if (ev) {
      const rules = ev.ruleIds.length === 1
        ? `WAF rule ${ev.ruleIds[0]}`
        : `${ev.ruleIds.length} WAF rules`;
      return ev.eventCount === null
        ? `Tripped ${rules}`
        : `Tripped ${rules} — ${ev.eventCount} blocked request${ev.eventCount === 1 ? '' : 's'}`;
    }
  }
  if (d.addedBy === 'operator' || d.addedBy === 'static-list') {
    // Operator reasons are free text carried after the prefix.
    const idx = d.scenario.indexOf(':');
    const text = idx === -1 ? d.scenario : d.scenario.slice(idx + 1).trim();
    return text || 'Added by an operator';
  }
  const described = scenarioDescriptions.get(d.scenario);
  if (described) return described;
  return d.scenario || 'No reason recorded';
}

/** One IP (or CIDR/country/AS) and everything currently banning it. */
export interface DecisionGroup {
  readonly key: string;
  readonly scope: CrowdsecDecision['scope'];
  readonly value: string;
  readonly decisions: readonly CrowdsecDecision[];
  /** Distinct engines involved, for the pill row. */
  readonly addedBy: readonly CrowdsecAddedBy[];
  /** Latest expiry across the group — when this address actually becomes free. */
  readonly expiresAt: string | null;
  /** True when every decision in the group is simulated, i.e. nothing is blocked. */
  readonly allSimulated: boolean;
}

/**
 * Collapse per-scenario decisions into one row per address.
 *
 * CrowdSec creates one decision per (IP, scenario), so a single scanner that
 * trips five scenarios occupies five rows that all expire at different times
 * and all look like separate incidents. Grouping is what makes the table read
 * as "these addresses are blocked" instead of "here are some decision objects".
 *
 * The group's expiry is the LATEST of its members, because that is the moment
 * the address stops being blocked — taking the earliest would tell an operator
 * the ban had lapsed while four other decisions still held it.
 */
export function groupDecisions(decisions: readonly CrowdsecDecision[]): DecisionGroup[] {
  const byKey = new Map<string, CrowdsecDecision[]>();
  for (const d of decisions) {
    const key = `${d.scope}:${d.value}`;
    const list = byKey.get(key);
    if (list) list.push(d); else byKey.set(key, [d]);
  }
  const groups: DecisionGroup[] = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => a.scenario.localeCompare(b.scenario));
    let latest: string | null = null;
    for (const d of sorted) {
      if (!d.expiresAt) continue;
      if (latest === null || d.expiresAt > latest) latest = d.expiresAt;
    }
    groups.push({
      key,
      scope: sorted[0].scope,
      value: sorted[0].value,
      decisions: sorted,
      addedBy: [...new Set(sorted.map((d) => d.addedBy))],
      expiresAt: latest,
      allSimulated: sorted.every((d) => d.simulated),
    });
  }
  return groups;
}

/** Sort keys the Banned IPs table offers. Kept here so the header and the comparator cannot drift. */
export type BanSortKey = 'value' | 'addedBy' | 'reason' | 'expiresAt' | 'count';

export function compareGroups(
  a: DecisionGroup,
  b: DecisionGroup,
  key: BanSortKey,
  descriptions: ReadonlyMap<string, string>,
): number {
  switch (key) {
    case 'value':
      // Compare IPs numerically where we can, so 9.x does not sort after 10.x.
      return compareAddresses(a.value, b.value);
    case 'addedBy':
      return a.addedBy.join().localeCompare(b.addedBy.join());
    case 'reason':
      return describeDecision(a.decisions[0], descriptions)
        .localeCompare(describeDecision(b.decisions[0], descriptions));
    case 'count':
      return a.decisions.length - b.decisions.length;
    case 'expiresAt':
    default:
      // Null expiry means "no expiry recorded"; sort those last, not first —
      // a static ban is the longest-lived thing in the table, not the shortest.
      if (a.expiresAt === b.expiresAt) return 0;
      if (a.expiresAt === null) return 1;
      if (b.expiresAt === null) return -1;
      return a.expiresAt < b.expiresAt ? -1 : 1;
  }
}

/**
 * Order IPv4 addresses numerically, everything else lexically.
 *
 * A plain string sort puts 10.0.0.1 before 9.9.9.9, which makes a sorted column
 * look broken to anyone scanning for an address.
 */
export function compareAddresses(a: string, b: string): number {
  const av = ipv4Key(a);
  const bv = ipv4Key(b);
  if (av !== null && bv !== null) return av - bv;
  if (av !== null) return -1;
  if (bv !== null) return 1;
  return a.localeCompare(b);
}

function ipv4Key(value: string): number | null {
  const bare = value.split('/')[0];
  const parts = bare.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    n = n * 256 + byte;
  }
  return n;
}

/** Name → hub description, for the reason column. */
export function scenarioDescriptionMap(
  scenarios: readonly CrowdsecScenario[] | undefined,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const s of scenarios ?? []) {
    if (s.description) map.set(s.name, s.description);
  }
  return map;
}
