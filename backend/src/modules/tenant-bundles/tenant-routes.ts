/**
 * Client-panel self-service routes for Tenant Backup (Tier-3).
 *
 * Mounted at /api/v1/tenant/backups — gated by `requirePanel('tenant')`.
 * Each route resolves the tenant from the JWT's tenantId claim and puts it
 * in the WHERE clause; there is no `:tenantId` URL param to spoof, and
 * another tenant's bundle is a 404 rather than a 403.
 *
 * Deliberately NOT `requireTenantAccess()` — see the note at the hooks.
 *
 * Endpoints:
 *   GET  /api/v1/tenant/backups/bundles
 *        List the authenticated tenant's bundles (BundleSummary[]).
 *   GET  /api/v1/tenant/backups/bundles/:id
 *        Detail + components for a bundle the tenant owns.
 *   GET  /api/v1/tenant/backups/bundles/:id/data-export
 *        Stream the GDPR data-export ciphertext (attachment).
 *
 * REMOVED: GET/PUT /api/v1/tenant/backups/schedule.
 * Tenants no longer set their own bundle schedules; the platform's
 * global `backup_schedules.tenant_bundle` row runs daily for ALL
 * eligible tenants. The legacy `tenant_backup_schedules` table is
 * dropped in migration 00XX_drop_tenant_backup_schedules.
 *
 * The admin-side counterparts under /api/v1/admin/* still exist for
 * platform-staff use; this file is the customer-facing slice.
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { eq, desc, and } from 'drizzle-orm';
import { authenticate, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  backupJobs,
  backupComponents,
  backupConfigurations,
  tenants,
} from '../../db/schema.js';
import {
  type BundleSummary,
  type BundleDetail,
  type BackupComponentInfo,
} from '@insula/api-contracts';
import { S3BackupStore } from './s3-backup-store.js';
import { SshBackupStore } from './ssh-backup-store.js';
import type { BackupStore } from './bundle-store.js';
import { resolveShimFirstBackupStore } from './shim-backup-store.js';
import { decrypt } from '../oidc/crypto.js';
import { tenantVisibleText } from '../../shared/operator-only-text.js';

export async function backupsV2ClientRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('tenant'));
  // ★ NOT requireTenantAccess(). The comment that used to sit here called it
  // "a no-op for these handlers (no :tenantId params)". That was wrong, and
  // the cost was silent: the middleware reads `params.tenantId ?? params.id`,
  // and every route below is `/tenant/backups/bundles/:id` where `:id` is a
  // BUNDLE. It compared a bundle id against the caller's tenant id, found
  // them different, and returned 403 — so bundle detail, GDPR data-export
  // and export-token were all refused to the very tenant that owned them.
  // Only the list route, which has no `:id`, worked. Verified against the
  // running cluster: list 200, detail 403.
  //
  // What it was there for is already done, in SQL: each handler resolves the
  // tenant from the JWT via `tenantIdFromRequest` and puts it in the WHERE
  // clause, so another tenant's bundle is 404 rather than forbidden. That is
  // the stronger check anyway — it cannot be satisfied by a path param.
  // `requirePanel('tenant')` above still rejects a non-tenant token, and a
  // tenant-panel token with no tenantId claim fails closed in
  // `tenantIdFromRequest`.
  //
  // A handler added here that forgets the WHERE clause is the risk this
  // leaves; `tenant-routes.access.test.ts` asserts every one of them has it.

  // Resolve the tenant from the JWT — every route shares this.
  function tenantIdFromRequest(request: { user?: { tenantId?: string } }): string {
    const cid = request.user?.tenantId;
    if (!cid) throw new ApiError('CLIENT_ACCESS_DENIED', 'Client-panel token missing tenantId', 403);
    return cid;
  }

  // ── GET /api/v1/tenant/backups/bundles ─────────────────────────────
  app.get('/tenant/backups/bundles', {
    schema: { tags: ['TenantBundles-Client'], summary: 'List my bundles', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const tenantId = tenantIdFromRequest(request);
    const rows = await app.db.select().from(backupJobs)
      .where(eq(backupJobs.tenantId, tenantId))
      .orderBy(desc(backupJobs.createdAt))
      .limit(100);
    // FLAT envelope. The previous `success({ data: rows.map(...) })`
    // wrapped an already-wrapped object → `{data:{data:[...]}}` —
    // the tenant Backups page expected `{data:[...]}` and silently
    // rendered an empty list.
    return success(rows.map(toBundleSummary));
  });

  // ── GET /api/v1/tenant/backups/bundles/:id ─────────────────────────
  app.get('/tenant/backups/bundles/:id', {
    schema: { tags: ['TenantBundles-Client'], summary: 'My bundle detail', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const tenantId = tenantIdFromRequest(request);
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs)
      .where(and(eq(backupJobs.id, id), eq(backupJobs.tenantId, tenantId)))
      .limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    const components = await app.db.select().from(backupComponents).where(eq(backupComponents.backupJobId, id));
    const detail: BundleDetail = {
      ...toBundleSummary(job),
      components: components.map(toComponentInfo),
    };
    return success(detail);
  });

  // ── GET /api/v1/tenant/backups/bundles/:id/export-preflight ───────
  //
  // Same dialog data as the admin route, scoped to the caller's own bundle.
  // Ownership is enforced the same way every handler in this file does it —
  // tenantId from the JWT in the WHERE clause, so another tenant's bundle is a
  // 404 and never reaches the preflight.
  app.get('/tenant/backups/bundles/:id/export-preflight', {
    schema: { tags: ['TenantBackups'], summary: 'Pre-flight check for my bundle export download', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const tenantId = tenantIdFromRequest(request);
    const [owned] = await app.db.select({ id: backupJobs.id }).from(backupJobs)
      .where(and(eq(backupJobs.id, id), eq(backupJobs.tenantId, tenantId))).limit(1);
    if (!owned) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    const { buildExportPreflight } = await import('./export-preflight.js');
    const pre = await buildExportPreflight({ db: app.db }, id);
    if (!pre) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    return success(pre);
  });

  // ── POST /api/v1/tenant/backups/bundles/:id/export-token ───────────
  //
  // Mint a single-use download URL for one of the CALLER'S OWN bundles.
  //
  // The admin panel has had this; the tenant panel only had the GDPR
  // data-export, which appears solely on bundles that already carry that
  // artifact. A tenant could see their backups and not take one away.
  //
  // Ownership is enforced HERE, at mint time, by looking the bundle up with
  // `tenantId` in the WHERE clause. The download route that follows is
  // authenticated by the token alone — a browser GET cannot carry a Bearer
  // header — so the token must never be mintable for a bundle the caller
  // does not own. A tenant asking for someone else's id gets 404, and no
  // token exists to replay.
  app.post('/tenant/backups/bundles/:id/export-token', {
    schema: {
      tags: ['TenantBundles-Client'],
      summary: 'Mint a single-purpose download URL for one of my bundles',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const tenantId = tenantIdFromRequest(request);
    const { id } = request.params as { id: string };
    const parsed = z.object({
      format: z.enum(['tar', 'zip']),
      password: z.string().optional(),
    }).safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', `invalid body: ${parsed.error.issues[0]?.message ?? 'unknown'}`, 400);
    }
    const { format } = parsed.data;
    // As on the admin side: zip discards a password rather than silently
    // producing an unencrypted archive the caller believes is encrypted.
    const password = format === 'tar' ? parsed.data.password : undefined;

    const [job] = await app.db.select().from(backupJobs)
      .where(and(eq(backupJobs.id, id), eq(backupJobs.tenantId, tenantId)))
      .limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (!job.targetConfigId) throw new ApiError('CONFIG_INVALID', 'Bundle has no target_config_id', 400);

    const configuredKey = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
      ?? process.env.PLATFORM_ENCRYPTION_KEY;
    if (!configuredKey && process.env.NODE_ENV === 'production') {
      throw new ApiError('CONFIG_INVALID', 'PLATFORM_ENCRYPTION_KEY is not configured', 500);
    }
    const { signExportToken } = await import('./export-token.js');
    const token = signExportToken(
      { bundleId: id, format, password: password || undefined },
      configuredKey ?? '0'.repeat(64),
    );
    // Deliberately the ADMIN download path: it is token-authenticated and
    // bound to this one bundle id, so it grants nothing beyond the bundle
    // just proven to belong to the caller. A second downloader would be a
    // second place for that check to drift.
    return success({
      downloadUrl: `/api/v1/admin/tenant-bundles/exports/${encodeURIComponent(token)}`,
      expiresInSec: 300,
    });
  });

  // ── GET /api/v1/tenant/backups/bundles/:id/data-export ─────────────
  app.get('/tenant/backups/bundles/:id/data-export', {
    schema: { tags: ['TenantBundles-Client'], summary: 'Download my GDPR data-export ciphertext', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const tenantId = tenantIdFromRequest(request);
    const { id } = request.params as { id: string };
    const [job] = await app.db.select().from(backupJobs)
      .where(and(eq(backupJobs.id, id), eq(backupJobs.tenantId, tenantId)))
      .limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (job.exportMode !== 'data_export' || !job.exportArtifact) {
      throw new ApiError('NO_DATA_EXPORT', 'This bundle has no data_export artifact.', 400);
    }
    if (!job.targetConfigId) {
      throw new ApiError('CONFIG_INVALID', 'Bundle has no target_config_id', 400);
    }
    const store = await resolveStore(app, job.targetConfigId);
    const handle = await store.open(id);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);
    const m = job.exportArtifact.match(/^components\/(files|mailboxes|config|secrets)\/(.+)$/);
    if (!m) throw new ApiError('CONFIG_INVALID', `Malformed export_artifact path '${job.exportArtifact}'`, 400);
    const [, component, artifactName] = m as unknown as [string, 'files' | 'mailboxes' | 'config' | 'secrets', string];
    const stat = await store.stat(handle, component, artifactName);
    if (!stat) throw new ApiError('NOT_FOUND', `Export artifact missing on remote target`, 404);
    const body = await store.readComponent(handle, component, artifactName);
    reply.header('Content-Type', 'application/octet-stream');
    if (Number.isFinite(stat.sizeBytes) && stat.sizeBytes >= 0) {
      reply.header('Content-Length', String(stat.sizeBytes));
    }
    reply.header('Content-Disposition', `attachment; filename="data-export-${id}.tar.gz.enc"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(body);
  });

  // GET/PUT /tenant/backups/schedule routes were removed.
  // Tenants no longer control bundle schedules; the platform-global
  // schedule (`backup_schedules.tenant_bundle`) drives all tenant
  // bundles. See backend/src/modules/tenant-bundles/global-scheduler.ts.
}

// ── helpers ───────────────────────────────────────────────────────────

/**
 * Client-panel variant. The authenticated tenant is by definition
 * `active` (they wouldn't have a valid session otherwise) and the
 * name isn't carried in this projection — UI shows the
 * bundle row in the tenant's own context, so leaving it null is
 * fine. Both fields exist purely to keep type-shape parity with
 * the admin BundleSummary contract.
 */
