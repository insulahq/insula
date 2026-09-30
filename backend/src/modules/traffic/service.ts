/**
 * Serving a traffic frame.
 *
 * Retention decides the source. VictoriaMetrics holds 30 days of fine-grained
 * samples; past that the only survivor is the per-tenant daily egress rollup
 * in `usage_metrics`, written by the bandwidth meter. So a request reaching
 * further back is served one of two ways, and the frame says which:
 *
 *   • per-tenant traffic → the daily rows, at `resolution: 'daily'`;
 *   • anything else      → clamped to what the metrics store still has,
 *                          with `clamped: true`.
 *
 * Padding the missing months with zeroes was the alternative, and it would
 * have drawn a long quiet stretch that never happened.
 */

import { and, eq, gte, inArray, like, lte, ne, sql } from 'drizzle-orm';
import {
  TRAFFIC_FINE_RETENTION_DAYS,
  type TrafficFrame, type TrafficMetric, type TrafficScope,
  type TrafficSeries, type TrafficSubject, type TrafficUnit,
} from '@insula/api-contracts';
import { domains, ingressRoutes, tenants, usageMetrics } from '../../db/schema.js';
import { queryRange, type VmClientOptions } from '../monitoring/vm-client.js';
import {
  BACKUP_CLASS_POD_RE, buildTrafficQuery, UnsupportedTrafficQuery,
  type TrafficQueryInput,
} from './promql.js';
import {
  alignToTimeline, buildTimeline, chooseStepSeconds, foldTail, integrate, meanOf, rankValue, seriesKey,
} from './frame.js';
import type { Database } from '../../db/index.js';

const DAY_MS = 86_400_000;

export interface TrafficRequest {
  readonly from: Date;
  readonly to: Date;
  readonly scope: TrafficScope;
  readonly subject?: string;
  readonly pod?: string;
  readonly metric: TrafficMetric;
  readonly direction: 'in' | 'out' | 'both';
  readonly backups: 'included' | 'separate' | 'only';
  /** Set for tenant-panel callers; confines a `route` scope to their services. */
  readonly restrictToNamespace?: string;
}

export function unitFor(metric: TrafficMetric): TrafficUnit {
  if (metric === 'requests') return 'requests';
  return metric === 'latency' ? 'milliseconds' : 'bytes';
}

/** Oldest instant the metrics store can still answer for. */
export function fineRetentionStart(now: Date): Date {
  return new Date(now.getTime() - TRAFFIC_FINE_RETENTION_DAYS * DAY_MS);
}

/**
 * Tenant namespaces NESTED inside `namespace` — those beginning with it plus a
 * hyphen.
 *
 * A namespace is `tenant-<slug>-<8 hex>`, and the slug comes from the tenant's
 * name, so `tenant-acme-<hash>` and `tenant-acme-<hash>-eu-<hash2>` are
 * both legal and the second begins with the first. Any ownership test that is
 * only a string prefix therefore hands the nested tenant's routes to the outer
 * one. The trailing hyphen defeats the `tenant-a` / `tenant-ab` case and does
 * nothing about this one, so it is settled against the real list instead of
 * against the shape of the string.
 */
export async function nestedNamespaces(db: Database, namespace: string): Promise<string[]> {
  const rows = await db
    .select({ nested: tenants.kubernetesNamespace })
    .from(tenants)
    .where(and(
      like(tenants.kubernetesNamespace, `${namespace}-%`),
      ne(tenants.kubernetesNamespace, namespace),
    ));
  return rows.map((r) => r.nested).filter((n): n is string => Boolean(n));
}

/** True when `service` belongs to one of the nested namespaces, not to us. */
export function belongsToNested(service: string, nested: readonly string[]): boolean {
  return nested.some((n) => service.startsWith(`${n}-`));
}

/**
 * Make every series name unique.
 *
 * Three separate bugs in this feature shipped rows the reader could not tell
 * apart — five "Tenant workloads sent", two "Node-to-node", and two Traefik
 * services whose display name collapsed to the same thing once the hash was
 * trimmed off. Each was fixed where it arose; this is the net underneath, so
 * the next one is a cosmetic suffix rather than an unreadable table.
 *
 * The discriminator is the part of the key that actually differs — for a
 * Traefik service that is its hash, which is the only thing distinguishing
 * two ingresses of the same name.
 */
