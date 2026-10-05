/**
 * One-button tenant DR recover (gap G1) — routes.
 *
 * `POST /api/v1/admin/dr/tenants/:tenantId/recover` recovers a tenant's data
 * from an off-site bundle in a single admin call. The orchestration itself —
 * provision → restore cart → items → execute → reconcile, all through the
 * existing routes via `app.inject` — lives in ./orchestrate.ts. With
 * `background: true` it runs as a `dr.recover` task-center task instead of
 * holding the request open (./recover-task.ts); `recover-all` does the same
 * for the batch (./recover-all-task.ts).
 *
 * Auth: `authenticate` (Bearer, NOT session) + `requirePanel('admin')` +
 * `requireRole('super_admin','admin')` — matches the restore-cart routes this
 * endpoint drives.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, desc } from 'drizzle-orm';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError, missingToken } from '../../shared/errors.js';
import { tenants, backupJobs, backupComponents, tenantLifecycleTransitions } from '../../db/schema.js';
import {
  drRecoverRequestSchema,
  drRecoverAllRequestSchema,
  type DrRecoverResponse,
  type DrRecoverAllTarget,
  type DrRecoverAllResult,
  type DrRecoverAllResponse,
  type DrEncryptionKeyPreflight,
  type RestoreJobStatus,
  type DrRecoverAllSkipped,
} from '@insula/api-contracts';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { runDrRecover } from './orchestrate.js';
import { forwardedAuth } from './task-credential.js';

export async function drRecoverRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // What a Recover Tenant would restore: the tenant (from its row, or its
  // bundle's manifest once deleted) and every restorable bundle — so the
  // operator chooses by date and contents, never by an id.
  app.get('/admin/dr/tenants/:tenantId/recovery-info', {
    schema: {
      tags: ['Restore'],
      summary: 'The tenant and bundles a Recover Tenant would restore',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['tenantId'], properties: { tenantId: { type: 'string' } } },
    },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const { bundleId } = request.query as { bundleId?: string };
    const { getRecoveryInfo } = await import('./recovery-info.js');
    return success(await getRecoveryInfo(app, tenantId, { bundleId: bundleId || undefined }));
  });

  app.post('/admin/dr/tenants/:tenantId/recover', {
    schema: {
      tags: ['Restore'],
      summary: 'One-button tenant DR recover from an off-site bundle',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['tenantId'],
        properties: { tenantId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };

    const parsed = drRecoverRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        400,
      );
    }
    const input = parsed.data;

    // Background: validate, enroll a `dr.recover` task, answer at once. The
    // progress modal (and the chip) follow the task; the terminal result lands
    // in its details. The run never holds this request's token — it mints a
    // short-lived one per step for this user. See ./recover-task.ts.
    if (input.background) {
      const { startDrRecoverTask } = await import('./recover-task.js');
      const started = await startDrRecoverTask(app, {
        tenantId,
        input,
        userId: (request.user as { sub: string }).sub,
      });
      return reply.status(202).send(success(started));
    }

    // Synchronous: the caller's Bearer is forwarded into every injected
    // sub-request. The `authenticate` hook already guaranteed it exists; this
    // narrows the type and stays defensive.
    const authHeader = request.headers.authorization;
    if (!authHeader) throw missingToken();

    // Run to the end and answer with the terminal result. /execute is
    // synchronous so `status` is already terminal (done | failed);
    // 202 = "recover orchestration accepted + performed".
    const response = await runDrRecover(app, { tenantId, input, auth: forwardedAuth(authHeader) });
    reply.status(202).send(success(response));
  });

  // ── Batch recover-all (S3: cluster rebuilt → restore N tenants at once) ────
  // Recovers every LOST tenant (has a completed off-site bundle, namespace
  // absent) in one operation, by injecting the single-tenant recover per
  // tenant so the exact validated flow (re-create/provision/restore/reconcile)
  // runs each time. Dry-run previews the target set; scope='missing' (default)
  // never touches a live tenant.
  app.post('/admin/dr/tenants/recover-all', {
    schema: {
      tags: ['Restore'],
      summary: 'Batch DR recover — restore all lost tenants from their off-site bundles',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const parsed = drRecoverAllRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
        400,
      );
    }
    const input = parsed.data;
    const authHeader = request.headers.authorization;
    if (!authHeader) throw missingToken();

    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined
      ?? process.env.KUBECONFIG_PATH ?? process.env.KUBECONFIG;
    const existingNamespaces = await listClusterNamespaces(kubeconfigPath);
    const { targets, skipped } = await resolveRecoverAllTargets(app, input, existingNamespaces);

    // ── R25 §4: can this cluster read its own encrypted credentials? ─────────
    // Local decrypt probes, no network — cheap enough to run on every preview,
    // and it answers before the first namespace is provisioned rather than
    // after the fiftieth. See ./encryption-preflight.ts for what it does and
    // does not cover.
    const { runEncryptionKeyPreflight } = await import('./encryption-preflight.js');
    const encryptionKey: DrEncryptionKeyPreflight = await runEncryptionKeyPreflight(
      app.db,
      (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
        ?? process.env.PLATFORM_ENCRYPTION_KEY,
      targets.map((t) => t.bundleId),
      targets.map((t) => t.tenantId),
    );

    if (input.dryRun) {
      // A preview never refuses — reporting the mismatch IS the preview's job,
      // and an operator who cannot see the finding cannot act on it.
      const dry: DrRecoverAllResponse = {
        dryRun: true, scope: input.scope, total: targets.length, recovered: 0, failed: 0, targets, skipped,
        encryptionKey,
      };
      return reply.status(200).send(success(dry));
    }

    // A real run stops here. Every per-tenant recover provisions a namespace,
    // PVC and quota BEFORE it reaches anything that needs a cleartext secret,
    // so proceeding would leave a fleet of freshly provisioned, empty tenants
    // behind a failure that was knowable up front.
    if (encryptionKey.verdict === 'mismatch' && !input.allowEncryptionKeyMismatch) {
      throw new ApiError(
        'DR_ENCRYPTION_KEY_MISMATCH',
        encryptionKey.summary,
        409,
        {
          probed: encryptionKey.probed,
          failed: encryptionKey.failed,
          sources: [...new Set(encryptionKey.probes.filter((p) => p.verdict === 'wrong_key').map((p) => p.source))],
        },
        encryptionKey.remedy ?? undefined,
      );
    }

    // Background: the gate above has already answered, so a refusal still
    // provisions nothing. Enroll a `dr.recover-all` task and answer at once;
    // each tenant then runs as a child `dr.recover` task. See ./recover-all-task.ts.
    if (input.background) {
      const { startDrRecoverAllTask } = await import('./recover-all-task.js');
      const started = await startDrRecoverAllTask(app, {
        scope: input.scope,
        targets,
        skipped,
        encryptionKey,
        perTenant: {
          ...(input.targetNode ? { targetNode: input.targetNode } : {}),
          ...(input.components ? { components: input.components } : {}),
        },
        userId: (request.user as { sub: string }).sub,
      });
      return reply.status(202).send(success(started));
    }

    // SEQUENTIAL by design: a freshly-rebuilt cluster is fragile and each
    // provision+restore is heavy; parallel recovers would hammer it.
    const results: DrRecoverAllResult[] = [];
    for (const t of targets) {
      const body: Record<string, unknown> = { bundleId: t.bundleId };
      if (input.targetNode) body.targetNode = input.targetNode;
      if (input.components) body.components = input.components;

      let ok = false; let status: RestoreJobStatus | null = null; let recreated = false; let error: string | null = null;
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/admin/dr/tenants/${encodeURIComponent(t.tenantId)}/recover`,
          headers: { authorization: authHeader, 'content-type': 'application/json' },
          payload: JSON.stringify(body),
        });
        ok = res.statusCode >= 200 && res.statusCode < 300;
        let pb: { data?: DrRecoverResponse; error?: { message?: string } } | null = null;
        try { pb = res.json(); } catch { pb = null; }
        status = pb?.data?.status ?? null;
        recreated = pb?.data?.recreated ?? false;
        if (!ok) error = pb?.error?.message ?? `HTTP ${res.statusCode}`;
        else if (status === 'failed') { ok = false; error = 'restore cart reported failed'; }
      } catch (err) {
        ok = false; error = err instanceof Error ? err.message : String(err);
      }
      results.push({ ...t, ok, status, recreated, error });
    }

    const response: DrRecoverAllResponse = {
      dryRun: false,
      scope: input.scope,
      total: results.length,
      recovered: results.filter((r) => r.ok && r.status === 'done').length,
      failed: results.filter((r) => !r.ok || r.status === 'failed').length,
      results,
      skipped,
      encryptionKey,
    };
    reply.status(202).send(success(response));
  });
}

/** Snapshot the cluster's namespace names (empty set on any API error). */
async function listClusterNamespaces(kubeconfigPath?: string): Promise<Set<string>> {
  try {
    const k8s = createK8sClients(kubeconfigPath);
    const res = await k8s.core.listNamespace();
    const out = new Set<string>();
    for (const ns of (res.items ?? [])) {
      const n = ns.metadata?.name;
      if (n) out.add(n);
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Resolve the tenants a batch recover should target. Candidates are the
 * explicit `tenantIds`, else every tenant with a bundle. Each candidate
 * resolves to its NEWEST completed bundle; `scope: 'missing'` drops tenants
 * whose namespace still exists (never restores over a live tenant).
 *
 * A tenant DELETED on purpose is not a candidate unless named: its backup_jobs
 * rows survive the delete (loose FK, retained bundles), and this used to rely
 * on them being cascade-dropped — so a fleet "recover all" would have quietly
 * re-created every tenant deleted within the retention window.
 */
/**
 * Resolve which tenants a batch recover would act on — AND which it would pass
 * over, and why (ROADMAP R25 §3).
 *
 * The previous version dropped both classes of non-target with a bare
 * `continue`, so the dry run answered "12 targets" and said nothing about the
 * three tenants it had skipped. That is the wrong silence for the question a
 * fleet migration is actually asking: an omission reads exactly like a tenant
 * that does not exist, and the operator finds out per-tenant, during the
 * migration, one failure at a time.
 *
 * It matters most for an EXPLICIT `tenantIds` list — the operator named those
 * tenants, so a name that comes back in neither list is a silent contradiction
 * of their request.
 */
export async function resolveRecoverAllTargets(
  app: FastifyInstance,
  input: { tenantIds?: readonly string[]; scope: 'missing' | 'all' },
  existingNamespaces: ReadonlySet<string>,
  now: Date = new Date(),
): Promise<{ targets: DrRecoverAllTarget[]; skipped: DrRecoverAllSkipped[] }> {
  let candidateIds: string[];
  if (input.tenantIds && input.tenantIds.length > 0) {
    candidateIds = [...input.tenantIds];
  } else {
    // Widened from `status = 'completed'` to every tenant that has EVER had a
    // bundle: a tenant whose only bundles are partial/failed is precisely the
    // one worth reporting, and the old filter made it unrepresentable.
    const rows = await app.db.selectDistinct({ tenantId: backupJobs.tenantId }).from(backupJobs);
    candidateIds = rows.map((r) => r.tenantId);
  }

  const targets: DrRecoverAllTarget[] = [];
  const skipped: DrRecoverAllSkipped[] = [];

  const named = Boolean(input.tenantIds && input.tenantIds.length > 0);
  for (const tenantId of candidateIds) {
    const [t] = await app.db.select({ name: tenants.name, ns: tenants.kubernetesNamespace })
      .from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    let tenantName: string | null = t?.name ?? null;

    if (!t && !named) {
      const [del] = await app.db
        .select({ detail: tenantLifecycleTransitions.detail, namespace: tenantLifecycleTransitions.namespace, at: tenantLifecycleTransitions.startedAt })
        .from(tenantLifecycleTransitions)
        .where(and(eq(tenantLifecycleTransitions.tenantId, tenantId), eq(tenantLifecycleTransitions.transitionKind, 'deleted')))
        .orderBy(desc(tenantLifecycleTransitions.startedAt))
        .limit(1);
      if (del) {
        const { slugFromNamespace } = await import('../tenant-bundles/recoverable.js');
        tenantName = (del.detail as { tenantName?: string } | null)?.tenantName ?? slugFromNamespace(del.namespace) ?? null;
        const [latest] = await app.db.select({ status: backupJobs.status, createdAt: backupJobs.createdAt })
          .from(backupJobs).where(eq(backupJobs.tenantId, tenantId))
          .orderBy(desc(backupJobs.createdAt)).limit(1);
        skipped.push({
          tenantId,
          tenantName,
          reason: 'deleted',
          latestBundleStatus: latest?.status ?? null,
          latestBundleAt: latest?.createdAt ? new Date(latest.createdAt).toISOString() : null,
        });
        continue;
      }
    }

    const [bundle] = await app.db.select({
      id: backupJobs.id,
      createdAt: backupJobs.createdAt,
      finishedAt: backupJobs.finishedAt,
    })
      .from(backupJobs)
      .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.status, 'completed')))
      .orderBy(desc(backupJobs.createdAt)).limit(1);

    if (!bundle) {
      // Report the newest bundle of ANY status, so the operator sees *why*
      // there is nothing to restore — "partial, 2 days ago" and "never backed
      // up" call for completely different responses.
      const [latest] = await app.db.select({ status: backupJobs.status, createdAt: backupJobs.createdAt })
        .from(backupJobs).where(eq(backupJobs.tenantId, tenantId))
        .orderBy(desc(backupJobs.createdAt)).limit(1);
      skipped.push({
        tenantId,
        tenantName,
        reason: 'no_completed_bundle',
        latestBundleStatus: latest?.status ?? null,
        latestBundleAt: latest?.createdAt ? new Date(latest.createdAt).toISOString() : null,
      });
      continue;
    }

    const ns = t?.ns ?? null;
    const namespacePresent = ns ? existingNamespaces.has(ns) : false;
    const stamp = bundle.finishedAt ?? bundle.createdAt;
    const bundleCreatedAt = stamp ? new Date(stamp).toISOString() : null;
    const bundleAgeDays = stamp
      ? Math.max(0, Math.floor((now.getTime() - new Date(stamp).getTime()) / 86_400_000))
      : null;

    if (input.scope === 'missing' && namespacePresent) {
      // Not a fault — 'missing' means "only the lost ones". Reported anyway so
      // the totals add up against what the operator asked for.
      skipped.push({
        tenantId,
        tenantName,
        reason: 'namespace_present',
        latestBundleStatus: 'completed',
        latestBundleAt: bundleCreatedAt,
      });
      continue;
    }

    const comps = await app.db.select({ component: backupComponents.component })
      .from(backupComponents)
      .where(and(eq(backupComponents.backupJobId, bundle.id), eq(backupComponents.status, 'completed')));

    targets.push({
      tenantId,
      tenantName,
      bundleId: bundle.id,
      namespacePresent,
      bundleCreatedAt,
      bundleAgeDays,
      components: comps.map((c) => c.component),
    });
  }
  return { targets, skipped };
}
