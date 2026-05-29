/**
 * Tenant-scoped restore-cart + bundle-browse + on-demand bundle
 * routes (2026-05-28).
 *
 * Sibling of `routes.ts` (admin). Reuses the shared cart machinery
 * + executors via `shared.ts` and applies `tenant-restore-policy`
 * to keep billing/quota/infra rows out of tenant-initiated restores.
 *
 * Auth: `authenticate + requirePanel('tenant') + requireTenantRoleByMethod()
 * + requireTenantAccess()`. `requireTenantAccess` enforces that the
 * `:tenantId` path param matches `JWT.tenantId` — so a tenant_admin
 * token for tenant A cannot operate on tenant B's bundles even if
 * they hand-craft the URL. Defence-in-depth: every handler also
 * re-checks bundle.tenantId / cart.tenantId vs `:tenantId` before
 * mutating anything.
 */

import type { FastifyInstance } from 'fastify';
import { eq, asc, sql, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  authenticate,
  requirePanel,
  requireRole,
  requireTenantRoleByMethod,
  requireTenantAccess,
} from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  restoreJobs,
  restoreItems,
  backupJobs,
  backupComponents,
  tenants,
  auditLogs,
  type NewRestoreJob,
  type NewRestoreItem,
} from '../../db/schema.js';
import {
  createRestoreCartSchema,
  addRestoreItemSchema,
  type RestoreItemPayload,
  type RestoreJobDetail,
} from '@insula/api-contracts';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  loadBundle,
  resolveStoreForBundle,
  readConfigDump,
  dispatchExecutor,
  toJobSummary,
  toItemInfo,
} from './shared.js';
import {
  DEFAULT_TENANT_RESTORE_POLICY,
  filterConfigTableNames,
  validateRestoreItemForTenant,
} from './tenant-restore-policy.js';
import { snapshotTenant, rollbackToSnapshot } from '../storage-lifecycle/service.js';
import { resolveSnapshotStore } from '../storage-lifecycle/snapshot-store.js';
import { runBundle } from '../tenant-bundles/orchestrator.js';
import { resolveShimBackupStore } from '../tenant-bundles/shim-backup-store.js';
import { resolveDirectStoreForBundle } from './shared.js';
import { backupConfigurations, backupTargetAssignments, hostingPlans } from '../../db/schema.js';

/**
 * Strip operator-only diagnostic context (pod-log tails, internal
 * stack traces) from an error message before exposing it to a
 * tenant via the status endpoint. The full message is still in the
 * DB (`backup_jobs.last_error` / `backup_components.last_error`)
 * for admin visibility; tenants see only the headline.
 *
 * Security review 2026-05-28 HIGH: pod logs tailed into `last_error`
 * by `waitForJob` can contain credential challenges, internal URLs
 * with tokens (curl error messages), or master-user identities.
 * Truncating at `; logs: ` is sufficient because the orchestrator
 * uses that exact prefix in mailboxes.ts.
 */
export function sanitizeTenantVisibleError(raw: string | null): string | null {
  if (!raw) return raw;
  const logsIdx = raw.indexOf('; logs:');
  return logsIdx >= 0 ? raw.slice(0, logsIdx) : raw;
}

/**
 * Assert a resource (bundle, cart) belongs to the path-param tenant.
 * Even though `requireTenantAccess` guarantees `:tenantId === JWT.tenantId`,
 * we re-check at the data layer so a coding mistake in a future
 * handler can't accidentally serve another tenant's row.
 */
function assertOwnership(
  resourceTenantId: string,
  pathTenantId: string,
  resourceLabel: string,
): void {
  if (resourceTenantId !== pathTenantId) {
    throw new ApiError(
      'CROSS_TENANT',
      `${resourceLabel} does not belong to this tenant`,
      404, // 404 not 403 — don't leak existence of other tenants' resources
    );
  }
}