/**
 * A series key carries its direction so that "out" and "in" for one subject
 * are distinct rows. A SUBJECT does not have a direction — it is a node, a
 * tenant, a pod, a route — so the picker must hand back the bare identity.
 *
 * Getting this wrong is invisible in a frame and fatal one request later:
 * the panel echoes the key back as `subject`, the query becomes
 * `node="out:sv1"` or `namespace="out:tenant-<slug>-<hash>"`, and every
 * individual node, tenant, pod and route reads as "no traffic" while the
 * breakdown above it is full of data.
 */
export function subjectIdOf(key: string): string {
  return key.replace(/^(in|out):/, '');
}

/**
 * Fold every pod of one application into a single series.
 *
 * A Deployment's pods are replicas of one thing. Listing
 * `file-manager-aaaaaaaaaa-bbbbb` beside `file-manager-aaaaaaaaaa-ccccc`
 * asks the reader to add two numbers that were never separate questions —
 * and once the names are collapsed to the application, the rows are simply
 * indistinguishable, which the disambiguator would then "fix" by numbering
 * them `file-manager #1` and `#2`. Neither is what was wanted.
 *
 * Summed point-by-point, and `null` is preserved as null ONLY where every
 * member is null: one replica with a gap must not blank the application's
 * whole line, but an interval nobody measured is still unmeasured and must
 * stay a break rather than becoming a zero.
 */
export function aggregateByName<T extends { key: string; name: string; points: (number | null)[] }>(
  series: readonly T[],
): T[] {
  const byName = new Map<string, T>();
  for (const s of series) {
    const seen = byName.get(s.name);
    if (!seen) {
      byName.set(s.name, { ...s, key: s.name, points: [...s.points] });
      continue;
    }
    const merged = seen.points.map((v, i) => {
      const w = s.points[i];
      if (v === null && (w === null || w === undefined)) return null;
      return (v ?? 0) + (w ?? 0);
    });
    byName.set(s.name, { ...seen, points: merged });
  }
  return [...byName.values()];
}

export function disambiguateNames<T extends { key: string; name: string }>(series: T[]): T[] {
  const count = new Map<string, number>();
  for (const s of series) count.set(s.name, (count.get(s.name) ?? 0) + 1);
  // Numbered, not hashed. Rows that collide are rows the measurement genuinely
  // cannot tell apart — two routes inside one ingress object, say — and
  // showing eight characters of a Traefik hash names them after an
  // implementation detail the operator has no way to look up. A counter says
  // the same thing ("these are different") without pretending to be an id.
  // Ordering within a frame is deterministic, so the numbering is stable
  // between refreshes of the same query.
  const seen = new Map<string, number>();
  return series.map((s) => {
    if ((count.get(s.name) ?? 0) < 2) return s;
    const n = (seen.get(s.name) ?? 0) + 1;
    seen.set(s.name, n);
    return { ...s, name: `${s.name} #${n}` };
  });
}

/** namespace → tenant display name, for every namespace in the frame. */
async function tenantNames(db: Database, namespaces: readonly string[]): Promise<Map<string, string>> {
  if (namespaces.length === 0) return new Map();
  const rows = await db
    .select({ ns: tenants.kubernetesNamespace, name: tenants.name })
    .from(tenants)
    .where(inArray(tenants.kubernetesNamespace, [...namespaces]));
  return new Map(rows.filter((r) => r.ns).map((r) => [r.ns, r.name]));
}

/** namespace → the hostnames its ingress serves. */
async function tenantHosts(
  db: Database, namespaces: readonly string[],
): Promise<Map<string, string[]>> {
  if (namespaces.length === 0) return new Map();
  const rows = await db
    .select({ ns: tenants.kubernetesNamespace, host: ingressRoutes.hostname })
    .from(ingressRoutes)
    .innerJoin(domains, eq(domains.id, ingressRoutes.domainId))
    .innerJoin(tenants, eq(tenants.id, domains.tenantId))
    .where(inArray(tenants.kubernetesNamespace, [...namespaces]));
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.ns || !r.host) continue;
    const seen = out.get(r.ns) ?? [];
    if (!seen.includes(r.host)) seen.push(r.host);
    out.set(r.ns, seen);
  }
  return out;
}

