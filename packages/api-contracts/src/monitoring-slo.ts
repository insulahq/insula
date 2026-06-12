import { z } from 'zod';

// ADR-051 phase 3: SLO alert evaluation surfaces. The rule PACK lives
// in backend code (modules/monitoring/rules.ts) — these schemas cover
// the admin API: rule status listing, alert state, the panel-ID-keyed
// series proxy, and per-rule overrides.

export const monitoringSeveritySchema = z.enum(['warning', 'critical']);
export type MonitoringSeverity = z.infer<typeof monitoringSeveritySchema>;

export const alertStateValueSchema = z.enum(['firing', 'resolved']);
export type AlertStateValue = z.infer<typeof alertStateValueSchema>;

/** One rule's definition + live evaluation state, as listed by GET /admin/monitoring/slo. */
export const sloRuleStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  severity: monitoringSeveritySchema,
  /** PromQL/MetricsQL expression (informational — evaluation is server-side). */
  expr: z.string(),
  /** Seconds the expression must hold before the alert fires. */
  forSeconds: z.number().int().nonnegative(),
  /** False when disabled via override. */
  enabled: z.boolean(),
  /** Override threshold applied (null = pack default). */
  thresholdOverride: z.number().nullable(),
  state: alertStateValueSchema.nullable(),
  since: z.string().datetime().nullable(),
  lastValue: z.number().nullable(),
  lastEvaluatedAt: z.string().datetime().nullable(),
});
export type SloRuleStatus = z.infer<typeof sloRuleStatusSchema>;

export const sloStatusResponseSchema = z.object({
  rules: z.array(sloRuleStatusSchema),
  /** Evaluator heartbeat — null until the first claimed tick. */
  lastEvaluationAt: z.string().datetime().nullable(),
  /** True when the last N vm-client queries failed (monitoring-unreachable). */
  vmReachable: z.boolean(),
});
export type SloStatusResponse = z.infer<typeof sloStatusResponseSchema>;

/** A single point in a proxied series (epoch seconds + value). */
export const sloSeriesPointSchema = z.tuple([z.number(), z.number()]);

export const sloSeriesSchema = z.object({
  /** Label set identifying the series (already reduced server-side). */
  labels: z.record(z.string(), z.string()),
  points: z.array(sloSeriesPointSchema),
});

/**
 * GET /admin/monitoring/series?panel=<id>&minutes=<n> — panel IDs map to
 * server-side PromQL (no arbitrary expressions from the browser; the
 * admin-gated VMUI is the ad-hoc surface).
 */
export const sloSeriesResponseSchema = z.object({
  panel: z.string(),
  unit: z.string(),
  series: z.array(sloSeriesSchema),
});
export type SloSeriesResponse = z.infer<typeof sloSeriesResponseSchema>;

export const monitoringRuleOverrideUpdateSchema = z.object({
  /** Replace the rule's threshold (semantics rule-specific); null clears. */
  threshold: z.number().nullable().optional(),
  /** Disable/enable the rule. */
  enabled: z.boolean().optional(),
});
export type MonitoringRuleOverrideUpdate = z.infer<typeof monitoringRuleOverrideUpdateSchema>;
