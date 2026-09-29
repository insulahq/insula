import { z } from 'zod';

/**
 * Traffic monitoring — what moved over the wire, for whom, and when.
 *
 * One contract serves both panels. The tenant panel is not a reduced copy of
 * the admin one: it asks the same questions through the same shapes, and the
 * backend narrows the answer to the caller's own tenant. That keeps a tenant
 * from ever naming a scope or subject it does not own, because the narrowing
 * happens after validation rather than inside it.
 */

/**
 * What a series is broken down by.
 *
 * `cluster` is the whole cluster as one line. `backup-class` splits
 * platform-scheduled backup egress by what it was backing up — the counterpart
 * to the bandwidth meter's exclusion, so an operator can see the traffic that
 * no tenant is billed for.
 */
export const TRAFFIC_SCOPES = ['cluster', 'node', 'tenant', 'pod', 'route', 'backup-class'] as const;
export const trafficScopeSchema = z.enum(TRAFFIC_SCOPES);
export type TrafficScope = z.infer<typeof trafficScopeSchema>;

/** Scopes a tenant may ask for. Anything else is 403, not an empty result. */
export const TENANT_TRAFFIC_SCOPES = ['tenant', 'pod', 'route'] as const satisfies readonly TrafficScope[];

export const TRAFFIC_METRICS = ['traffic', 'requests', 'latency'] as const;
export const trafficMetricSchema = z.enum(TRAFFIC_METRICS);
export type TrafficMetric = z.infer<typeof trafficMetricSchema>;

export const trafficDirectionSchema = z.enum(['in', 'out', 'both']);
export type TrafficDirection = z.infer<typeof trafficDirectionSchema>;

/**
 * How platform-scheduled backup egress is shown.
 *
 * `included` folds it into whatever else is drawn; `separate` splits it out
 * beside serving traffic; `only` shows nothing else. The tenant panel never
 * sends anything but `included` — a platform backup is not the tenant's
 * traffic and is subtracted from their meter, so drawing it on their graph
 * would contradict the number above it.
 */
export const trafficBackupModeSchema = z.enum(['included', 'separate', 'only']);
export type TrafficBackupMode = z.infer<typeof trafficBackupModeSchema>;

/**
 * Which backup a `backup-class` series is — named for what the job actually
 * does, checked against the code rather than guessed from the pod prefix.
 *
 * `bk-files-*` and `bk-mbox-*` are two COMPONENTS of one tenant bundle (same
 * `bundleId`, alongside config and secrets), so they are one class, not two.
 * Mail-server snapshots are a separate thing entirely — `stalwart-snapshot-cron-*`
 * — and were missing from the first cut.
 */
export const TRAFFIC_BACKUP_CLASSES = [
  'tenant-bundles', 'mail-snapshots', 'databases', 'system',
] as const;
export const trafficBackupClassSchema = z.enum(TRAFFIC_BACKUP_CLASSES);
export type TrafficBackupClass = z.infer<typeof trafficBackupClassSchema>;

/**
 * Hourly detail is retained for 30 days; past that only daily rollups survive.
 * The response says which regime it is in rather than leaving the caller to
 * infer it from the step, because the two look identical on a chart and only
 * one of them can honestly show a spike.
 */
export const TRAFFIC_FINE_RETENTION_DAYS = 30;

/** Most series returned before the tail is folded into one `Other` row. */
export const TRAFFIC_TOP_N = 4;

/** Ceiling on points per series, so a wide range cannot ask for a huge frame. */
export const TRAFFIC_MAX_POINTS = 400;

/** Widest range the API will serve in one request. */
export const TRAFFIC_MAX_RANGE_DAYS = 400;

const isoDateTime = z.string().refine(
  (s) => !Number.isNaN(Date.parse(s)),
  { message: 'must be an ISO-8601 date-time' },
);

/**
 * Query for a series frame. Sent as URL query parameters, hence the coercion:
 * everything arrives as a string and `subject`/`pod` are free text that must
 * survive being a Kubernetes name, a tenant id, or a hostname.
 */