/**
 * A Traefik service label is `<namespace>-<ingress>-<hash>@kubernetescrd`,
 * which tells an operator nothing. What they want is the domain.
 *
 * WHAT CAN AND CANNOT BE KNOWN. Traefik's counters carry `service` and
 * nothing else — no host, no router (verified against the live store: the
 * only labels are service/job/instance/node/code/method/protocol). A tenant
 * gets ONE IngressRoute object holding all of its routes, and Traefik mints
 * one service per route inside it, distinguished by a hash of the match rule
 * that cannot be inverted. So a service maps to a host only when the tenant
 * serves exactly one host — then every service of theirs necessarily serves
 * it. That covers most tenants (21 of 27 on the reference cluster); the rest
 * are named for their tenant and ingress object, because inventing a domain
 * for them would be a guess presented as a fact.
 */
export function prettyServiceName(
  service: string,
  nsToName: ReadonlyMap<string, string>,
  nsToHosts: ReadonlyMap<string, readonly string[]> = new Map(),
): string {
  // Traefik appends a hash of the match rule. It is 20 hex here and 16 in
  // other provider versions, so match 8 or more rather than pinning a width.
  const bare = service.replace(/@[a-z]+$/, '').replace(/-[0-9a-f]{8,}$/, '');
  for (const [ns, name] of nsToName) {
    if (bare === ns || bare.startsWith(`${ns}-`)) {
      const hosts = nsToHosts.get(ns) ?? [];
      const rest = bare.slice(ns.length).replace(/^-/, '').replace(/-ingress$/, '');
      if (hosts.length === 1) {
        // The HTTP-entrypoint router is a real distinction worth keeping —
        // it is the one that redirects rather than serves.
        const http = /-ingress-http$/.test(bare) || rest.endsWith('-http');
        return `${hosts[0]} · ${name}${http ? ' (http)' : ''}`;
      }
      return rest ? `${name} · ${rest}` : name;
    }
  }
  // Not a tenant namespace — `platform`, `mail`, and so on. Traefik names the
  // object `<namespace>-<ingress>`, which doubles the namespace when the
  // ingress is itself named after it (`platform-platform-ingress`). Collapse
  // that and drop the `-ingress` suffix every one of them carries.
  return bare
    .replace(/^([a-z0-9-]+?)-\1-/, '$1-')
    .replace(/-ingress$/, '');
}

/**
 * A pod name, as the application it belongs to.
 *
 * A Deployment names its pods `<app>-<replicaset hash>-<suffix>`, so the
 * traffic tables listed `website-aaaaaaaaaa-bbbbb` and
 * `file-manager-aaaaaaaaaa-bbbbb` — two identifiers the reader has to strip
 * in their head to find the one word that matters. The pod KEY is untouched:
 * it is what goes back as `pod=` on the next query, and it has to stay the
 * real name.
 *
 * Only the Deployment shape is collapsed, and only when both trailing
 * segments look like generated ones. A StatefulSet pod (`system-db-1`) and a
 * bare Job pod keep their names: the ordinal in the first IS the identity,
 * and guessing at the second risks folding two different jobs into one row.
 */
export function prettyPodName(pod: string): string {
  return pod.replace(/-[a-z0-9]{6,10}-[a-z0-9]{5}$/, '');
}

function displayNameFor(
  scope: TrafficScope,
  key: string,
  nsToName: ReadonlyMap<string, string>,
  nsToHosts: ReadonlyMap<string, readonly string[]> = new Map(),
): string {
  if (scope === 'tenant') {
    const name = nsToName.get(key);
    if (name) return name;
    // Namespaces outlive the tenants that owned them — a deleted tenant can
    // leave one behind still moving bytes. Hiding it would drop real traffic
    // out of the breakdown; printing the bare slug implies somebody is called
    // that. Naming it for what it is does neither, and is a cleanup lead.
    return `${key} (no tenant record)`;
  }
  if (scope === 'route') return prettyServiceName(key, nsToName, nsToHosts);
  if (scope === 'pod') return prettyPodName(key);
  return key;
}