export async function tenantRestoreRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('tenant'));
  app.addHook('onRequest', requireTenantRoleByMethod());
  app.addHook('onRequest', requireTenantAccess());

  // ── GET /api/v1/tenants/:tenantId/bundles ──────────────────────────
  // List this tenant's bundles (replaces /client/backups list).
  app.get('/tenants/:tenantId/bundles', {
    schema: { tags: ['Tenant Restore'], summary: 'List tenant bundles', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const q = request.query as { limit?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 200);
    const rows = await app.db.select()
      .from(backupJobs)
      .where(eq(backupJobs.tenantId, tenantId))
      .orderBy(sql`${backupJobs.createdAt} DESC`)
      .limit(limit);
    return success(rows.map((b) => ({
      id: b.id,
      tenantId: b.tenantId,
      status: b.status,
      sizeBytes: Number(b.sizeBytes),
      label: b.label,
      description: b.description,
      startedAt: b.startedAt ? b.startedAt.toISOString() : null,
      finishedAt: b.finishedAt ? b.finishedAt.toISOString() : null,
      expiresAt: b.expiresAt ? b.expiresAt.toISOString() : null,
      createdAt: b.createdAt.toISOString(),
      lastError: b.lastError,
    })));
  });

  // ── GET /api/v1/tenants/:tenantId/bundles/:bundleId/status ─────────
  // Per-component bundle progress. Polled by BundleProgressModal in
  // the tenant panel during a run-now or to watch a scheduled bundle
  // land. Returns the bundle's status + each component's status,
  // bytes, start/finish timestamps, and last error. No artefact
  // streaming — Phase 4-light: enough to render a step list.
  app.get('/tenants/:tenantId/bundles/:bundleId/status', {
    schema: { tags: ['Tenant Restore'], summary: 'Bundle progress (per-component)', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId, bundleId } = request.params as { tenantId: string; bundleId: string };
    const bundle = await loadBundle(app, bundleId);
    assertOwnership(bundle.tenantId, tenantId, 'Bundle');

    const components = await app.db.select().from(backupComponents)
      .where(eq(backupComponents.backupJobId, bundleId))
      .orderBy(asc(backupComponents.component));

    return success({
      bundle: {
        id: bundle.id,
        tenantId: bundle.tenantId,
        status: bundle.status,
        sizeBytes: Number(bundle.sizeBytes),
        startedAt: bundle.startedAt ? bundle.startedAt.toISOString() : null,
        finishedAt: bundle.finishedAt ? bundle.finishedAt.toISOString() : null,
        lastError: sanitizeTenantVisibleError(bundle.lastError),
      },
      components: components.map((c) => ({
        id: c.id,
        component: c.component,
        artifactName: c.artifactName,
        status: c.status,
        sizeBytes: Number(c.sizeBytes),
        startedAt: c.startedAt ? c.startedAt.toISOString() : null,
        finishedAt: c.finishedAt ? c.finishedAt.toISOString() : null,
        lastError: sanitizeTenantVisibleError(c.lastError),
      })),
    });
  });

  // ── GET /api/v1/tenants/:tenantId/bundles/:bundleId/browse/* ───────
  // Bundle browse — policy-filtered for tenant scope.
  //
  // config-tables: hides denied tables (hosting_plans, etc.) from
  // the picker so the UI doesn't show options the tenant can't use.

  app.get('/tenants/:tenantId/bundles/:bundleId/browse/config-tables', async (request) => {
    const { tenantId, bundleId } = request.params as { tenantId: string; bundleId: string };
    const bundle = await loadBundle(app, bundleId);
    assertOwnership(bundle.tenantId, tenantId, 'Bundle');
    const dump = await readConfigDump(app, bundleId);
    const allTableNames = Object.keys(dump.tables ?? {});
    const allowedTableNames = filterConfigTableNames(allTableNames, DEFAULT_TENANT_RESTORE_POLICY);
    const tables = allowedTableNames.map((name) => ({
      name,
      rowCount: Array.isArray(dump.tables?.[name]) ? dump.tables[name].length : 0,
    }));
    return success({ bundleId, tables });
  });

  app.get('/tenants/:tenantId/bundles/:bundleId/browse/mailboxes', async (request) => {
    const { tenantId, bundleId } = request.params as { tenantId: string; bundleId: string };
    const bundle = await loadBundle(app, bundleId);
    assertOwnership(bundle.tenantId, tenantId, 'Bundle');
    const store = await resolveStoreForBundle(app, bundleId);
    const handle = await store.open(bundleId);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);
    const refs = await store.listArtifacts(handle, 'mailboxes');
    const addresses = refs
      .map((r) => r.name.replace(/\.mbox\.tar\.gz$/, ''))
      .filter((s) => s.length > 0);
    return success({ bundleId, addresses });
  });

  app.get('/tenants/:tenantId/bundles/:bundleId/browse/deployments', async (request) => {
    const { tenantId, bundleId } = request.params as { tenantId: string; bundleId: string };
    const bundle = await loadBundle(app, bundleId);
    assertOwnership(bundle.tenantId, tenantId, 'Bundle');
    const dump = await readConfigDump(app, bundleId);
    const rows = (dump.tables?.deployments ?? []) as Array<{ id: string; name: string }>;
    return success({
      bundleId,
      deployments: rows.map((d) => ({ id: d.id, name: d.name })),
    });
  });

  app.get('/tenants/:tenantId/bundles/:bundleId/browse/domains', async (request) => {
    const { tenantId, bundleId } = request.params as { tenantId: string; bundleId: string };
    const bundle = await loadBundle(app, bundleId);
    assertOwnership(bundle.tenantId, tenantId, 'Bundle');
    const dump = await readConfigDump(app, bundleId);
    const rows = (dump.tables?.domains ?? []) as Array<{ id: string; hostname: string }>;
    return success({
      bundleId,
      domains: rows.map((d) => ({ id: d.id, hostname: d.hostname })),
    });
  });

  app.get('/tenants/:tenantId/bundles/:bundleId/browse/files/tree', async (request) => {
    const { tenantId, bundleId } = request.params as { tenantId: string; bundleId: string };
    const bundle = await loadBundle(app, bundleId);
    assertOwnership(bundle.tenantId, tenantId, 'Bundle');
    const q = request.query as { limit?: string; after?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '500', 10) || 500, 1), 2000);
    const after = q.after ?? '';
    const store = await resolveStoreForBundle(app, bundleId);
    const handle = await store.open(bundleId);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);
    let tree: Buffer;
    try {
      const stream = await store.readComponent(handle, 'files', 'tree.jsonl.gz');
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      tree = gunzipSync(Buffer.concat(chunks));
    } catch {
      // tree.jsonl.gz sidecar was dropped in favour of restic ls
      // (see files.ts:32). Return graceful empty for bundles created
      // after that change so the UI can render an explanation instead
      // of a hard 404. Restore the full files snapshot from the cart.
      return success({
        bundleId,
        totalCount: 0,
        entries: [],
        nextCursor: null,
        migrated: true,
        message: 'File browsing migrated to restic listing — not yet wired here. Restore the full files snapshot via the cart.',
      });
    }
    const lines = tree.toString('utf8').split('\n').filter(Boolean);
    const allEntries: Array<{ path: string; size: number; mode: number; mtime: string }> = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as { path: string; size: number; mode: number; mtime: string };
        allEntries.push(obj);
      } catch { /* tolerate malformed lines */ }
    }
    allEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const totalCount = allEntries.length;
    const startIdx = after
      ? (() => {
          let lo = 0, hi = allEntries.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (allEntries[mid]!.path > after) hi = mid;
            else lo = mid + 1;
          }
          return lo;
        })()
      : 0;
    const endIdx = Math.min(startIdx + limit, allEntries.length);
    const entries = allEntries.slice(startIdx, endIdx);
    const nextCursor = endIdx < allEntries.length
      ? entries.length > 0 ? entries[entries.length - 1]!.path : null
      : null;
    return success({ bundleId, totalCount, entries, nextCursor });
  });

  // ── POST /api/v1/tenants/:tenantId/restore-carts ───────────────────
  app.post('/tenants/:tenantId/restore-carts', {
    schema: { tags: ['Tenant Restore'], summary: 'Create restore cart for tenant', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = createRestoreCartSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
    }
    const input = parsed.data;
    if (input.tenantId !== tenantId) {
      throw new ApiError('VALIDATION_ERROR', 'body.tenantId must match path :tenantId', 400);
    }
    const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new ApiError('NOT_FOUND', 'Tenant not found', 404);

    const initiatorUserId = request.user?.sub ?? null;
    const id = `rstr-${randomUUID()}`;
    const row: NewRestoreJob = {
      id,
      tenantId,
      initiatorUserId,
      status: 'draft',
      description: input.description ?? null,
    };
    await app.db.insert(restoreJobs).values(row);
    reply.status(201).send(success({ id, tenantId, status: 'draft' }));
  });

  // ── GET /api/v1/tenants/:tenantId/restore-carts ────────────────────
  app.get('/tenants/:tenantId/restore-carts', {
    schema: { tags: ['Tenant Restore'], summary: 'List tenant restore carts', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const q = request.query as { limit?: string; status?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '50', 10) || 50, 1), 200);
    const conditions = [eq(restoreJobs.tenantId, tenantId)];
    // Validate `status` against the cart-status enum. Without this,
    // an unchecked `q.status as 'draft'` cast would let Postgres reject
    // unknown values with a 500 (or — more subtly — let an attacker
    // probe which enum strings the schema accepts via timing/error
    // differences). Empty + unrecognised → fall through to "no filter".
    if (q.status) {
      const allowed: ReadonlyArray<'draft' | 'executing' | 'paused' | 'done' | 'failed'> = [
        'draft', 'executing', 'paused', 'done', 'failed',
      ];
      if (allowed.includes(q.status as typeof allowed[number])) {
        conditions.push(eq(restoreJobs.status, q.status as typeof allowed[number]));
      } else {
        throw new ApiError('VALIDATION_ERROR', `status must be one of: ${allowed.join(', ')}`, 400);
      }
    }
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);
    const rows = await app.db.select().from(restoreJobs)
      .where(where)
      .orderBy(sql`${restoreJobs.createdAt} DESC`)
      .limit(limit);
    return success(rows.map(toJobSummary));
  });

  // ── GET /api/v1/tenants/:tenantId/restore-carts/:id ────────────────
  app.get('/tenants/:tenantId/restore-carts/:id', async (request) => {
    const { tenantId, id } = request.params as { tenantId: string; id: string };
    const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, id)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Restore cart not found', 404);
    assertOwnership(job.tenantId, tenantId, 'Restore cart');
    const items = await app.db.select().from(restoreItems)
      .where(eq(restoreItems.restoreJobId, id))
      .orderBy(asc(restoreItems.seq));
    const detail: RestoreJobDetail = {
      ...toJobSummary(job),
      items: items.map(toItemInfo),
    };
    return success(detail);
  });

  // ── POST /api/v1/tenants/:tenantId/restore-carts/:id/items ─────────
  // Validate the payload against the tenant policy BEFORE inserting.
  app.post('/tenants/:tenantId/restore-carts/:id/items', async (request, reply) => {
    const { tenantId, id: cartId } = request.params as { tenantId: string; id: string };
    const parsed = addRestoreItemSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '), 400);
    }
    const input = parsed.data;

    // Cart ownership.
    const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, cartId)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Restore cart not found', 404);
    assertOwnership(job.tenantId, tenantId, 'Restore cart');
    if (job.status !== 'draft') {
      throw new ApiError('VALIDATION_ERROR', `Cannot add items to cart in status '${job.status}'`, 400);
    }

    // Bundle ownership.
    const [bundle] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, input.bundleId)).limit(1);
    if (!bundle) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    assertOwnership(bundle.tenantId, tenantId, 'Bundle');

    // Tenant policy gate.
    const validation = validateRestoreItemForTenant(input as RestoreItemPayload);
    if (!validation.ok) {
      throw new ApiError(validation.code, validation.reason, 403);
    }

    // Atomic next-seq insert (same pattern as admin).
    const itemId = randomUUID();
    const newRow: NewRestoreItem = {
      id: itemId,
      restoreJobId: cartId,
      bundleId: input.bundleId,
      type: input.type,
      selector: input.selector as Record<string, unknown>,
      label: input.label ?? null,
      seq: 0,
    };
    await app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM restore_jobs WHERE id = ${cartId} FOR UPDATE`);
      const r = await tx.execute(sql`
        SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq
        FROM restore_items WHERE restore_job_id = ${cartId}
      `) as unknown as { rows: { next_seq: number }[] };
      const nextSeq = Number(r.rows[0]?.next_seq ?? 0);
      await tx.insert(restoreItems).values({ ...newRow, seq: nextSeq });
    });
    const [item] = await app.db.select().from(restoreItems).where(eq(restoreItems.id, itemId)).limit(1);
    reply.status(201).send(success(toItemInfo(item!)));
  });

  // ── DELETE /api/v1/tenants/:tenantId/restore-carts/:id/items/:itemId ──
  app.delete('/tenants/:tenantId/restore-carts/:id/items/:itemId', async (request, reply) => {
    const { tenantId, id: cartId, itemId } = request.params as { tenantId: string; id: string; itemId: string };
    const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, cartId)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Restore cart not found', 404);
    assertOwnership(job.tenantId, tenantId, 'Restore cart');
    if (job.status !== 'draft') {
      throw new ApiError('VALIDATION_ERROR', `Cannot remove items from cart in status '${job.status}'`, 400);
    }
    await app.db.delete(restoreItems)
      .where(and(eq(restoreItems.restoreJobId, cartId), eq(restoreItems.id, itemId)));
    reply.status(204).send();
  });

  // ── POST /api/v1/tenants/:tenantId/restore-carts/:id/execute ──────
  app.post('/tenants/:tenantId/restore-carts/:id/execute', async (request) => {
    const { tenantId, id: cartId } = request.params as { tenantId: string; id: string };

    // Pre-check ownership before claiming.
    const [pre] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, cartId)).limit(1);
    if (!pre) throw new ApiError('NOT_FOUND', 'Restore cart not found', 404);
    assertOwnership(pre.tenantId, tenantId, 'Restore cart');

    // Atomic claim.
    const claim = await app.db.execute(sql`
      UPDATE restore_jobs
      SET status = 'executing',
          started_at = COALESCE(started_at, now()),
          updated_at = now()
      WHERE id = ${cartId}
        AND tenant_id = ${tenantId}
        AND status != 'executing'
      RETURNING id
    `) as unknown as { rows: Array<{ id: string }> };
    if (claim.rows.length === 0) {
      throw new ApiError('CONFLICT', 'Cart is already executing or owned by another tenant', 409);
    }

    // Read items first so we can decide whether a snapshot is needed.
    const items = await app.db.select().from(restoreItems)
      .where(eq(restoreItems.restoreJobId, cartId))
      .orderBy(asc(restoreItems.seq));

    if (items.length === 0) {
      // Free the cart back to draft so the tenant can add items
      // without first deleting + recreating it.
      await app.db.update(restoreJobs)
        .set({ status: 'draft', startedAt: null, updatedAt: new Date() })
        .where(eq(restoreJobs.id, cartId));
      throw new ApiError(
        'VALIDATION_ERROR',
        'Cart has no items — add at least one item before executing',
        400,
      );
    }

    // Snapshot pre-restore (per-tenant rollback point). Only needed
    // when a destructive item is in the cart (files-paths can clobber
    // tenant data). Mailbox + config-tables + domains are individually
    // reversible without a snapshot.
    if (!pre.preRestoreSnapshotId && items.some((it) => it.status !== 'done' && it.type === 'files-paths')) {
      try {
        const k8s = (app as unknown as { k8s?: ReturnType<typeof createK8sClients> }).k8s
          ?? createK8sClients((app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined);
        const snapStore = await resolveSnapshotStore(app.db, app.config as Record<string, unknown>);
        const platformNamespace = ((app.config as Record<string, unknown>).PLATFORM_NAMESPACE as string | undefined) ?? 'platform';
        const snap = await snapshotTenant(
          { db: app.db, k8s, store: snapStore, platformNamespace },
          tenantId,
          { kind: 'pre-restore', label: `tenant-restore-cart ${cartId}`, retentionDays: 7 },
        );
        await app.db.update(restoreJobs)
          .set({ preRestoreSnapshotId: snap.id, updatedAt: new Date() })
          .where(eq(restoreJobs.id, cartId));
      } catch (err) {
        app.log.error({ err, cartId, tenantId }, 'tenant-restore: pre-restore snapshot failed');
        await app.db.update(restoreJobs)
          .set({ status: 'failed', finishedAt: new Date(), lastError: 'PRE_RESTORE_SNAPSHOT_FAILED', updatedAt: new Date() })
          .where(eq(restoreJobs.id, cartId));
        throw new ApiError('SNAPSHOT_FAILED', 'Pre-restore snapshot failed; cart aborted to preserve current state', 500);
      }
    }

    let allOk = true;
    let lastError: string | null = null;

    for (const item of items) {
      if (item.status === 'done' || item.status === 'skipped') continue;
      // Re-validate policy before dispatch.
      const validation = validateRestoreItemForTenant({
        type: item.type as RestoreItemPayload['type'],
        selector: item.selector,
      } as RestoreItemPayload);
      if (!validation.ok) {
        await app.db.update(restoreItems)
          .set({
            status: 'failed',
            finishedAt: new Date(),
            lastError: `policy violation at execute: ${validation.reason}`,
          })
          .where(eq(restoreItems.id, item.id));
        allOk = false;
        lastError = validation.reason;
        continue;
      }
      await app.db.update(restoreItems)
        .set({ status: 'applying', startedAt: new Date() })
        .where(eq(restoreItems.id, item.id));
      try {
        const store = await resolveStoreForBundle(app, item.bundleId);
        // CRITICAL safety: pass the tenant policy so config-tables
        // executor redacts denied columns per-row. Without this,
        // a tenant cart restoring the `tenants` table would overwrite
        // plan_id / is_system / *_override quotas from the bundle.
        await dispatchExecutor(app, item, store, DEFAULT_TENANT_RESTORE_POLICY);
        await app.db.update(restoreItems)
          .set({ status: 'done', finishedAt: new Date() })
          .where(eq(restoreItems.id, item.id));
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        await app.db.update(restoreItems)
          .set({ status: 'failed', finishedAt: new Date(), lastError: msg })
          .where(eq(restoreItems.id, item.id));
        allOk = false;
        lastError = msg;
        break; // pause cart at the failed item; operator re-/executes to retry.
      }
    }

    await app.db.update(restoreJobs)
      .set({
        status: allOk ? 'done' : 'failed',
        finishedAt: new Date(),
        lastError,
        updatedAt: new Date(),
      })
      .where(eq(restoreJobs.id, cartId));

    // Audit-log the tenant-initiated restore execute so compliance
    // queries can reconstruct who did what. The generic audit hook
    // only captures URL + method, not the per-item application.
    try {
      const actorId = request.user?.sub;
      if (actorId) {
        await app.db.insert(auditLogs).values({
          id: randomUUID(),
          tenantId,
          actionType: 'tenant_restore_execute',
          resourceType: 'restore-cart',
          resourceId: cartId,
          actorId,
          actorType: 'user',
          httpMethod: 'POST',
          httpPath: `/api/v1/tenants/${tenantId}/restore-carts/${cartId}/execute`,
          httpStatus: 200,
          changes: {
            itemCount: items.length,
            status: allOk ? 'done' : 'failed',
            lastError,
          },
          ipAddress: request.ip,
        });
      }
    } catch (auditErr) {
      app.log.warn({ err: auditErr, cartId, tenantId }, 'tenant-restore execute: audit log insert failed');
    }

    return success({ cartId, status: allOk ? 'done' : 'failed', lastError });
  });

  // ── POST /api/v1/tenants/:tenantId/restore-carts/:id/rollback ─────
  //
  // Operator-only despite living in the tenant-routes plugin: PVC
  // rollback quiesces workloads, replaces volume contents from the
  // pre-restore snapshot, and unquiesces. That destructive infra op
  // shouldn't be triggerable by a tenant_admin token. The plugin-wide
  // `requireTenantRoleByMethod` already lets tenant_admin through,
  // so we add a per-route `requireRole(super_admin,admin)` to narrow.
  // The admin counterpart at `/admin/restores/carts/:id/rollback`
  // applies the same gate. Tenant UI hides the button via
  // `showRollback={false}` on the shared layout.
  app.post('/tenants/:tenantId/restore-carts/:id/rollback', {
    preHandler: requireRole('super_admin', 'admin'),
  }, async (request) => {
    const { tenantId, id: cartId } = request.params as { tenantId: string; id: string };
    const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, cartId)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Restore cart not found', 404);
    assertOwnership(job.tenantId, tenantId, 'Restore cart');
    if (!job.preRestoreSnapshotId) {
      throw new ApiError('VALIDATION_ERROR', 'No pre-restore snapshot to roll back to', 400);
    }
    const triggeredByUserId = request.user?.sub ?? null;
    try {
      const k8s = (app as unknown as { k8s?: ReturnType<typeof createK8sClients> }).k8s
        ?? createK8sClients((app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined);
      const snapStore = await resolveSnapshotStore(app.db, app.config as Record<string, unknown>);
      const platformNamespace = ((app.config as Record<string, unknown>).PLATFORM_NAMESPACE as string | undefined) ?? 'platform';
      const result = await rollbackToSnapshot(
        { db: app.db, k8s, store: snapStore, platformNamespace },
        tenantId,
        job.preRestoreSnapshotId,
        { triggeredByUserId },
      );
      return success({ cartId, operationId: result.operationId, snapshotId: result.snapshotId });
    } catch (err) {
      throw new ApiError('ROLLBACK_FAILED', `Rollback dispatch failed: ${(err as Error).message}`, 500);
    }
  });

  // ── POST /api/v1/tenants/:tenantId/bundles/run-now ─────────────────
  // On-demand bundle capture initiated by the tenant. Returns the new
  // bundle id immediately; the orchestrator runs async. Frontend
  // polls GET /tenants/:tenantId/bundles to see status flip to
  // `running` → `completed`. Phase 4 follow-up will add detailed
  // step events.
  app.post('/tenants/:tenantId/bundles/run-now', {
    schema: { tags: ['Tenant Restore'], summary: 'Trigger an on-demand tenant bundle', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };

    // Tenant must exist + not be archived.
    const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new ApiError('NOT_FOUND', 'Tenant not found', 404);
    if (tenant.status === 'archived') {
      throw new ApiError('VALIDATION_ERROR', 'Cannot back up an archived tenant', 400);
    }

    // Resolve the platform's `tenant`-class backup target. The new
    // `backup_target_assignments` model binds a backup_configurations
    // row to a class — pick the lowest-priority binding for 'tenant'.
    // Fallback to a legacy `backup_configurations.active=true` row
    // for clusters still on the pre-assignments model.
    const [assigned] = await app.db.select({ targetId: backupTargetAssignments.targetId })
      .from(backupTargetAssignments)
      .where(eq(backupTargetAssignments.backupClass, 'tenant'))
      .orderBy(backupTargetAssignments.priority)
      .limit(1);
    let activeCfg;
    if (assigned) {
      const [cfg] = await app.db.select().from(backupConfigurations)
        .where(eq(backupConfigurations.id, assigned.targetId)).limit(1);
      activeCfg = cfg;
    }
    if (!activeCfg) {
      // Legacy fallback.
      const [cfg] = await app.db.select().from(backupConfigurations)
        .where(eq(backupConfigurations.active, true)).limit(1);
      activeCfg = cfg;
    }
    if (!activeCfg) {
      throw new ApiError(
        'NO_BACKUP_TARGET',
        'No backup target assigned to the tenant class. Contact your platform administrator.',
        409,
      );
    }

    // Reject spam-click: refuse if a bundle is already running for
    // this tenant. Otherwise N concurrent clicks → N concurrent k8s
    // Jobs writing to the same restic repo (corruption + quota burn).
    const [inFlight] = await app.db.select({ id: backupJobs.id })
      .from(backupJobs)
      .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.status, 'running')))
      .limit(1);
    if (inFlight) {
      throw new ApiError('CONFLICT', 'A bundle is already running for this tenant. Wait for it to complete.', 409);
    }

    // Plan-bound retention (tenant cannot bypass).
    const [plan] = await app.db.select({
      defaultDays: hostingPlans.defaultBackupRetentionDays,
      maxDays: hostingPlans.maxBackupRetentionDays,
    }).from(hostingPlans).where(eq(hostingPlans.id, tenant.planId)).limit(1);
    if (!plan) throw new ApiError('CONFIG_INVALID', 'Tenant has no resolvable plan', 400);
    const retentionDays = plan.defaultDays;

    // B9 routing parity: tenant bundles go through the rclone-shim.
    let store;
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const k8sClients = createK8sClients(kubeconfigPath);
      store = await resolveShimBackupStore(k8sClients.core, 'tenant', { log: app.log });
    } catch (err) {
      app.log.warn({ err }, 'tenant-restore run-now: shim unavailable, falling back to direct store');
      store = await resolveDirectStoreForBundle(app, activeCfg.id);
    }

    let k8s;
    try {
      const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      k8s = createK8sClients(kc);
    } catch (err) {
      app.log.warn({ err }, 'tenant-restore run-now: k8s clients unavailable');
      k8s = undefined;
    }

    const platformApiUrl = (app.config as Record<string, unknown>).PLATFORM_API_INTERNAL_URL as string | undefined
      ?? process.env.PLATFORM_API_INTERNAL_URL
      ?? 'http://platform-api.platform.svc:3000';
    const platformVersion = (app.config as Record<string, unknown>).PLATFORM_VERSION as string | undefined ?? '0.0.0';
    const configuredKey = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
      ?? process.env.PLATFORM_ENCRYPTION_KEY;
    if (!configuredKey && process.env.NODE_ENV === 'production') {
      throw new ApiError('CONFIG_INVALID', 'PLATFORM_ENCRYPTION_KEY not configured', 500);
    }
    const secretsKeyHex = configuredKey ?? '0'.repeat(64);

    const triggeredByUserId = request.user?.sub ?? null;

    // Fire-and-forget; returns the eventual bundleId via the awaitable
    // result. We DO wait for the orchestrator's pre-flight (insert
    // backup_jobs row) so the client gets a valid bundle id back.
    const result = await runBundle(
      {
        db: app.db,
        k8s,
        store,
        platformVersion,
        secretsKeyHex,
        platformApiUrl,
        platformBaseDomain: (app.config as Record<string, unknown>).PLATFORM_BASE_DOMAIN as string | undefined
          ?? (app.config as Record<string, unknown>).INGRESS_BASE_DOMAIN as string | undefined,
        kubeconfigPath: (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined,
      },
      {
        tenantId,
        initiator: 'tenant', // backup_initiator enum has 'tenant';
                             // ensures audit/task-tracker chips
                             // surface under the tenant's session
                             // not the admin pane.
        systemTrigger: null,
        label: 'tenant-run-now',
        description: null,
        retentionDays,
        targetConfigId: activeCfg.id,
        targetUri: `${store.kind}://${activeCfg.id}`,
        components: { files: true, mailboxes: true, config: true, secrets: true },
        triggeredByUserId,
      },
    );

    reply.status(202).send(success({
      bundleId: result.bundleId,
      status: result.status,
      message: 'Bundle started. Poll /tenants/:tenantId/bundles to watch progress.',
    }));
  });

}
