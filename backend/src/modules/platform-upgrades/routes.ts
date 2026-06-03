/**
 * Platform upgrade routes (ADR-045 W14) — super_admin-only.
 *   GET  /admin/platform/upgrade/preflight  — read-only gate evaluation
 *   POST /admin/platform/upgrade            — plan (dry-run) or apply the Flux re-pin
 *
 * The apply path is the SAME host-side-equivalent orchestrator `platform-ops
 * upgrade` uses; the backend pod issuing the single atomic re-pin patch is safe
 * (per the PR-18 spike) — it does not need to survive its own re-pin.
 */
import type { FastifyInstance } from 'fastify';
import { upgradeApplyRequestSchema } from '@insula/api-contracts';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { collectPreflightFacts } from './collect-preflight.js';
import { evaluatePreflight } from './preflight.js';
import { runUpgrade, dbSettings } from './orchestrate.js';

const ENVIRONMENT = process.env.PLATFORM_ENV ?? 'production';

export async function platformUpgradeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  // Cluster-wide, destructive-capable → super_admin only (stricter than version).
  app.addHook('onRequest', requireRole('super_admin'));

  const kubeconfigPath = () => (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;

  const gateProps = {
    gates: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, status: { type: 'string' }, detail: { type: 'string' } } } },
    ok: { type: 'boolean' }, failures: { type: 'number' }, warnings: { type: 'number' }, environment: { type: 'string' },
  };

  // GET /api/v1/admin/platform/upgrade/preflight
  app.get('/admin/platform/upgrade/preflight', {
    schema: {
      tags: ['Platform Updates'], summary: 'Evaluate upgrade pre-flight gates', security: [{ bearerAuth: [] }],
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: gateProps } } } },
    },
  }, async () => {
    const k8s = createK8sClients(kubeconfigPath());
    const facts = await collectPreflightFacts(app.db, k8s, Date.now());
    const result = evaluatePreflight(facts);
    return success({ ...result, environment: ENVIRONMENT });
  });

  // POST /api/v1/admin/platform/upgrade  { version?, apply? }
  app.post('/admin/platform/upgrade', {
    schema: {
      tags: ['Platform Updates'], summary: 'Plan or apply a platform upgrade (Flux re-pin)', security: [{ bearerAuth: [] }],
      body: { type: 'object', properties: { version: { type: 'string' }, apply: { type: 'boolean' } }, additionalProperties: false },
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: {
        action: { type: 'string' }, target: { type: 'string', nullable: true }, reason: { type: 'string' },
        proceed: { type: 'boolean' }, applied: { type: 'boolean' }, gitRepository: { type: 'string', nullable: true },
        environment: { type: 'string' }, summary: { type: 'string' },
      } } } } },
    },
  }, async (request) => {
    const parsed = upgradeApplyRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'invalid request', 400);
    const apply = parsed.data.apply ?? false;
    const k8s = createK8sClients(kubeconfigPath()); // one client for both the gate + the re-pin

    // An APPLY must pass pre-flight (no hard failures) — a dry-run plan does not.
    if (apply) {
      const pf = evaluatePreflight(await collectPreflightFacts(app.db, k8s, Date.now()));
      if (!pf.ok) {
        throw new ApiError('UPGRADE_PREFLIGHT_FAILED', `pre-flight has ${pf.failures} blocking failure(s); resolve them or run a dry-run first`, 409);
      }
    }

    try {
      const r = await runUpgrade(dbSettings(app.db), k8s, { mode: 'manual', requestedVersion: parsed.data.version, apply });
      return success({
        action: r.decision.action,
        target: r.decision.target,
        reason: r.decision.reason,
        proceed: r.decision.proceed,
        applied: r.applied,
        gitRepository: r.gitRepository,
        environment: r.environment,
        summary: r.summary,
      });
    } catch (err) {
      // A k8s patch / API error must not propagate raw to the client (could leak
      // internal topology) — log server-side, return a clean error.
      app.log.error({ err }, 'platform upgrade apply failed');
      throw new ApiError('UPGRADE_FAILED', 'the upgrade re-pin could not be applied (see server logs)', 502);
    }
  });
}