interface DirectionPlan {
  readonly direction: 'in' | 'out';
  readonly label: string;
}

function directionPlans(req: TrafficRequest): DirectionPlan[] {
  if (req.metric !== 'traffic') return [{ direction: 'out', label: '' }];
  // A backup split is about egress: those pods upload and receive almost
  // nothing, and running both directions produced the split twice.
  //
  // NOT on a cluster view. That path builds its own plans and already gates
  // the egress-only rows on direction itself — applying this here silently
  // deleted Inbound from the wire, which is the one row on the page that is
  // definitionally not egress. The panel forces `separate` for cluster
  // traffic, so this was every cluster view, and a query with the default
  // `included` (what curl sends) still returned it — which is exactly why
  // this survived an API check and only showed up on screen.
  if (req.backups !== 'included' && req.scope !== 'cluster') {
    return [{ direction: 'out', label: 'Outbound' }];
  }
  if (req.direction === 'in') return [{ direction: 'in', label: 'Inbound' }];
  if (req.direction === 'out') return [{ direction: 'out', label: 'Outbound' }];
  return [{ direction: 'out', label: 'Outbound' }, { direction: 'in', label: 'Inbound' }];
}

/** True when the frame draws one line per direction rather than per subject. */
function isSingleSubject(req: TrafficRequest): boolean {
  if (req.scope === 'cluster' || req.scope === 'backup-class') return true;
  // In `pod` scope the subject names the TENANT, so the frame stays
  // per-pod until an actual pod is chosen.
  if (req.scope === 'pod') return Boolean(req.pod);
  return Boolean(req.subject);
}

export interface TrafficServiceDeps {
  readonly db: Database;
  readonly vm?: VmClientOptions;
  readonly now?: () => Date;
}

export interface FrameOptions {
  /** Return every subject instead of folding the tail into `Other`. */
  readonly noFold?: boolean;
}

