/**
 * Admin monitoring/SLO routes (ADR-051 phase 3).
 *
 * The series endpoint is a PANEL-ID-KEYED proxy: the browser names a
 * predefined panel, the PromQL lives server-side. Arbitrary expressions
 * never cross the API boundary — ad-hoc exploration is what the
 * admin-gated VMUI at admin.<apex>/metrics/vmui/ is for.
 */
import type { FastifyInstance } from 'fastify';
import { sql, eq } from 'drizzle-orm';
import {
  sloStatusResponseSchema,
  sloSeriesResponseSchema,
  monitoringRuleOverrideUpdateSchema,
  type SloRuleStatus,
} from '@insula/api-contracts';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { alertState, monitoringRuleOverrides, monitoringEvaluatorLease } from '../../db/schema.js';
import { SLO_RULES, MONITORING_UNREACHABLE_RULE_ID, ruleById } from './rules.js';
import { vmReachable } from './evaluator.js';
import { queryRange } from './vm-client.js';

/** Server-side panel registry for the series proxy. */
const SERIES_PANELS: Record<string, { expr: string; unit: string }> = {
  'http-5xx-ratio': {
    expr: 'sum(rate(traefik_entrypoint_requests_total{entrypoint="websecure",code=~"5.."}[5m])) / sum(rate(traefik_entrypoint_requests_total{entrypoint="websecure"}[5m]))',
    unit: 'ratio',
  },
  'http-p95-seconds': {
    expr: 'histogram_quantile(0.95, sum by (le) (rate(traefik_entrypoint_request_duration_seconds_bucket{entrypoint="websecure"}[5m])))',
    unit: 's',
  },
  'cert-min-days': {
    expr: '(min(certmanager_certificate_expiration_timestamp_seconds) - time()) / 86400',
    unit: 'days',
  },
  'longhorn-usage-ratio': {
    expr: 'max by (node) (longhorn_node_storage_usage_bytes / longhorn_node_storage_capacity_bytes)',
    unit: 'ratio',
  },
  'node-memory-ratio': {
    expr: 'max by (node) (container_memory_working_set_bytes{id="/"} / on (node) machine_memory_bytes)',
    unit: 'ratio',
  },
  'node-cpu-ratio': {
    expr: 'max by (node) (rate(container_cpu_usage_seconds_total{id="/"}[5m]) / on (node) machine_cpu_cores)',
    unit: 'ratio',
  },
  'cnpg-up': {
    expr: 'sum(up{job="cnpg"})',
    unit: 'instances',
  },
  'flux-errors-15m': {
    expr: 'sum(max by (kind) (clamp_min(platform_flux_unready_resources, 0)))',
    unit: 'resources',
  },
  'acme-renewals-1h': {
    expr: 'sum(increase(platform_acme_renewals_total{result=~"fired|forced|error"}[1h]))',
    unit: 'orders',
  },
};

