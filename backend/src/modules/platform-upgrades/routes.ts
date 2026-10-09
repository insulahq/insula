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
import { upgradeApplyRequestSchema, upgradePreflightQuerySchema, rollbackRequestSchema, toSafeText } from '@insula/api-contracts';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as taskCenter from '../tasks/service.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { collectPreflightFacts } from './collect-preflight.js';
import { evaluatePreflight } from './preflight.js';
import { runUpgrade, dbSettings } from './orchestrate.js';
import { runRollback, realRollbackDeps } from './rollback.js';
import { readPostflightState } from './collect-postflight.js';
import { readHostMigrationsPreview } from './host-migrations-preview.js';
import { readHostMigrationStatus } from './host-migration-status.js';
import { readUpgradeChanges } from './release-changes.js';
import { startRunWithTask, abortActiveRun, cancelPreparingRun } from './run/real.js';
import { getActiveRun, getRun, listRuns, toUpgradeRun } from './run/store.js';

const ENVIRONMENT = process.env.PLATFORM_ENV ?? 'production';
// The release this pod serves — what each node's CLI is compared against.
const RUNNING_VERSION = (process.env.PLATFORM_VERSION ?? '').trim().replace(/^v/, '') || null;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// An upgrade run as the API returns it (ADR-064). Every field is declared: the
// response serializer drops anything that is not.
const runJsonSchema = {
  type: 'object', nullable: true, properties: {
    id: { type: 'string' }, fromVersion: { type: 'string', nullable: true }, toVersion: { type: 'string' },
    mode: { type: 'string' }, status: { type: 'string' }, step: { type: 'string' },
    excludedNodes: { type: 'array', items: { type: 'string' } },
    nodes: { type: 'array', items: { type: 'object', properties: {
      node: { type: 'string' }, state: { type: 'string' }, cliVersion: { type: 'string', nullable: true }, detail: { type: 'string' },
      hostChanges: { type: 'object', nullable: true, properties: { done: { type: 'number' }, total: { type: 'number' } } },
    } } },
    message: { type: 'string', nullable: true }, startedAt: { type: 'string' }, stepStartedAt: { type: 'string' },
    finishedAt: { type: 'string', nullable: true },
  },
} as const;

/** Start an upgrade run for a decided target, and the Task Center task that tracks it. */
async function startRunFor(
  db: FastifyInstance['db'],
  k8s: ReturnType<typeof createK8sClients>,
  sub: string | null,
  r: Awaited<ReturnType<typeof runUpgrade>>,
  excluded: string[],
) {
  const target = r.decision.target as string;
  const installed = (await dbSettings(db).get('installed_platform_version'))?.trim() || null;
  const run = await startRunWithTask(db, k8s, {
    fromVersion: installed,
    toVersion: target,
    mode: 'manual',
    excludedNodes: excluded,
    initiatedBy: sub && UUID_RE.test(sub) ? sub : null,
  });
  const started = run.status === 'running';
  return {
    action: r.decision.action,
    target,
    reason: r.decision.reason,
    proceed: r.decision.proceed,
    applied: started,
    gitRepository: r.gitRepository,
    environment: r.environment,
    summary: started
      ? `Upgrade to ${target} started: every node takes the release first, then the services roll.`
      : run.message ?? 'the upgrade could not be started',
    interruption: null,
    runId: run.id,
  };
}