export async function fetchTrafficFrame(
  req: TrafficRequest,
  deps: TrafficServiceDeps,
  opts: FrameOptions = {},
): Promise<TrafficFrame> {
  const now = deps.now?.() ?? new Date();
  const unit = unitFor(req.metric);
  const retentionStart = fineRetentionStart(now);
  const wantsHistory = req.from < retentionStart;

  if (wantsHistory && req.metric === 'traffic' && req.scope === 'tenant') {
    return dailyTenantFrame(req, deps.db, unit);
  }

  const clamped = wantsHistory;
  const from = clamped ? retentionStart : req.from;
  const stepSeconds = chooseStepSeconds(from.getTime(), req.to.getTime());
  const timeline = buildTimeline(from.getTime(), req.to.getTime(), stepSeconds);

  const plans = directionPlans(req);
  const single = isSingleSubject(req);
  const collected: Array<{
    key: string; name: string; kind: TrafficSeries['kind'];
    group?: TrafficSeries['group']; points: Array<number | null>;
  }> = [];
  const namespacesSeen = new Set<string>();

  // A tenant is selected by a service PREFIX now, and namespaces nest, so
  // the children have to be named and excluded before the query is built —
  // otherwise a parent tenant is billed for a child tenant's traffic.
  const nestedUnderSubject = req.scope === 'tenant' && req.subject && req.metric === 'traffic'
    ? await nestedNamespaces(deps.db, req.subject)
    : [];

  for (const plan of plans) {
    const specs = planQueries(req, plan.direction, stepSeconds, plan.label, nestedUnderSubject);
    for (const spec of specs) {
      const rows = await queryRange(
        spec.query.expr,
        Math.floor(timeline[0] / 1000),
        Math.floor(timeline[timeline.length - 1] / 1000),
        stepSeconds,
        deps.vm,
      );
      for (const row of rows) {
        const rawKey = seriesKey(row, spec.query.groupBy, spec.fallbackKey);
        if (spec.query.groupBy === 'namespace') namespacesSeen.add(rawKey);
        if (spec.query.groupBy === 'service') {
          const ns = rawKey.replace(/@[a-z]+$/, '').match(/^(tenant-[a-z0-9-]+?-[0-9a-f]{8})-/);
          if (ns) namespacesSeen.add(ns[1]);
        }
        collected.push({
          key: spec.keyPrefix ? `${spec.keyPrefix}:${rawKey}` : rawKey,
          name: spec.nameOverride ?? rawKey,
          kind: spec.kind,
          group: spec.group,
          points: alignToTimeline(row.points, timeline, stepSeconds),
        });
      }
    }
  }
  if (req.scope === 'tenant' && req.subject) namespacesSeen.add(req.subject);

  if (req.scope === 'route' && req.restrictToNamespace) {
    const nested = await nestedNamespaces(deps.db, req.restrictToNamespace);
    if (nested.length > 0) {
      for (let i = collected.length - 1; i >= 0; i--) {
        const service = subjectIdOf(collected[i].key);
        if (belongsToNested(service, nested)) collected.splice(i, 1);
      }
    }
  }

  // Frames are gathered direction-major (all of "out", then all of "in"),
  // which scatters a pair like Node-to-node (out) / (in) either side of an
  // unrelated row. Put each measurement's directions back together, keeping
  // outbound first, without disturbing anything else.
  if (collected.some((c) => c.group)) {
    const rank = (key: string): number => ['wire:', 'n2n:', 'offsite', 'serving', 'backup']
      .findIndex((p) => key.startsWith(p));
    const dirRank = (key: string): number => (key.includes(':in') ? 1 : 0);
    collected.sort((a, b) => (rank(a.key) - rank(b.key)) || (dirRank(a.key) - dirRank(b.key)));
  }

  const nsToName = await tenantNames(deps.db, [...namespacesSeen]);
  const nsToHosts = req.scope === 'route'
    ? await tenantHosts(deps.db, [...namespacesSeen])
    : new Map<string, string[]>();
  for (const s of collected) {
    if (s.kind === 'subject') s.name = displayNameFor(req.scope, s.name, nsToName, nsToHosts);
  }
  // Both directions across a SUBJECT breakdown gives two series per subject.
  // Their keys differ but their names do not, so the table listed "SYSTEM"
  // twice with no way to tell which row was which — and the top-N fold then
  // ranked lines rather than subjects. Name the direction when there is more
  // than one of them to tell apart.
  if (plans.length > 1) {
    for (const s of collected) {
      if (s.kind !== 'subject') continue;
      const dir = s.key.startsWith('in:') ? 'in' : 'out';
      s.name = `${s.name} · ${dir}`;
    }
  }

  // Pod rows are per-APPLICATION: replicas of one Deployment are one line.
  // Must run after naming (it groups on the collapsed name) and before
  // disambiguation (otherwise the duplicates it exists to remove get
  // numbered instead).
  if (req.scope === 'pod') {
    const subjects = collected.filter((s) => s.kind === 'subject');
    const rest = collected.filter((s) => s.kind !== 'subject');
    const folded = aggregateByName(subjects);
    collected.length = 0;
    collected.push(...rest, ...folded);
  }

  const deduped = disambiguateNames(collected);
  collected.length = 0;
  collected.push(...deduped);

  let series: TrafficSeries[];
  let othersFolded = 0;
  if (opts.noFold || single || req.backups !== 'included' || collected.every((s) => s.kind !== 'subject')) {
    series = collected.map((s) => ({
      key: s.key, name: s.name, kind: s.kind, group: s.group, points: s.points,
    }));
  } else {
    const folded = foldTail(collected.map((s) => ({ key: s.key, name: s.name, points: s.points })), unit, stepSeconds);
    series = folded.series;
    othersFolded = folded.othersFolded;
  }

  return {
    from: from.toISOString(),
    to: req.to.toISOString(),
    stepSeconds,
    times: timeline.map((t) => new Date(t).toISOString()),
    unit,
    resolution: 'fine',
    series,
    othersFolded,
    clamped,
  };
}

interface PlannedQuery {
  readonly query: ReturnType<typeof buildTrafficQuery>;
  readonly kind: TrafficSeries['kind'];
  readonly fallbackKey: string;
  readonly nameOverride?: string;
  readonly keyPrefix?: string;
  readonly group?: TrafficSeries['group'];
}