function toBundleSummary(j: typeof backupJobs.$inferSelect): BundleSummary {
  return {
    id: j.id,
    tenantId: j.tenantId,
    tenantStatus: 'active',
    tenantName: null,
    initiator: j.initiator,
    systemTrigger: j.systemTrigger,
    status: j.status,
    targetKind: j.targetKind,
    targetUri: j.targetUri,
    targetConfigId: j.targetConfigId,
    label: j.label,
    description: j.description,
    sizeBytes: Number(j.sizeBytes),
    resticAddedBytes: j.resticAddedBytes == null ? null : Number(j.resticAddedBytes),
    retentionDays: j.retentionDays,
    expiresAt: j.expiresAt ? j.expiresAt.toISOString() : null,
    exportMode: j.exportMode,
    exportArtifact: j.exportArtifact,
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
    // Strip operator-only pod-log tails before exposing to tenants.
    // The orchestrator's waitForJob appends `; logs: …` with raw
    // pod stderr that can contain credential challenges and the
    // master-user identity. Admin sees the full message via admin
    // routes; tenants see only the headline.
    lastError: sanitizeTenantVisibleError(j.lastError),
    // The tenant's own DB dump status (DB names + benign reasons; no creds).
    databaseDumps: (j.databaseDumps ?? null) as BundleSummary['databaseDumps'],
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

function toComponentInfo(c: typeof backupComponents.$inferSelect): BackupComponentInfo {
  return {
    id: c.id,
    component: c.component,
    artifactName: c.artifactName ?? '',
    status: c.status,
    sizeBytes: Number(c.sizeBytes),
    sha256: c.sha256,
    startedAt: c.startedAt ? c.startedAt.toISOString() : null,
    finishedAt: c.finishedAt ? c.finishedAt.toISOString() : null,
    lastError: sanitizeTenantVisibleError(c.lastError),
  };
}

/**
 * Drop the operator-only tail of a Job error — the `; diagnosis:` (node and
 * pod names, raw Kubernetes events) and `; logs:` (raw pod stderr) the Job
 * watchers append — so a tenant sees only the headline. See
 * shared/operator-only-text.ts.
 */
function sanitizeTenantVisibleError(raw: string | null): string | null {
  return raw ? tenantVisibleText(raw) : raw;
}

async function resolveStore(app: FastifyInstance, targetConfigId: string): Promise<BackupStore> {
  // B9 shim-first: cifs/nfs upstreams are mediated by the rclone-shim.
  // Falls back to direct cfg-based resolver below for s3/ssh when the
  // shim isn't bootstrapped on this cluster.
  return resolveShimFirstBackupStore(
    app, 'tenant',
    () => resolveDirectStore(app, targetConfigId),
    'tenant-bundles tenant',
  );
}

async function resolveDirectStore(app: FastifyInstance, targetConfigId: string): Promise<BackupStore> {
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);
  const configuredKey = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    throw new ApiError('CONFIG_INVALID', 'PLATFORM_ENCRYPTION_KEY is not configured', 500);
  }
  if (!configuredKey) {
    // Match the admin-side warn-log so operators see the zero-key
    // fallback path on staging the same way they see it on the
    // admin route. Without this, a staging-only reproduction is
    // silent in the tenant-panel path.
    app.log.warn('tenant-bundles tenant: PLATFORM_ENCRYPTION_KEY not set — using zero-key dev fallback. Decrypted credentials are trivially recoverable in this environment.');
  }
  const encKey = configuredKey ?? '0'.repeat(64);
  if (cfg.storageType === 's3') {
    let accessKey = '';
    let secretKey = '';
    try {
      accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, encKey) : '';
      secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, encKey) : '';
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-bundles tenant: S3 credential decryption failed');
      throw new ApiError('CONFIG_INVALID', 'S3 credential decryption failed', 500);
    }
    if (!accessKey || !secretKey) throw new ApiError('CONFIG_INVALID', 'S3 credentials missing', 400);
    return new S3BackupStore({
      bucket: cfg.s3Bucket ?? '',
      region: cfg.s3Region ?? 'us-east-1',
      endpoint: cfg.s3Endpoint ?? undefined,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      pathPrefix: cfg.s3Prefix ?? undefined,
    });
  }
  if (cfg.storageType === 'ssh') {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyEncrypted || !cfg.sshPath) {
      throw new ApiError('CONFIG_INVALID', `SSH target ${cfg.id} missing fields`, 400);
    }
    let privateKey = '';
    try {
      privateKey = decrypt(cfg.sshKeyEncrypted, encKey);
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-bundles tenant: SSH key decryption failed');
      throw new ApiError('CONFIG_INVALID', 'SSH key decryption failed', 500);
    }
    return new SshBackupStore({
      host: cfg.sshHost,
      port: cfg.sshPort ?? 22,
      user: cfg.sshUser,
      privateKey,
      basePath: cfg.sshPath,
      logFn: (level, ctx, msg) => app.log[level](ctx, msg),
    });
  }
  throw new ApiError('NOT_IMPLEMENTED', `Store kind '${cfg.storageType}' not supported`, 501);
}