export async function platformUpgradeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  // Cluster-wide, destructive-capable → super_admin only (stricter than version).
  app.addHook('onRequest', requireRole('super_admin'));

  const kubeconfigPath = () => (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;

  const gateProps = {
    gates: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, status: { type: 'string' }, detail: { type: 'string' }, scheduled: { type: 'boolean' } } } },
    ok: { type: 'boolean' }, failures: { type: 'number' }, warnings: { type: 'number' }, environment: { type: 'string' },
  };

  // GET /api/v1/admin/platform/upgrade/preflight
  app.get('/admin/platform/upgrade/preflight', {
    schema: {
      tags: ['Platform Updates'], summary: 'Evaluate upgrade pre-flight gates', security: [{ bearerAuth: [] }],
      querystring: { type: 'object', properties: { exclude: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: gateProps } } } },
    },
  }, async (request) => {
    // ?exclude=a,b — judge the nodes the way the apply with those exclusions would.
    const q = upgradePreflightQuerySchema.safeParse(request.query ?? {});
    if (!q.success) throw new ApiError('VALIDATION_ERROR', q.error.issues[0]?.message ?? 'invalid query', 400);
    const k8s = createK8sClients(kubeconfigPath());
    const facts = await collectPreflightFacts(app.db, k8s, Date.now(), q.data.exclude);
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
          gates: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, status: { type: 'string' }, detail: { type: 'string' }, scheduled: { type: 'boolean' } } } },
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
          phase: { type: 'string' },
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

  // GET /api/v1/admin/platform/migrations — the PLATFORM-migration registry.
  //
  // The sibling endpoint below does this for HOST migrations, for exactly the
  // reason in its comment ("the only way to find out was to SSH to a node").
  // The platform registry never got the same treatment, and it bit identically
  // migration 0009 403'd, the registry HALTED, and DEV, STAGING
  // and production all ran for days with an unconverged base. The only trace
  // was one warn line in a pod log; `insula migrations list` over SSH was the
  // only query surface. It surfaced as a wildcard certificate stuck "Issuing"
  // because the ClusterIssuer it referenced had never been created.
  //
  // Read-only: applying is startup's job (and `insula migrations apply`).
  app.get('/admin/platform/migrations', {
    schema: {
      tags: ['Platform Updates'], summary: 'Platform-migration registry status', security: [{ bearerAuth: [] }],
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: {
        converged: { type: 'boolean' },
        pending: { type: 'number' },
        drift: { type: 'number' },
        migrations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      } } } } },
    },
  }, async () => {
    const { listMigrationStatus } = await import('./index.js');
    const items = await listMigrationStatus(app.db);
    const pending = items.filter((m) => m.status === 'pending').length;
    const drift = items.filter((m) => m.status === 'drift').length;
    return success({
      // `converged` is the one field a health check needs: everything shipped
      // in this build has applied.
      converged: pending === 0,
      pending,
      drift,
      migrations: items,
    });
  });

  // GET /api/v1/admin/platform/upgrade/changes — what an upgrade to the available
  // release changes (ADR-064 §6): database and platform migrations still to run,
  // and each host change with the nodes it still has to run on.
  app.get('/admin/platform/upgrade/changes', {
    schema: {
      tags: ['Platform Updates'], summary: 'What an upgrade to the available release changes', security: [{ bearerAuth: [] }],
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: {
        fromVersion: { type: 'string', nullable: true }, toVersion: { type: 'string', nullable: true },
        known: { type: 'boolean' }, databaseMigrations: { type: 'number' }, platformMigrations: { type: 'number' },
        hostChanges: { type: 'array', items: { type: 'object', properties: {
          key: { type: 'string' }, phase: { type: 'string' }, description: { type: 'string' },
          nodes: { type: 'array', items: { type: 'string' } },
        } } },
        unreportedNodes: { type: 'array', items: { type: 'string' } },
      } } } } },
    },
  }, async () => {
    const k8s = createK8sClients(kubeconfigPath());
    return success(await readUpgradeChanges(app.db, k8s, RUNNING_VERSION));
  });

  // GET /api/v1/admin/platform/host-migrations/status — per-node applied /
  // pending / failed / blocked state, relayed by the host-config-reconciler
  // DaemonSet. A failed migration blocks every later one, and before this the
  // only way to find out was to SSH to a node: DEV sat at 11 pending behind one
  // failure for five weeks. Read-only by construction — the backend cannot
  // touch a node, and the converge that applies migrations already runs hourly.
  app.get('/admin/platform/host-migrations/status', {
    schema: {
      tags: ['Platform Updates'], summary: 'Per-node host-migration status', security: [{ bearerAuth: [] }],
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: {
        degraded: { type: 'boolean' }, runbookUrl: { type: 'string' },
        targetVersion: { type: 'string', nullable: true },
        nodes: { type: 'array', items: { type: 'object', additionalProperties: true } },
      } } } } },
    },
  }, async () => {
    const k8s = createK8sClients(kubeconfigPath());
    // Nodes are judged against the release this cluster runs: a node whose CLI is
    // older has not seen that release's host-migrations yet.
    return success(await readHostMigrationStatus(k8s, RUNNING_VERSION));
  });

  // POST /api/v1/admin/platform/upgrade  { version?, apply? }
  app.post('/admin/platform/upgrade', {
    schema: {
      tags: ['Platform Updates'], summary: 'Plan or apply a platform upgrade (Flux re-pin)', security: [{ bearerAuth: [] }],
      // EVERY accepted field must be listed: with additionalProperties:false Fastify
      // strips an undeclared one before the handler's Zod parse sees it — that
      // turned "Upgrade without <node>" into "upgrade every node" (refused on the
      // down node's pre-flight). routes.test.ts sends each field through this.
      body: {
        type: 'object',
        properties: {
          version: { type: 'string' },
          apply: { type: 'boolean' },
          excludeNodes: { type: 'array', items: { type: 'string' }, maxItems: 100 },
        },
        additionalProperties: false,
      },
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: {
        action: { type: 'string' }, target: { type: 'string', nullable: true }, reason: { type: 'string' },
        proceed: { type: 'boolean' }, applied: { type: 'boolean' }, gitRepository: { type: 'string', nullable: true },
        environment: { type: 'string' }, summary: { type: 'string' }, runId: { type: 'string', nullable: true },
        // Interruption preview — populated on a DRY-RUN so the confirm modal can
        // tell the operator what will restart before they commit.
        interruption: {
          type: 'object', nullable: true, properties: {
            summary: { type: 'string' }, singleNode: { type: 'boolean' }, noRedundancy: { type: 'boolean' }, nodeCount: { type: 'number', nullable: true },
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
    const excludeNodes = [...new Set(parsed.data.excludeNodes ?? [])];
    const k8s = createK8sClients(kubeconfigPath()); // one client for both the gate + the run

    // An APPLY must pass pre-flight (no hard failures) — a dry-run plan does not.
    if (apply) {
      const pf = evaluatePreflight(await collectPreflightFacts(app.db, k8s, Date.now(), excludeNodes));
      if (!pf.ok) {
        const first = pf.gates.find((g) => g.status === 'fail');
        throw new ApiError('UPGRADE_PREFLIGHT_FAILED', `pre-flight has ${pf.failures} blocking failure(s)${first ? ` — ${first.label}: ${first.detail}` : ''}`, 409);
      }
    }

    try {
      // The decision is the same for a plan and an apply. An apply then starts a
      // RUN (ADR-064): the nodes take the release first; the run re-pins Flux (with
      // the rescue capture) only once every included node is ready.
      const settings = dbSettings(app.db);
      const r = await runUpgrade(settings, k8s, { mode: 'manual', requestedVersion: parsed.data.version, apply: false });
      if (apply && r.decision.proceed && r.decision.target) {
        return success(await startRunFor(app.db, k8s, request.user?.sub ?? null, r, excludeNodes));
      }
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
      return success({
        action: r.decision.action,
        target: r.decision.target,
        reason: r.decision.reason,
        proceed: r.decision.proceed,
        applied: false,
        gitRepository: r.gitRepository,
        environment: r.environment,
        summary: r.summary,
        interruption,
        runId: null,
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // A k8s / API error must not propagate raw to the client (could leak
      // internal topology) — log server-side, return a clean error.
      app.log.error({ err }, 'platform upgrade apply failed');
      throw new ApiError('UPGRADE_FAILED', 'the upgrade could not be started (see server logs)', 502);
    }
  });

  // GET /api/v1/admin/platform/upgrade/run — the run in flight, else the latest
  // one (so a reopened page can show how the last upgrade ended).
  app.get('/admin/platform/upgrade/run', {
    schema: {
      tags: ['Platform Updates'], summary: 'The current (or latest) upgrade run', security: [{ bearerAuth: [] }],
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: { run: runJsonSchema } } } } },
    },
  }, async () => {
    const active = await getActiveRun(app.db);
    const row = active ?? (await listRuns(app.db, 1))[0] ?? null;
    return success({ run: row ? toUpgradeRun(row) : null });
  });

  // POST /api/v1/admin/platform/upgrade/run/cancel — stop a run that is still
  // preparing nodes. Nothing has changed for the services yet, so this is safe;
  // once the services roll, the way back is the rollback.
  app.post('/admin/platform/upgrade/run/cancel', {
    schema: {
      tags: ['Platform Updates'], summary: 'Cancel an upgrade run that is still preparing nodes', security: [{ bearerAuth: [] }],
      response: { 200: { type: 'object', properties: { data: { type: 'object', properties: { run: runJsonSchema } } } } },
    },
  }, async () => {
    const k8s = createK8sClients(kubeconfigPath());
    const row = await cancelPreparingRun(app.db, k8s);
    return success({ run: toUpgradeRun(row) });
  });

  // GET /api/v1/admin/platform/upgrade/runs?limit= — run history, newest first.
  app.get('/admin/platform/upgrade/runs', {
    schema: {
      tags: ['Platform Updates'], summary: 'Upgrade run history', security: [{ bearerAuth: [] }],
      querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } },
      response: { 200: { type: 'object', properties: { data: { type: 'array', items: runJsonSchema } } } },
    },
  }, async (request) => {
    const limit = (request.query as { limit?: number }).limit ?? 20;
    return success((await listRuns(app.db, limit)).map(toUpgradeRun));
  });

  // GET /api/v1/admin/platform/upgrade/runs/:id
  app.get('/admin/platform/upgrade/runs/:id', {
    schema: {
      tags: ['Platform Updates'], summary: 'One upgrade run', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', properties: { data: runJsonSchema } } },
    },
  }, async (request) => {
    const row = await getRun(app.db, (request.params as { id: string }).id);
    if (!row) throw new ApiError('UPGRADE_RUN_NOT_FOUND', 'no such upgrade run', 404);
    return success(toUpgradeRun(row));
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
    // A run still preparing nodes has not changed the services: a rollback now
    // would undo the PREVIOUS upgrade. Cancel the run instead.
    const active = await getActiveRun(app.db);
    if (active && active.step === 'prepare-nodes') {
      throw new ApiError('UPGRADE_RUN_PREPARING', 'The upgrade has not changed the services yet — cancel it instead of rolling back.', 409);
    }
    const k8s = createK8sClients(kubeconfigPath());
    try {
      const r = await runRollback(realRollbackDeps(app.db, k8s), { apply: parsed.data.apply === true, restoreData: parsed.data.restoreData === true });
      // A rollback ends the run in flight (ADR-064): its node Plans stop, and the
      // rollback's own convergence tracking takes over from here.
      if (parsed.data.apply === true && r.ok) {
        await abortActiveRun(app.db, k8s, 'Rolled back by an operator.').catch((err) =>
          app.log.error({ err }, 'could not close the upgrade run after a rollback'));
      }
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