/**
 * Every query one direction of a frame needs.
 *
 * Usually one. In `separate`/`only` backup mode it is one per backup class
 * plus, for `separate`, a serving line with those pods excluded — so the parts
 * add up to the whole instead of overlapping it.
 */
function planQueries(
  req: TrafficRequest, direction: 'in' | 'out', stepSeconds: number, directionLabel: string,
  excludeNestedNamespaces: readonly string[] = [],
): PlannedQuery[] {
  const base: Omit<TrafficQueryInput, 'backups' | 'backupClass' | 'scope'> & { scope: TrafficScope } = {
    scope: req.scope,
    metric: req.metric,
    direction,
    stepSeconds,
    subject: req.subject,
    pod: req.pod,
    namespacePrefix: req.restrictToNamespace,
    excludeNestedNamespaces,
  };

  // Backup traffic is ALWAYS its own series on a cluster view — it is not a
  // mode to opt into. An operator reading cluster traffic needs to know how
  // much of it is the platform backing itself up, every time, not only when
  // they remember to ask.
  // ── cluster traffic: the wire, its subsets, then the workload view ──
  //
  // Two measurements, deliberately not blended. The wire is what crossed the
  // network. The workload rows are what each job SENT, which double-counts
  // every backup byte (job → in-cluster shim → off-site) and misses nothing
  // that stayed inside the node. Both are true; only one of them adds up,
  // and the frame says which is which.
  if (req.scope === 'cluster' && req.metric === 'traffic') {
    // ── the wire, and the one honest subset of it ────────────────────────
    //
    // This used to carry a third group, "what each workload sent", built
    // from pod counters: a serving line plus a row per backup class. Those
    // are a DIFFERENT INSTRUMENT sitting under a cluster-traffic heading,
    // and they answered a question nobody asked here — cluster traffic is
    // about what crossed the network, and pod counters mostly measure
    // traffic that never did. Per-workload detail lives in the pod
    // breakdown, which is labelled for what it is.
    //
    // The off-site backup upload row went with them, and it was the clearest
    // possible demonstration of the problem: it claimed to be part of the
    // wire total while being selected by `pod=~"backup-rclone.+"` with no
    // `id="/"` at all — the shim POD's counters. The shim also answers the
    // backup jobs over the pod network, so its egress includes bytes that
    // never leave the node, and the row routinely exceeded the wire total it
    // claimed to be a part of (2.15 GB inside 1.58 GB, observed). There is no
    // way to isolate off-site bytes at the NIC, so the row is gone rather
    // than quietly wrong.
    const wire = (direction === 'in' ? 'Inbound' : 'Outbound');
    return [
      {
        query: buildTrafficQuery({ ...base }),
        kind: 'direction', fallbackKey: direction, keyPrefix: 'wire',
        nameOverride: `${wire} (wire)`, group: 'wire',
      },
      {
        // Genuinely a subset: same `id="/"` root cgroup, narrowed to the
        // encapsulation interfaces. Measured with the same instrument as the
        // total it sits under, which is what makes it comparable.
        query: buildTrafficQuery({ ...base, wireSubset: 'node-to-node' }),
        kind: 'direction', fallbackKey: direction, keyPrefix: 'n2n',
        nameOverride: `Node-to-node (${direction})`, group: 'wire-subset',
      },
    ];
  }

  if (req.backups === 'included' || req.metric !== 'traffic') {
    const single = isSingleSubject(req);
    return [{
      query: buildTrafficQuery({ ...base }),
      kind: single ? 'direction' : 'subject',
      fallbackKey: direction,
      // A direction line is named for its direction; a subject line takes its
      // name from the label the query grouped by.
      nameOverride: single ? (directionLabel || undefined) : undefined,
      keyPrefix: single ? undefined : direction,
    }];
  }

  const classes = (Object.keys(BACKUP_CLASS_POD_RE) as Array<keyof typeof BACKUP_CLASS_POD_RE>).map((cls) => ({
    query: buildTrafficQuery({ ...base, scope: 'backup-class', backupClass: cls }),
    kind: 'backup-class' as const,
    fallbackKey: cls,
    nameOverride: BACKUP_CLASS_LABEL[cls],
    keyPrefix: 'backup',
  }));

  if (req.backups === 'only') return classes;
  return [
    {
      query: buildTrafficQuery({ ...base, backups: 'exclude' }),
      kind: 'serving' as const,
      fallbackKey: 'serving',
      nameOverride: 'Serving traffic',
    },
    ...classes,
  ];
}

