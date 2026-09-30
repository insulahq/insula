/**
 * Bundle re-import endpoints, admin and tenant (ADR-063).
 *
 * TRANSPORT IS NOT HERE. The archive arrives through the EXISTING chunked
 * upload (`POST /tenants/:id/files/upload-raw`), which already carries the WAF
 * carve-out and already streams to disk — so there is no new upload surface,
 * no new size ceiling, and no second copy of the resumable-chunk logic. These
 * two calls bracket that upload:
 *
 *   POST …/bundle-imports/preflight  — read meta.json off the uploaded archive
 *                                      and answer "what will this import, and
 *                                      may it?" WITHOUT side effects.
 *   POST …/bundle-imports            — run it.
 *
 * The tenant variants resolve the tenant from the JWT (no `:tenantId` to
 * spoof) and are restricted to `files`/`mailboxes` (ADR-063 D4).
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  bundleImportPreflightInputSchema,
  bundleImportStartInputSchema,
  BUNDLE_IMPORT_UPLOAD_DIR,
} from '@insula/api-contracts';
import { authenticate, requirePanel, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { tenants } from '../../db/schema.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { ensureFileManagerReady, fileManagerRequest } from '../file-manager/service.js';
import { readArchiveMeta, ArchiveMetaError } from './import-archive-meta.js';
import { buildImportPreflight, type ImportScope } from './import-preflight.js';
import { runBundleImport, buildImportLabel, type ImportRunnerDeps } from './import-orchestrator.js';
import type { FileManagerGateway } from './import-reaper.js';

/** Resolve a provisioned tenant's namespace, or fail with a legible error. */
async function resolveTenantNamespace(app: FastifyInstance, tenantId: string): Promise<string> {
  const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404);
  if (!tenant.kubernetesNamespace) {
    throw new ApiError('TENANT_NOT_READY', 'This tenant has no namespace yet.', 409);
  }
  return tenant.kubernetesNamespace;
}

function getFileManagerImage(app: FastifyInstance): string {
  return ((app.config as Record<string, unknown>).FILE_MANAGER_IMAGE as string | undefined)
    ?? process.env.FILE_MANAGER_IMAGE
    ?? 'ghcr.io/insulahq/file-manager:latest';
}

function kubeconfigPathOf(app: FastifyInstance): string | undefined {
  return ((app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined)
    ?? process.env.KUBECONFIG_PATH ?? process.env.KUBECONFIG;
}

/**
 * Open the uploaded archive as a Readable.
 *
 * A raw GET against the file-manager Service rather than `fileManagerRequest`,
 * which buffers the whole body into a string — the entire point of the
 * streaming meta reader is that a 25 GB upload costs the first few KB.
 */
async function openUploadedArchive(
  app: FastifyInstance,
  namespace: string,
  relPath: string,
): Promise<Readable> {
  const k8sTenants = createK8sClients(kubeconfigPathOf(app));
  const { directUrl } = await ensureFileManagerReady(k8sTenants, namespace, getFileManagerImage(app));
  if (!directUrl) {
    throw new ApiError('FILE_ERROR',
      'The file manager is not reachable from platform-api, so the upload cannot be inspected.', 503);
  }
  const http = await import('node:http');
  const url = new URL(`${directUrl}/download`);
  url.searchParams.set('path', `/${relPath}`);
  return await new Promise<Readable>((resolve, reject) => {
    const req = http.get(url, (res) => {
      const status = res.statusCode ?? 500;
      if (status === 404) {
        res.resume();
        reject(new ApiError('UPLOAD_NOT_FOUND',
          'No uploaded archive was found for this import. Upload the bundle first.', 404));
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new ApiError('FILE_ERROR', `Could not read the uploaded archive (HTTP ${status}).`, 502));
        return;
      }
      resolve(res);
    });
    req.on('error', (err) => reject(new ApiError('FILE_ERROR',
      `Could not read the uploaded archive: ${err.message}`, 502)));
  });
}

