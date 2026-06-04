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
import { upgradeApplyRequestSchema, rollbackRequestSchema } from '@insula/api-contracts';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { collectPreflightFacts } from './collect-preflight.js';
import { evaluatePreflight } from './preflight.js';
import { runUpgrade, dbSettings } from './orchestrate.js';
import { captureUpgradeRescue, runRollback, realRollbackDeps } from './rollback.js';
import { readPostflightState } from './collect-postflight.js';
import { readHostMigrationsPreview } from './host-migrations-preview.js';

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

  // GET /api/v1/admin/platform/upgrade/postflight — read the last persisted
  // post-flight convergence assessment (the streak is advanced by the scheduler,
  // NOT by this read, so a fast UI poll can't inflate it toward abort).
  app.get('/admin/platform/upgrade/postflight', {
    schema: {
      tags: ['Platform Updates'], summary: 'Read upgrade post-flight convergence state', security: [{ bearerAuth: [] }],
      response: { 200: { type: 'object', properties: { data: {
        type: 'object', properties: {
          phase: { type: 'string' }, verdict: { type: 'string' }, consecutiveFailures: { type: 'number' },
          abortThreshold: { type: 'number' }, pendingVersion: { type: 'string', nullable: true }, runningVersion: { type: 'string' },
          gates: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, status: { type: 'string' }, detail: { type: 'string' } } } },
          ok: { type: 'boolean' }, failures: { type: 'number' }, warnings: { type: 'number' },
          lastCheckedAt: { type: 'string', nullable: true }, environment: { type: 'string' },
        },
      } } } },
    },
  }, async () => {
    return success(await readPostflightState(app.db));
  });

  // GET /api/v1/admin/platform/upgrade/host-migrations — whether host-migrations
  // would run during an upgrade (the embedded scripts aren't backend-visible; the
  // policy CM mode is). The UI links the operator to the full runbook.
  app.get('/admin/platform/upgrade/host-migrations', {
    schema: {
      tags: ['Platform Updates'], summary: 'Preview host-migration policy for upgrades', security: [{ bearerAuth: [] }],
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: {
        mode: { type: 'string' }, willRun: { type: 'boolean' }, note: { type: 'string' },
      } } } } },
    },
  }, async () => {
    const k8s = createK8sClients(kubeconfigPath());
    return success(await readHostMigrationsPreview(k8s));
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
      // On an apply, a rescue snapshot + rollback manifest is captured before the
      // re-pin (W16); a failed capture aborts the upgrade inside runUpgrade.
      const rollback = apply ? { capture: (input: { fromVersion: string | null; toVersion: string }) => captureUpgradeRescue(realRollbackDeps(app.db, k8s), input).then((c) => ({ ok: c.ok, reason: c.reason })) } : undefined;
      const r = await runUpgrade(dbSettings(app.db), k8s, { mode: 'manual', requestedVersion: parsed.data.version, apply, rollback });
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

  // POST /api/v1/admin/platform/rollback  { apply?, restoreData? }
  // Undo the most recent applied upgrade: re-pin the Flux source back to the
  // recorded pre-upgrade ref (revision rollback). With restoreData:true ALSO
  // reverts the Longhorn rescue snapshots (DESTRUCTIVE — undoes data changes).
  app.post('/admin/platform/rollback', {
    schema: {
      tags: ['Platform Updates'], summary: 'Roll back the most recent platform upgrade', security: [{ bearerAuth: [] }],
      body: { type: 'object', properties: { apply: { type: 'boolean' }, restoreData: { type: 'boolean' } }, additionalProperties: false },
    },
  }, async (request) => {
    const parsed = rollbackRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'invalid request', 400);
    const k8s = createK8sClients(kubeconfigPath());
    try {
      const r = await runRollback(realRollbackDeps(app.db, k8s), { apply: parsed.data.apply === true, restoreData: parsed.data.restoreData === true });
      return success({
        ok: r.ok,
        dataRestored: r.dataRestored,
        reason: r.reason ?? null,
        summary: r.summary,
        manifest: r.manifest ? { toVersion: r.manifest.toVersion, fromVersion: r.manifest.fromVersion, gitRepository: r.manifest.gitRepository, previousRef: r.manifest.previousRef, rescueSnapshots: r.manifest.rescueSnapshots.length, status: r.manifest.status, createdAt: r.manifest.createdAt } : null,
      });
    } catch (err) {
      app.log.error({ err }, 'platform rollback failed');
      throw new ApiError('ROLLBACK_FAILED', 'the rollback could not be applied (see server logs)', 502);
    }
  });
}