export const trafficSeriesQuerySchema = z.object({
  from: isoDateTime,
  to: isoDateTime,
  scope: trafficScopeSchema.default('cluster'),
  /** Node name, tenant id, pod name or route host — meaning follows `scope`. */
  subject: z.string().min(1).max(253).optional(),
  /** Narrows a `tenant` scope to one of that tenant's pods. */
  pod: z.string().min(1).max(253).optional(),
  metric: trafficMetricSchema.default('traffic'),
  direction: trafficDirectionSchema.default('both'),
  backups: trafficBackupModeSchema.default('included'),
}).strict().refine(
  (q) => Date.parse(q.to) > Date.parse(q.from),
  { message: '`to` must be after `from`', path: ['to'] },
).refine(
  (q) => (Date.parse(q.to) - Date.parse(q.from)) <= TRAFFIC_MAX_RANGE_DAYS * 86400_000,
  { message: `range may not exceed ${TRAFFIC_MAX_RANGE_DAYS} days`, path: ['to'] },
);
export type TrafficSeriesQuery = z.infer<typeof trafficSeriesQuerySchema>;

export const trafficUnitSchema = z.enum(['bytes', 'requests', 'milliseconds']);
export type TrafficUnit = z.infer<typeof trafficUnitSchema>;

/**
 * One line on the chart.
 *
 * `points` is index-aligned to the frame's `times`, and a gap is `null` rather
 * than 0 — a scrape that did not happen is not an hour of silence, and drawing
 * it as zero invents a dip that never occurred.
 */
/**
 * Which measurement a series belongs to, and whether it can be added up.
 *
 * `wire` is the node's own NIC — the ground truth for what crossed the
 * network. `wire-subset` is part of that same total seen another way
 * (node-to-node encapsulation, the off-site backup upload): real, useful,
 * and already inside `wire`, so adding it would double count.
 *
 * `workload` is measured at the pods. It does NOT decompose the wire:
 * backups travel pod → in-cluster shim → off-site, so those bytes appear
 * twice, and pod-to-pod traffic never reaches the NIC at all. Kept because
 * it is the only per-class detail there is — labelled, not blended.
 */
export const trafficSeriesGroupSchema = z.enum(['wire', 'wire-subset', 'workload']);
export type TrafficSeriesGroup = z.infer<typeof trafficSeriesGroupSchema>;

export const trafficSeriesSchema = z.object({
  /** Stable identity: a node name, tenant id, pod name, `in`/`out`, a class. */
  key: z.string(),
  /** What to show a human. For a tenant this is their display name. */
  name: z.string(),
  kind: z.enum(['direction', 'subject', 'backup-class', 'serving', 'other']),
  /** Absent means an ordinary single-measurement frame. */
  group: trafficSeriesGroupSchema.optional(),
  points: z.array(z.number().nullable()),
});
export type TrafficSeries = z.infer<typeof trafficSeriesSchema>;

export const trafficFrameSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** Seconds between points. */
  stepSeconds: z.number().int().positive(),
  /** ISO-8601 instants, one per index in every series' `points`. */
  times: z.array(z.string()),
  unit: trafficUnitSchema,
  /** `daily` means the fine-grained rows have aged out; spikes are averaged. */
  resolution: z.enum(['fine', 'daily']),
  series: z.array(trafficSeriesSchema),
  /** How many subjects were folded into the `Other` series (0 if none were). */
  othersFolded: z.number().int().nonnegative(),
  /**
   * True when `from` is later than what was asked for. Metric retention is
   * 30 days and only per-tenant egress is rolled up beyond it, so a wider
   * request at any other breakdown is served short rather than padded with
   * zeroes — and says so, instead of drawing an empty month as quiet.
   */
  clamped: z.boolean(),
});
export type TrafficFrame = z.infer<typeof trafficFrameSchema>;

/** An entry in a scope picker, ranked by the metric currently being viewed. */
export const trafficSubjectSchema = z.object({
  key: z.string(),
  name: z.string(),
  /** Total over the range (or the mean, for latency). Null when unmeasured. */
  value: z.number().nullable(),
  unit: trafficUnitSchema,
});
export type TrafficSubject = z.infer<typeof trafficSubjectSchema>;

export const trafficSubjectsQuerySchema = z.object({
  from: isoDateTime,
  to: isoDateTime,
  scope: trafficScopeSchema,
  /** For `pod` scope: which tenant's pods to list. */
  subject: z.string().min(1).max(253).optional(),
  metric: trafficMetricSchema.default('traffic'),
}).strict();
export type TrafficSubjectsQuery = z.infer<typeof trafficSubjectsQuerySchema>;

export const trafficSubjectsResponseSchema = z.object({
  subjects: z.array(trafficSubjectSchema),
});
export type TrafficSubjectsResponse = z.infer<typeof trafficSubjectsResponseSchema>;