/** file-manager gateway used by the reaper. */
function fmGateway(app: FastifyInstance): FileManagerGateway {
  const k8sTenants = createK8sClients(kubeconfigPathOf(app));
  const kubeconfigPath = kubeconfigPathOf(app);
  const image = getFileManagerImage(app);
  return {
    remove: async (namespace, path, permanent) => {
      const r = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, image, '/rm', {
        method: 'POST',
        body: JSON.stringify({ path, permanent, actor: 'bundle-import' }),
        contentType: 'application/json',
      });
      if (r.status !== 200) throw new Error(`rm failed with HTTP ${r.status}`);
    },
    list: async (namespace, path) => {
      const r = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, image, '/ls', {
        query: { path },
      });
      if (r.status !== 200) throw new Error(`ls failed with HTTP ${r.status}`);
      const parsed = JSON.parse(r.body) as { entries?: Array<{ name: string; modifiedAt?: string }> };
      return parsed.entries ?? [];
    },
  };
}

function uploadRelPath(importId: string, extension: string): string {
  return `${BUNDLE_IMPORT_UPLOAD_DIR}/${importId}.${extension}`;
}

/** Translate an archive-decode failure into an operator-legible API error. */
function archiveError(err: unknown): never {
  if (err instanceof ArchiveMetaError) {
    const status = err.code === 'PASSPHRASE_REQUIRED' || err.code === 'PASSPHRASE_INVALID' ? 400 : 400;
    throw new ApiError(err.code, err.message, status);
  }
  throw err;
}

async function runPreflight(
  app: FastifyInstance,
  tenantId: string,
  scope: ImportScope,
  body: unknown,
): Promise<Record<string, unknown>> {
  const parsed = bundleImportPreflightInputSchema.safeParse(body);
  if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0]!.message, 400);
  const { importId, extension, passphrase } = parsed.data;

  const namespace = await resolveTenantNamespace(app, tenantId);
  const relPath = uploadRelPath(importId, extension);
  const stream = await openUploadedArchive(app, namespace, relPath);

  let meta: Record<string, unknown>;
  let format: string;
  try {
    const read = await readArchiveMeta({ stream, passphrase });
    meta = read.meta;
    format = read.format;
  } catch (err) {
    try { stream.destroy(); } catch { /* already gone */ }
    archiveError(err);
  }

  const preflight = await buildImportPreflight({ db: app.db, meta, targetTenantId: tenantId, scope });
  return { importId, format, ...preflight };
}

async function startImport(
  app: FastifyInstance,
  tenantId: string,
  scope: ImportScope,
  initiator: 'admin' | 'tenant',
  body: unknown,
): Promise<Record<string, unknown>> {
  const parsed = bundleImportStartInputSchema.safeParse(body);
  if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0]!.message, 400);
  const { importId, extension, passphrase, targetConfigId, label, retentionDays } = parsed.data;

  const namespace = await resolveTenantNamespace(app, tenantId);
  const relPath = uploadRelPath(importId, extension);

  // Re-read the manifest rather than trusting a preflight the client echoes
  // back: the archive on disk is the only thing that decides what gets
  // imported, and a client-supplied unit list would be a way to import a
  // mailbox whose domain the ownership check never saw.
  const stream = await openUploadedArchive(app, namespace, relPath);
  let meta: Record<string, unknown>;
  try {
    meta = (await readArchiveMeta({ stream, passphrase })).meta;
  } catch (err) {
    try { stream.destroy(); } catch { /* already gone */ }
    archiveError(err);
  }

  const preflight = await buildImportPreflight({ db: app.db, meta, targetTenantId: tenantId, scope });
  if (preflight.blocked) {
    throw new ApiError('IMPORT_BLOCKED', preflight.blockReasons.join(' '), 409);
  }

  const encryptionKey = ((app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined)
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!encryptionKey) throw new ApiError('CONFIG_INVALID', 'PLATFORM_ENCRYPTION_KEY not configured', 500);

  const deps: ImportRunnerDeps = {
    db: app.db,
    k8s: createK8sClients(kubeconfigPathOf(app)),
    fm: fmGateway(app),
    log: {
      warn: (ctx, msg) => app.log.warn(ctx, msg),
      info: (ctx, msg) => app.log.info(ctx, msg),
    },
    encryptionKey,
    platformApiUrl: ((app.config as Record<string, unknown>).PLATFORM_API_INTERNAL_URL as string | undefined)
      ?? process.env.PLATFORM_API_INTERNAL_URL
      ?? 'http://platform-api.platform.svc:3000',
    platformVersion: ((app.config as Record<string, unknown>).PLATFORM_VERSION as string | undefined)
      ?? process.env.PLATFORM_VERSION ?? 'unknown',
  };

  const result = await runBundleImport(deps, {
    tenantId,
    namespace,
    pvcName: `${namespace}-storage`,
    importId,
    archiveRelPath: relPath,
    targetConfigId,
    preflight,
    scope,
    initiator,
    label,
    retentionDays,
  });

  return {
    bundleId: result.bundleId,
    sizeBytes: result.sizeBytes,
    unitCount: result.units.length,
    objectCount: result.objects.length,
    label: buildImportLabel(label),
  };
}

