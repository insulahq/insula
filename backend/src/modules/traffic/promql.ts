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

/**
 * Interfaces that are plumbing, not a wire.
 *
 * The scrape config drops these so they are never stored again — but the
 * store keeps 30 days, and every one of those days already holds them. A
 * query that trusts the scrape alone therefore reads correct data going
 * forward and badly inflated data for a month: cAdvisor attributes one
 * Calico veth per pod to the root cgroup, so cluster traffic measured 265 GB
 * over a day that actually moved 46 GB, and 1.2 TB over a week that moved
 * 164 GB.
 *
 * Excluding them HERE as well fixes history, and keeps the numbers right if
 * anyone ever loosens the scrape rule. Listed by what is virtual rather than
 * by keeping `eth0`, for the same reason as the scrape rule: a NIC is
 * `ens3`/`enp1s0`/`eno1`/`bond0` on plenty of hosts.
 */
const VIRTUAL_IFACE_RE = 'cali[0-9a-f].*|tunl.*|veth.*|vxlan.*|wireguard.*|docker.*'
  + '|br-.*|flannel.*|cni.*|dummy.*|nodelocaldns.*|kube-ipvs.*|lo';

/**
 * Calico's inter-node encapsulation — the only view of node-to-node traffic.
 *
 * A SUBSET of the NIC: the tunnel rides over it, so these bytes are already
 * in the wire total and adding them would count them twice.
 */
// No backslash escape: a PromQL string literal rejects `\.` outright — it is
// not one of the escapes it accepts — and the query 422s. Delivering a real
// escaped dot to the regex needs `\\.` in the literal, which is more
// ceremony than it is worth when an unescaped `.` matches the same
// interfaces and nothing else is named `wireguardXcali`.
const NODE_TO_NODE_IFACE_RE = 'vxlan.*|wireguard.*';

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
  // Both components of one tenant bundle — files on disk and the JMAP
  // mailbox capture — so they are one line, not two.
  'tenant-bundles': 'bk-(files|mbox)-.+',
  // The mail SERVER's own snapshots, which is a different job from the
  // mailbox component above and was not being counted at all.
  'mail-snapshots': 'stalwart-snapshot-cron-.+',
  databases: 'barman-.+',
  // Cluster state and secrets are one concern to an operator reading a
  // chart, and separately they are a rounding error.
  system: 'platform-(cluster-state|secrets)-backup-.+',
};

/** Every backup pod, for subtracting from — or isolating — serving traffic. */
export const ANY_BACKUP_POD_RE = `(${Object.values(BACKUP_CLASS_POD_RE).join('|')})`;

/** Escape a value for safe interpolation into a PromQL label matcher. */
export function quoteLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '');
}

/**
 * The generated tail a Deployment gives its pods: `-<replicaset>-<suffix>`.
 *
 * Neither generated segment can contain a hyphen, which is what keeps this
 * from reaching across an application boundary: `website-[a-z0-9]{6,10}-…`
 * cannot match `website-admin-655bc877b9-przdh`, because `admin-655bc877b9`
 * is not one segment. PromQL anchors a `=~` at both ends, so there is no
 * prefix-overrun either.
 */
const POD_GENERATED_TAIL = '-[a-z0-9]{6,10}-[a-z0-9]{5}';

/** True when the value is already a full pod name rather than an app name. */
export function looksLikePodName(value: string): boolean {
  return /-[a-z0-9]{6,10}-[a-z0-9]{5}$/.test(value);
}

/**
 * Select one APPLICATION's pods, or one exact pod.
 *
 * Pod rows are aggregated per application — three `file-manager` replicas
 * are one line, not three rows wearing the same name — so the subject the
 * panel sends back is an application name. An exact pod name is still
 * accepted: it is a legitimate thing to ask for and a caller who has one
 * should not be forced to widen it.
 */
export function podMatcher(value: string): string {
  const safe = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return looksLikePodName(value)
    ? `pod="${quoteLabel(value)}"`
    : `pod=~"${quoteLabel(safe)}${POD_GENERATED_TAIL}"`;
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

/** The in-cluster relay every off-site backup upload passes through. */
export const OFFSITE_SHIM_POD_RE = 'backup-rclone.+';

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
  /**
   * A cluster sub-measurement instead of the plain wire total:
   *  - `node-to-node` — Calico's encapsulation, what crossed BETWEEN nodes;
   *  - `offsite-backup` — the rclone shim, what actually left for storage.
   * Both are subsets of the wire and must never be added to it.
   */
  readonly wireSubset?: 'node-to-node' | 'offsite-backup';
  /**
   * Collapse to a single line instead of one per subject. "What tenant
   * workloads sent" is one number; grouped by namespace it returned a row
   * per tenant, every one of them carrying the same name.
   */
  readonly aggregate?: boolean;
}

/** Scopes that can answer a request/latency question at all. */
export const TRAEFIK_SCOPES: readonly TrafficScope[] = ['cluster', 'node', 'tenant', 'route'];

export class UnsupportedTrafficQuery extends Error {}

