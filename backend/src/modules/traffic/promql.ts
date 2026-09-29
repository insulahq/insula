/**
 * PromQL for the traffic tabs.
 *
 * Two different measurements wear the same name here, and keeping them
 * straight is the whole job:
 *
 *   • Node and cluster traffic is the NODE'S NIC — cAdvisor's root cgroup
 *     (`id="/"`), which reports the host's own interfaces. This is what
 *     actually crossed the wire, host-network traffic included.
 *   • Tenant and pod traffic is the POD's `eth0` inside its netns. A tenant is
 *     billed for what their pods moved, not for a share of the host.
 *
 * They do not sum to each other and are not meant to. Summing every pod would
 * miss host-network traffic and double-count nothing useful; reading a tenant
 * off the NIC is impossible.
 *
 * ── Interface names are never hardcoded ──────────────────────────────────
 * Nothing here filters on `eth0`. The scrape config drops virtual interfaces
 * (cali/vxlan/veth/…) and keeps whatever is left, so a host whose NIC is
 * `ens3`, `enp1s0`, `eno1` or `bond0` is summed exactly like one using `eth0`.
 * Adding `interface="eth0"` to any of these queries would silently zero out
 * node traffic on those hosts — see `scrape-contract.test.ts`.
 */

import type { TrafficBackupClass, TrafficDirection, TrafficMetric, TrafficScope } from '@insula/api-contracts';

/** cAdvisor counters, by direction. */
const NETWORK_COUNTER: Record<'in' | 'out', string> = {
  in: 'container_network_receive_bytes_total',
  out: 'container_network_transmit_bytes_total',
};

/**
 * Traefik's byte counters are named from the PROXY's point of view:
 * `requests_bytes_total` is what clients sent it (inbound), and
 * `responses_bytes_total` is what it sent back (outbound). Reading these the
 * other way round silently swaps every in/out figure on a route.
 */
const TRAEFIK_BYTES: Record<'in' | 'out', string> = {
  in: 'traefik_service_requests_bytes_total',
  out: 'traefik_service_responses_bytes_total',
};

/**
 * Pod-name prefixes per backup class. The same naming the bandwidth meter
 * relies on (`bandwidth/backup-exclusion.ts`), and reserved from tenants in
 * `@insula/api-contracts` so a tenant workload cannot appear as one.
 */
export const BACKUP_CLASS_POD_RE: Record<TrafficBackupClass, string> = {
  files: 'bk-files-.+',
  mailboxes: 'bk-mbox-.+',
  databases: 'barman-.+',
  system: 'platform-(cluster-state|secrets)-backup-.+',
};

/** Every backup pod, for subtracting from — or isolating — serving traffic. */
export const ANY_BACKUP_POD_RE = `(${Object.values(BACKUP_CLASS_POD_RE).join('|')})`;

/** Escape a value for safe interpolation into a PromQL label matcher. */
export function quoteLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '');
}

/** A Traefik `service` label is `<namespace>-<ingress>-<hash>@kubernetescrd`. */
export function serviceMatcherForNamespace(namespace: string): string {
  // TWO escapes are needed and only one is obvious. The regex metacharacters
  // matter because this lands inside `=~`; the QUOTES matter because it also
  // lands inside a PromQL string literal, and a value carrying `"` ends the
  // literal and starts a second label matcher. Escaping one without the other
  // reads as safe and is not.
  const regexSafe = namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `${quoteLabel(regexSafe)}-.+`;
}

/** DNS-1123 label rules, which every Kubernetes namespace obeys. */
const NAMESPACE_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidNamespace(value: string): boolean {
  return NAMESPACE_RE.test(value);
}

export interface QuerySpec {
  /** PromQL returning a per-second rate. */
  readonly expr: string;
  /** Label whose value identifies the series, or null for a single line. */
  readonly groupBy: string | null;
}

export interface TrafficQueryInput {
  readonly scope: TrafficScope;
  readonly metric: TrafficMetric;
  readonly direction: Exclude<TrafficDirection, 'both'>;
  readonly stepSeconds: number;
  /** Node name, tenant NAMESPACE, pod name or route service — per scope. */
  readonly subject?: string;
  /** Narrows a tenant scope to one pod. */
  readonly pod?: string;
  /** Restrict to, or exclude, platform backup pods. */
  readonly backups?: 'included' | 'exclude' | 'only';
  /** For `backup-class` scope. */
  readonly backupClass?: TrafficBackupClass;
  /** Confines a `route` scope to one namespace's services. */
  readonly namespacePrefix?: string;
}

/** Scopes that can answer a request/latency question at all. */
export const TRAEFIK_SCOPES: readonly TrafficScope[] = ['cluster', 'node', 'tenant', 'route'];

export class UnsupportedTrafficQuery extends Error {}