/** Admin: /api/v1/admin/tenants/:tenantId/bundle-imports/… */
export async function bundleImportAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  app.post('/admin/tenants/:tenantId/bundle-imports/preflight', {
    preHandler: requireRole('super_admin', 'admin'),
    schema: {
      tags: ['TenantBundles'],
      summary: 'Inspect an uploaded bundle and report what it would import',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    return success(await runPreflight(app, tenantId, 'admin', request.body));
  });

  app.post('/admin/tenants/:tenantId/bundle-imports', {
    preHandler: requireRole('super_admin', 'admin'),
    schema: {
      tags: ['TenantBundles'],
      summary: 'Import an uploaded bundle into this tenant',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const out = await startImport(app, tenantId, 'admin', 'admin', request.body);
    reply.status(201);
    return success(out);
  });

  app.post('/admin/tenants/:tenantId/bundle-imports/new-id', {
    preHandler: requireRole('super_admin', 'admin'),
    schema: { tags: ['TenantBundles'], summary: 'Mint an import id + upload path', security: [{ bearerAuth: [] }] },
  }, async () => success(mintImportTarget()));
}

/** Tenant: /api/v1/tenant/bundle-imports/… — files + mailboxes only. */
export async function bundleImportTenantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('tenant'));

  // The tenant comes from the JWT — there is no path param to spoof, so a
  // tenant can only ever import into their own space.
  function tenantIdFromRequest(request: { user?: { tenantId?: string } }): string {
    const id = request.user?.tenantId;
    if (!id) throw new ApiError('CLIENT_ACCESS_DENIED', 'Client-panel token missing tenantId', 403);
    return id;
  }

  app.post('/tenant/bundle-imports/preflight', {
    schema: { tags: ['TenantBundles'], summary: 'Inspect an uploaded bundle', security: [{ bearerAuth: [] }] },
  }, async (request) => success(
    await runPreflight(app, tenantIdFromRequest(request), 'tenant', request.body),
  ));

  app.post('/tenant/bundle-imports', {
    schema: { tags: ['TenantBundles'], summary: 'Import an uploaded bundle', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const out = await startImport(app, tenantIdFromRequest(request), 'tenant', 'tenant', request.body);
    reply.status(201);
    return success(out);
  });

  app.post('/tenant/bundle-imports/new-id', {
    schema: { tags: ['TenantBundles'], summary: 'Mint an import id + upload path', security: [{ bearerAuth: [] }] },
  }, async () => success(mintImportTarget()));
}

/**
 * Mint the id and the upload path together.
 *
 * Server-side so the panels never have to construct the path themselves — a
 * client that guessed `.insula-import/` (singular) would upload successfully
 * and then get "no uploaded archive found", which is a confusing way to learn
 * about a typo.
 */
export function mintImportTarget(): { importId: string; uploadDir: string; uploadPathFor: Record<string, string> } {
  const importId = `imp${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return {
    importId,
    uploadDir: BUNDLE_IMPORT_UPLOAD_DIR,
    uploadPathFor: {
      'tar.gz': `/${uploadRelPath(importId, 'tar.gz')}`,
      'tar.gz.enc': `/${uploadRelPath(importId, 'tar.gz.enc')}`,
    },
  };
}