function networkSelector(input: TrafficQueryInput): string {
  // Every network query carries it: a pod's own series is always `eth0`, so
  // this costs real data nothing and removes the retained plumbing.
  const parts: string[] = [`interface!~"${VIRTUAL_IFACE_RE}"`];
  switch (input.scope) {
    case 'cluster':
    case 'node':
      if (input.wireSubset === 'offsite-backup') {
        // Measured at the shim, not at the backup jobs: the jobs send to the
        // shim over the pod network, and only the shim's egress leaves.
        parts.length = 0;
        parts.push(`interface!~"${VIRTUAL_IFACE_RE}"`);
        parts.push(`pod=~"${OFFSITE_SHIM_POD_RE}"`);
        break;
      }
      if (input.wireSubset === 'node-to-node') {
        // Replace the exclusion: these are exactly the interfaces it drops.
        parts.length = 0;
        parts.push(`interface=~"${NODE_TO_NODE_IFACE_RE}"`);
        parts.push('id="/"');
        if (input.scope === 'node' && input.subject) parts.push(`node="${quoteLabel(input.subject)}"`);
        break;
      }
      // Root cgroup = the host's own interfaces. No `interface=` filter: see
      // the header. `node` is attached by the kubelet-cadvisor relabel rule.
      parts.push('id="/"');
      if (input.scope === 'node' && input.subject) parts.push(`node="${quoteLabel(input.subject)}"`);
      break;
    case 'tenant':
      parts.push(input.subject ? `namespace="${quoteLabel(input.subject)}"` : 'namespace=~"tenant-.+"');
      break;
    case 'pod':
      // No tenant chosen means "every pod", which is an ordinary breakdown
      // across tenant namespaces — the same selector the tenant breakdown
      // uses, grouped by pod instead. This used to throw
      // TRAFFIC_QUERY_UNSUPPORTED, so the panel's own default pod view
      // greeted the operator with an error for a question the store can
      // answer perfectly well.
      parts.push(input.subject
        ? `namespace="${quoteLabel(input.subject)}"`
        : 'namespace=~"tenant-.+"');
      if (input.pod) parts.push(podMatcher(input.pod));
      break;
    case 'backup-class': {
      const cls = input.backupClass;
      if (!cls) throw new UnsupportedTrafficQuery('backup-class scope needs a class');
      // Pod name only. This carried a namespace allowlist
      // (`tenant-*|platform|mail`) that looked like defence in depth and was
      // really a false-negative generator: CNPG's `barman-cloud` uploader
      // lives in `cnpg-system`, so every byte of database-backup egress was
      // invisible in the split. Backup components are not confined to a fixed
      // set of namespaces and there is no reason they should be.
      //
      // Safe to widen because these matchers drive a CHART, not a bill. The
      // meter's exclusion is anchored to `backup_jobs` rows and a reserved
      // name prefix (`bandwidth/backup-exclusion.ts`); nothing here can move
      // what a tenant is charged.
      parts.push(`pod=~"${BACKUP_CLASS_POD_RE[cls]}"`);
      break;
    }
    default:
      throw new UnsupportedTrafficQuery(`scope ${input.scope} is not a network-counter scope`);
  }
  if (input.pod && input.scope === 'tenant') parts.push(podMatcher(input.pod));
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

/**
 * The label a tenant's Traefik series is rewritten onto.
 *
 * Traefik counts per backend SERVICE, so a tenant breakdown of requests or
 * latency grouped by `service` — which meant the picker listed raw ids like
 * `tenant-acme-<hash>-tenant-acme-<hash>-ingress-<hash>@kubernetescrd`, and
 * worse, that a tenant's subject key MEANT something different depending on
 * which metric happened to be selected. Switching metric silently invalidated
 * the selection. `label_replace` folds the service back onto the namespace
 * that owns it, so one tenant is one row under all three metrics and the key
 * is the same namespace every time.
 */
const TENANT_NS_FROM_SERVICE = '^(tenant-[a-z0-9-]+?-[0-9a-f]{8})-.*';

export function tenantNamespaceRewrite(inner: string): string {
  return `label_replace(${inner}, "namespace", "$1", "service", "${TENANT_NS_FROM_SERVICE}")`;
}

function groupLabelFor(
  scope: TrafficScope, hasSubject: boolean, metric: TrafficMetric, aggregate?: boolean,
): string | null {
  if (aggregate) return null;
  if (scope === 'cluster') return null;
  if (scope === 'node') return hasSubject ? null : 'node';
  if (scope === 'route') return hasSubject ? null : 'service';
  if (scope === 'backup-class') return null;
  if (scope === 'tenant') return hasSubject ? null : 'namespace';
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
    const by = groupLabelFor(input.scope, Boolean(input.subject), input.metric, input.aggregate);
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

  const asTenant = input.scope === 'tenant' && by === 'namespace';

  if (input.metric === 'requests') {
    const raw = `rate(traefik_service_requests_total${braces}[${win}])`;
    const inner = asTenant ? tenantNamespaceRewrite(raw) : raw;
    return { expr: by ? `sum by (${by}) (${inner})` : `sum(${inner})`, groupBy: by };
  }

  // Average latency, in milliseconds. Ratio of SUMS, never an average of
  // averages — the latter weights a service with three requests the same as
  // one with thirty thousand.
  const rawSum = `rate(traefik_service_request_duration_seconds_sum${braces}[${win}])`;
  const rawCount = `rate(traefik_service_request_duration_seconds_count${braces}[${win}])`;
  const sum = asTenant ? tenantNamespaceRewrite(rawSum) : rawSum;
  const count = asTenant ? tenantNamespaceRewrite(rawCount) : rawCount;
  const expr = by
    ? `1000 * sum by (${by}) (${sum}) / sum by (${by}) (${count})`
    : `1000 * sum(${sum}) / sum(${count})`;
  return { expr, groupBy: by };
}
