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
import { upgradeApplyRequestSchema, rollbackRequestSchema, toSafeText } from '@insula/api-contracts';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as taskCenter from '../tasks/service.js';
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

  // GET /api/v1/admin/platform/upgrade/progress — LIVE per-Deployment roll
  // progress (the UI polls this every few seconds during an upgrade to render a
  // progress bar). Unlike /postflight (a persisted, scheduler-cadenced verdict),
  // this reads the cluster live so the bar advances smoothly. Read-only.
  app.get('/admin/platform/upgrade/progress', {
    schema: {
      tags: ['Platform Updates'], summary: 'Live per-Deployment upgrade roll progress', security: [{ bearerAuth: [] }],
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: {
        targetTag: { type: 'string', nullable: true }, total: { type: 'number' }, atTarget: { type: 'number' },
        ready: { type: 'number' }, percent: { type: 'number' }, readable: { type: 'boolean' },
        deployments: { type: 'array', items: { type: 'object', properties: {
          name: { type: 'string' }, label: { type: 'string' }, desiredReplicas: { type: 'number' },
          readyReplicas: { type: 'number' }, imageTag: { type: 'string', nullable: true }, atTarget: { type: 'boolean' },
        } } },
      } } } } },
    },
  }, async () => {
    const { collectUpgradeProgress } = await import('./progress.js');
    // Target = the in-flight pending version (as a tag), so `atTarget` counts
    // Deployments already rolled to the release being applied.
    const pending = await readPostflightState(app.db);
    const targetTag = pending.pendingVersion ? `${pending.pendingVersion}` : null;
    const k8s = createK8sClients(kubeconfigPath());
    return success(await collectUpgradeProgress(k8s, targetTag));
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
        // Interruption preview — populated on a DRY-RUN so the confirm modal can
        // tell the operator what will restart before they commit.
        interruption: {
          type: 'object', nullable: true, properties: {
            summary: { type: 'string' }, singleNode: { type: 'boolean' }, nodeCount: { type: 'number', nullable: true },
            tenantWorkloadsAffected: { type: 'boolean' },
            services: { type: 'array', items: { type: 'object', properties: {
              name: { type: 'string' }, label: { type: 'string' }, impact: { type: 'string' },
            } } },
          },
        },
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
      // Attach the interruption preview to a DRY-RUN so the confirm modal can
      // show it before the operator applies. Best-effort — a preview failure must
      // never block the plan.
      let interruption = null;
      if (!apply) {
        try {
          const { computeInterruptionPreview } = await import('./progress.js');
          interruption = await computeInterruptionPreview(k8s);
        } catch { interruption = null; }
      }
      // Record a re-openable Task Center task for an APPLIED upgrade so the
      // operator can close the Upgrades page and reopen live progress from the
      // Tasks chip. refId = target version → idempotent per target. The
      // post-flight reconciler finalizes it (succeeded on convergence).
      // Best-effort: a task-center failure must NEVER fail an upgrade that
      // already re-pinned.
      if (apply && r.applied && r.decision.target) {
        try {
          await taskCenter.start(app.db, {
            kind: 'platform.upgrade',
            refId: r.decision.target,
            scope: 'system',
            userId: null,
            label: toSafeText(`Platform upgrade → ${r.decision.target}`),
            target: { type: 'modal', modal: 'platform-upgrade', modalProps: { version: r.decision.target } },
            progressPct: 0,
            progressText: toSafeText(r.summary.slice(0, 200)),
            details: { toVersion: r.decision.target, gitRepository: r.gitRepository, initiatedBy: request.user?.sub ?? null },
          });
        } catch (err) {
          app.log.error({ err }, 'platform-upgrade task-center start failed (upgrade still applied)');
        }
      }
      return success({
        action: r.decision.action,
        target: r.decision.target,
        reason: r.decision.reason,
        proceed: r.decision.proceed,
        applied: r.applied,
        gitRepository: r.gitRepository,
        environment: r.environment,
        summary: r.summary,
        interruption,
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
      // On an APPLIED rollback, drive the SAME progress / post-flight / Task
      // Center machinery an upgrade uses: record the roll-back target as the
      // in-flight `pending_update_version` and enrol a re-openable task. The
      // post-flight reconciler then tracks convergence to it + finalizes the
      // task (identical UX to an upgrade). Best-effort — never fail an applied
      // rollback on task-wiring.
      if (parsed.data.apply === true && r.ok && r.manifest?.fromVersion) {
        const target = r.manifest.fromVersion;
        try {
          await dbSettings(app.db).set('pending_update_version', target);
          await taskCenter.start(app.db, {
            kind: 'platform.upgrade',
            refId: target,
            scope: 'system',
            userId: null,
            label: toSafeText(`Rollback → ${target}`),
            target: { type: 'modal', modal: 'platform-upgrade', modalProps: { version: target } },
            progressPct: 0,
            progressText: toSafeText(r.summary.slice(0, 200)),
            details: { rollback: true, fromVersion: r.manifest.toVersion, toVersion: target, gitRepository: r.manifest.gitRepository, initiatedBy: request.user?.sub ?? null },
          });
        } catch (err) {
          app.log.error({ err }, 'platform rollback task/pending wiring failed (rollback still applied)');
        }
      }
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
