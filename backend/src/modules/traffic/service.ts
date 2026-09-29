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

import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  TRAFFIC_FINE_RETENTION_DAYS,
  type TrafficFrame, type TrafficMetric, type TrafficScope,
  type TrafficSeries, type TrafficSubject, type TrafficUnit,
} from '@insula/api-contracts';
import { tenants, usageMetrics } from '../../db/schema.js';
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

/** namespace → tenant display name, for every namespace in the frame. */
async function tenantNames(db: Database, namespaces: readonly string[]): Promise<Map<string, string>> {
  if (namespaces.length === 0) return new Map();
  const rows = await db
    .select({ ns: tenants.kubernetesNamespace, name: tenants.name })
    .from(tenants)
    .where(inArray(tenants.kubernetesNamespace, [...namespaces]));
  return new Map(rows.filter((r) => r.ns).map((r) => [r.ns, r.name]));
}

/**
 * A Traefik service label is `<namespace>-<ingress>-<hash>@kubernetescrd`,
 * which is unreadable. Trim the provider suffix and the trailing hash, and
 * lead with the tenant's own name when the namespace is recognised.
 */
export function prettyServiceName(service: string, nsToName: ReadonlyMap<string, string>): string {
  const bare = service.replace(/@[a-z]+$/, '').replace(/-[0-9a-f]{16,}$/, '');
  for (const [ns, name] of nsToName) {
    if (bare === ns || bare.startsWith(`${ns}-`)) {
      const rest = bare.slice(ns.length).replace(/^-/, '').replace(/-ingress$/, '');
      return rest ? `${name} · ${rest}` : name;
    }
  }
  return bare;
}

function displayNameFor(
  scope: TrafficScope, key: string, nsToName: ReadonlyMap<string, string>,
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
  if (scope === 'route') return prettyServiceName(key, nsToName);
  return key;
}

interface DirectionPlan {
  readonly direction: 'in' | 'out';
  readonly label: string;
}

function directionPlans(req: TrafficRequest): DirectionPlan[] {
  if (req.metric !== 'traffic') return [{ direction: 'out', label: '' }];
  // A backup split is about egress: these pods upload to off-site storage and
  // receive almost nothing. Running both directions produced the split TWICE
  // and two identically-named "Serving traffic" rows, which is what the
  // end-to-end run on DEV actually showed.
  if (req.backups !== 'included') return [{ direction: 'out', label: 'Outbound' }];
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
  const collected: Array<{ key: string; name: string; kind: TrafficSeries['kind']; points: Array<number | null> }> = [];
  const namespacesSeen = new Set<string>();

  for (const plan of plans) {
    const specs = planQueries(req, plan.direction, stepSeconds, plan.label);
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
          points: alignToTimeline(row.points, timeline, stepSeconds),
        });
      }
    }
  }
  if (req.scope === 'tenant' && req.subject) namespacesSeen.add(req.subject);

  const nsToName = await tenantNames(deps.db, [...namespacesSeen]);
  for (const s of collected) {
    if (s.kind === 'subject') s.name = displayNameFor(req.scope, s.name, nsToName);
  }

  let series: TrafficSeries[];
  let othersFolded = 0;
  if (opts.noFold || single || req.backups !== 'included' || collected.every((s) => s.kind !== 'subject')) {
    series = collected.map((s) => ({ key: s.key, name: s.name, kind: s.kind, points: s.points }));
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
): PlannedQuery[] {
  const base: Omit<TrafficQueryInput, 'backups' | 'backupClass' | 'scope'> & { scope: TrafficScope } = {
    scope: req.scope,
    metric: req.metric,
    direction,
    stepSeconds,
    subject: req.subject,
    pod: req.pod,
    namespacePrefix: req.restrictToNamespace,
  };

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
  files: 'Backup · tenant files',
  mailboxes: 'Backup · mailboxes',
  databases: 'Backup · databases',
  system: 'Backup · system & secrets',
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
      key: s.key,
      name: s.name,
      value: frame.unit === 'milliseconds' ? meanOf(s.points) : integrate(s.points, frame.stepSeconds),
      unit: frame.unit,
    }))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
}

export { UnsupportedTrafficQuery, rankValue };