export async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/monitoring/slo — rule pack + live state.
  app.get('/admin/monitoring/slo', async () => {
    const [states, overrides, [lease]] = await Promise.all([
      app.db.select().from(alertState),
      app.db.select().from(monitoringRuleOverrides),
      app.db.select().from(monitoringEvaluatorLease),
    ]);
    const stateById = new Map(states.map((s) => [s.ruleId, s]));
    const ovById = new Map(overrides.map((o) => [o.ruleId, o]));

    const rules: SloRuleStatus[] = SLO_RULES.map((r) => {
      const st = stateById.get(r.id);
      const ov = ovById.get(r.id);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        severity: r.severity,
        expr: r.expr,
        forSeconds: r.forSeconds,
        enabled: ov?.enabled ?? true,
        thresholdOverride: ov?.threshold ?? null,
        state: (st?.state as 'firing' | 'resolved' | undefined) ?? null,
        since: st?.since?.toISOString() ?? null,
        lastValue: st?.lastValue ?? null,
        lastEvaluatedAt: st?.lastEvaluatedAt?.toISOString() ?? null,
      };
    });
    // Synthetic watcher rule surfaces too when it has state.
    const unreachable = stateById.get(MONITORING_UNREACHABLE_RULE_ID);
    if (unreachable) {
      rules.push({
        id: MONITORING_UNREACHABLE_RULE_ID,
        name: 'Monitoring unreachable',
        description: 'vmsingle unreachable for consecutive evaluation ticks — SLO alerting is blind.',
        severity: 'critical',
        expr: '(synthetic)',
        forSeconds: 0,
        enabled: true,
        thresholdOverride: null,
        state: (unreachable.state as 'firing' | 'resolved') ?? null,
        since: unreachable.since?.toISOString() ?? null,
        lastValue: unreachable.lastValue ?? null,
        lastEvaluatedAt: unreachable.lastEvaluatedAt?.toISOString() ?? null,
      });
    }

    // Heartbeat comes from the LEASE, not alert_state: a fully healthy
    // cluster writes no alert rows at all, which left the panel saying
    // "not yet run" while the evaluator ticked happily (seen on the
    // first live deploy).
    const lastEval = lease?.lastRunAt ?? null;

    return success(sloStatusResponseSchema.parse({
      rules,
      lastEvaluationAt: lastEval?.toISOString() ?? null,
      vmReachable: vmReachable(),
    }));
  });

  // GET /api/v1/admin/monitoring/alerts — raw alert_state rows.
  app.get('/admin/monitoring/alerts', async () => {
    const states = await app.db
      .select()
      .from(alertState)
      .orderBy(sql`CASE state WHEN 'firing' THEN 0 ELSE 1 END, since DESC`);
    return success(states.map((s) => ({
      ruleId: s.ruleId,
      state: s.state,
      severity: s.severity,
      since: s.since?.toISOString() ?? null,
      lastValue: s.lastValue,
      lastNotifiedAt: s.lastNotifiedAt?.toISOString() ?? null,
      lastEvaluatedAt: s.lastEvaluatedAt?.toISOString() ?? null,
    })));
  });

  // GET /api/v1/admin/monitoring/series?panel=<id>&minutes=<n>
  app.get('/admin/monitoring/series', async (request) => {
    const q = request.query as { panel?: string; minutes?: string };
    const panel = q.panel ?? '';
    const def = SERIES_PANELS[panel];
    if (!def) {
      throw new ApiError(
        'UNKNOWN_PANEL',
        `Unknown series panel '${panel}'. Valid: ${Object.keys(SERIES_PANELS).join(', ')}`,
        400,
      );
    }
    const minutes = Math.min(Math.max(Number(q.minutes ?? '60') || 60, 5), 24 * 60);
    const end = Math.floor(Date.now() / 1000);
    const start = end - minutes * 60;
    const step = Math.max(60, Math.floor((minutes * 60) / 120)); // ≤120 points
    try {
      const series = await queryRange(def.expr, start, end, step);
      return success(sloSeriesResponseSchema.parse({
        panel,
        unit: def.unit,
        series: series.map((s) => ({ labels: s.labels, points: s.points.map(([t, v]) => [t, v]) })),
      }));
    } catch (err) {
      throw new ApiError(
        'MONITORING_QUERY_FAILED',
        `vmsingle query failed: ${err instanceof Error ? err.message : String(err)}`,
        503,
      );
    }
  });

  // PATCH /api/v1/admin/monitoring/rules/:ruleId — threshold/enable override.
  app.patch('/admin/monitoring/rules/:ruleId', {
    preHandler: requireRole('super_admin'),
  }, async (request) => {
    const { ruleId } = request.params as { ruleId: string };
    if (!ruleById(ruleId)) {
      throw new ApiError('RULE_NOT_FOUND', `No such rule '${ruleId}' in the pack`, 404);
    }
    const parsed = monitoringRuleOverrideUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join(', '), 400);
    }
    const actor = (request.user as { sub?: string } | undefined)?.sub ?? null;
    const [existing] = await app.db
      .select()
      .from(monitoringRuleOverrides)
      .where(eq(monitoringRuleOverrides.ruleId, ruleId));
    const next = {
      threshold: parsed.data.threshold !== undefined ? parsed.data.threshold : existing?.threshold ?? null,
      enabled: parsed.data.enabled !== undefined ? parsed.data.enabled : existing?.enabled ?? true,
      updatedAt: new Date(),
      updatedBy: actor,
    };
    if (existing) {
      await app.db.update(monitoringRuleOverrides).set(next).where(eq(monitoringRuleOverrides.ruleId, ruleId));
    } else {
      await app.db.insert(monitoringRuleOverrides).values({ ruleId, ...next });
    }
    return success({ ruleId, ...next, updatedAt: next.updatedAt.toISOString() });
  });
}