const BACKUP_CLASS_LABEL: Record<keyof typeof BACKUP_CLASS_POD_RE, string> = {
  'tenant-bundles': 'Backup · tenant bundles',
  'mail-snapshots': 'Backup · mail server snapshots',
  databases: 'Backup · databases',
  system: 'Backup · cluster state & secrets',
};

/**
 * Per-tenant egress beyond metric retention, from the meter's daily rollup.
 *
 * These rows are GB already billed, so the frame reports a rate derived from
 * them rather than re-deriving one: value ÷ 86400 gives bytes/s over the day,
 * which is what the chart's y-axis means everywhere else.
 */
async function dailyTenantFrame(req: TrafficRequest, db: Database, unit: TrafficUnit): Promise<TrafficFrame> {
  const rows = await db
    .select({
      tenantId: usageMetrics.tenantId,
      ts: usageMetrics.measurementTimestamp,
      value: usageMetrics.value,
      name: tenants.name,
      ns: tenants.kubernetesNamespace,
    })
    .from(usageMetrics)
    .innerJoin(tenants, eq(tenants.id, usageMetrics.tenantId))
    .where(and(
      eq(usageMetrics.metricType, 'bandwidth_gb'),
      eq(usageMetrics.resolution, 'daily'),
      gte(usageMetrics.measurementTimestamp, req.from),
      lte(usageMetrics.measurementTimestamp, req.to),
      req.subject ? eq(tenants.kubernetesNamespace, req.subject) : sql`true`,
    ));

  const stepSeconds = 86_400;
  const timeline = buildTimeline(req.from.getTime(), req.to.getTime(), stepSeconds);
  const byTenant = new Map<string, { name: string; at: Map<number, number> }>();
  for (const r of rows) {
    const bucket = Math.floor(r.ts.getTime() / (stepSeconds * 1000)) * stepSeconds * 1000;
    const entry = byTenant.get(r.tenantId) ?? { name: r.name, at: new Map() };
    // GB over the day → bytes per second, the unit every other frame uses.
    entry.at.set(bucket, (entry.at.get(bucket) ?? 0) + (Number(r.value) * 1e9) / stepSeconds);
    byTenant.set(r.tenantId, entry);
  }

  const ranked = [...byTenant.entries()].map(([id, e]) => ({
    key: id,
    name: e.name,
    points: timeline.map((t) => e.at.get(t) ?? null),
  }));
  const folded = foldTail(ranked, unit, stepSeconds);

  return {
    from: req.from.toISOString(),
    to: req.to.toISOString(),
    stepSeconds,
    times: timeline.map((t) => new Date(t).toISOString()),
    unit,
    resolution: 'daily',
    series: req.subject
      ? ranked.map((r) => ({ key: r.key, name: r.name, kind: 'direction' as const, points: r.points }))
      : folded.series,
    othersFolded: req.subject ? 0 : folded.othersFolded,
    clamped: false,
  };
}

/** Ranked picker entries for a scope, measured over the same range. */
export async function fetchTrafficSubjects(
  req: Omit<TrafficRequest, 'direction' | 'backups'> & { direction?: never },
  deps: TrafficServiceDeps,
): Promise<TrafficSubject[]> {
  // `noFold`: a picker that only offered the top four would hide exactly the
  // subject somebody opened it to look for.
  const frame = await fetchTrafficFrame(
    { ...req, direction: 'out', backups: 'included' },
    deps,
    { noFold: true },
  );
  return frame.series
    .filter((s) => s.kind === 'subject')
    .map((s) => ({
      key: subjectIdOf(s.key),
      name: s.name,
      value: frame.unit === 'milliseconds' ? meanOf(s.points) : integrate(s.points, frame.stepSeconds),
      unit: frame.unit,
    }))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
}

export { UnsupportedTrafficQuery, rankValue };