function networkSelector(input: TrafficQueryInput): string {
  const parts: string[] = [];
  switch (input.scope) {
    case 'cluster':
    case 'node':
      // Root cgroup = the host's own interfaces. No `interface=` filter: see
      // the header. `node` is attached by the kubelet-cadvisor relabel rule.
      parts.push('id="/"');
      if (input.scope === 'node' && input.subject) parts.push(`node="${quoteLabel(input.subject)}"`);
      break;
    case 'tenant':
      parts.push(input.subject ? `namespace="${quoteLabel(input.subject)}"` : 'namespace=~"tenant-.+"');
      break;
    case 'pod':
      if (!input.subject) throw new UnsupportedTrafficQuery('pod scope needs a tenant namespace');
      parts.push(`namespace="${quoteLabel(input.subject)}"`);
      if (input.pod) parts.push(`pod="${quoteLabel(input.pod)}"`);
      break;
    case 'backup-class': {
      const cls = input.backupClass;
      if (!cls) throw new UnsupportedTrafficQuery('backup-class scope needs a class');
      parts.push(`pod=~"${BACKUP_CLASS_POD_RE[cls]}"`);
      parts.push('namespace=~"tenant-.+|platform|mail"');
      break;
    }
    default:
      throw new UnsupportedTrafficQuery(`scope ${input.scope} is not a network-counter scope`);
  }
  if (input.pod && input.scope === 'tenant') parts.push(`pod="${quoteLabel(input.pod)}"`);
  if (input.backups === 'exclude') parts.push(`pod!~"${ANY_BACKUP_POD_RE}"`);
  if (input.backups === 'only') parts.push(`pod=~"${ANY_BACKUP_POD_RE}"`);
  return parts.join(',');
}

function traefikSelector(input: TrafficQueryInput): string {
  switch (input.scope) {
    case 'cluster':
      return '';
    case 'node':
      return input.subject ? `node="${quoteLabel(input.subject)}"` : '';
    case 'tenant':
      return input.subject ? `service=~"${serviceMatcherForNamespace(input.subject)}"` : 'service=~"tenant-.+"';
    case 'route':
      if (input.subject) return `service="${quoteLabel(input.subject)}"`;
      // A tenant asking for "my routes" owns a namespace, not a service id;
      // its services are the ones whose label starts with that namespace.
      return input.namespacePrefix
        ? `service=~"${serviceMatcherForNamespace(input.namespacePrefix)}"`
        : '';
    default:
      throw new UnsupportedTrafficQuery(`scope ${input.scope} has no request-level metrics`);
  }
}

function groupLabelFor(scope: TrafficScope, hasSubject: boolean, metric: TrafficMetric): string | null {
  if (scope === 'cluster') return null;
  if (scope === 'node') return hasSubject ? null : 'node';
  if (scope === 'route') return hasSubject ? null : 'service';
  if (scope === 'backup-class') return null;
  if (scope === 'tenant') {
    if (!hasSubject) return metric === 'traffic' ? 'namespace' : 'service';
    return null;
  }
  // Pod scope: always grouped by pod. Whether that renders as one line or
  // several is decided by `isSingleSubject` in service.ts, not here — this
  // used to be a ternary whose branches were both 'pod'.
  return 'pod';
}

/**
 * Build the range query for one direction of one frame.
 *
 * Returns a per-second rate in the metric's natural unit: bytes/s, requests/s,
 * or milliseconds (latency is already an average, not a rate).
 */
export function buildTrafficQuery(input: TrafficQueryInput): QuerySpec {
  const win = `${Math.max(60, input.stepSeconds)}s`;

  // A route IS a Traefik service, so its bytes come from Traefik's own
  // counters rather than from cAdvisor — there is no cgroup that corresponds
  // to an ingress route. Without this, `scope=route` + `metric=traffic` fell
  // through to networkSelector's `default:` and threw on every request, while
  // both panels offered it as the default selection.
  if (input.metric === 'traffic' && input.scope === 'route') {
    const sel = traefikSelector(input);
    const braces = sel ? `{${sel}}` : '';
    const by = groupLabelFor(input.scope, Boolean(input.subject), input.metric);
    const inner = `rate(${TRAEFIK_BYTES[input.direction]}${braces}[${win}])`;
    return { expr: by ? `sum by (${by}) (${inner})` : `sum(${inner})`, groupBy: by };
  }

  if (input.metric === 'traffic') {
    const sel = networkSelector(input);
    const counter = NETWORK_COUNTER[input.direction];
    const by = groupLabelFor(input.scope, Boolean(input.subject), input.metric);
    const inner = `rate(${counter}{${sel}}[${win}])`;
    return { expr: by ? `sum by (${by}) (${inner})` : `sum(${inner})`, groupBy: by };
  }

  if (!TRAEFIK_SCOPES.includes(input.scope)) {
    // Being explicit beats drawing a flat zero. Traefik counts per backend
    // SERVICE; it has no idea which pod answered, so per-pod request rates
    // and latencies do not exist to be shown.
    throw new UnsupportedTrafficQuery(
      `${input.metric} is not available for ${input.scope} scope — Traefik measures per service, not per pod`,
    );
  }

  const sel = traefikSelector(input);
  const braces = sel ? `{${sel}}` : '';
  const by = groupLabelFor(input.scope, Boolean(input.subject), input.metric);

  if (input.metric === 'requests') {
    const inner = `rate(traefik_service_requests_total${braces}[${win}])`;
    return { expr: by ? `sum by (${by}) (${inner})` : `sum(${inner})`, groupBy: by };
  }

  // Average latency, in milliseconds. Ratio of SUMS, never an average of
  // averages — the latter weights a service with three requests the same as
  // one with thirty thousand.
  const sum = `rate(traefik_service_request_duration_seconds_sum${braces}[${win}])`;
  const count = `rate(traefik_service_request_duration_seconds_count${braces}[${win}])`;
  const expr = by
    ? `1000 * sum by (${by}) (${sum}) / sum by (${by}) (${count})`
    : `1000 * sum(${sum}) / sum(${count})`;
  return { expr, groupBy: by };
}
