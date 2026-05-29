import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { authenticate, requireRole, requireTenantRoleByMethod, requireTenantAccess } from '../../middleware/auth.js';
import { writeFileInputSchema, createDirectoryInputSchema, renameInputSchema, deleteInputSchema, copyInputSchema, archiveInputSchema, extractInputSchema, gitCloneInputSchema, chmodInputSchema, chownInputSchema } from '@insula/api-contracts';
import { tenants } from '../../db/schema.js';
import { success, errorResponse } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { fileManagerRequest, streamToFileManager, streamFromFileManager, getFileManagerStatus, ensureFileManagerRunning, stopFileManager, resolveFmServiceUrlForRoute, ensureFileManagerReady } from './service.js';
import { getFileManagerImage } from './image.js';
import { recordFileManagerAccess } from './idle-cleanup.js';

async function resolveNamespace(app: FastifyInstance, tenantId: string): Promise<string> {
  const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404);
  if (tenant.provisioningStatus !== 'provisioned') {
    throw new ApiError('NOT_PROVISIONED', 'Tenant must be provisioned before accessing files', 409);
  }
  return tenant.kubernetesNamespace;
}

export async function fileManagerRoutes(app: FastifyInstance): Promise<void> {
  // Support ?token= query param for <img src> (browser can't set Authorization header)
  app.addHook('onRequest', (request, _reply, done) => {
    if (!request.headers.authorization) {
      const query = request.query as Record<string, string>;
      if (query.token) {
        request.headers.authorization = `Bearer ${query.token}`;
      }
    }
    done();
  });

  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireTenantRoleByMethod());
  app.addHook('onRequest', requireTenantAccess());

  // Register content type parser for binary uploads — do NOT buffer the body.
  // The upload-raw route streams request.raw directly to the sidecar.
  app.addContentTypeParser('application/octet-stream', (_req, _payload, done) => {
    done(null, undefined);
  });
  // Accept multipart so the /upload handler can return a clean 410 Gone
  // instead of Fastify's generic "Unsupported Media Type" 415 (which the
  // error pipeline masks as a 500). We never actually parse the body —
  // the deprecated handler short-circuits before needing it.
  app.addContentTypeParser(/^multipart\//, (_req, _payload, done) => {
    done(null, undefined);
  });

  const getK8s = () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    return { k8sTenants: createK8sClients(kubeconfigPath), kubeconfigPath };
  };

  // GET /api/v1/tenants/:tenantId/files/status — check file manager pod status
  app.get('/tenants/:tenantId/files/status', {
    schema: { tags: ['Files'], summary: 'Get file manager status', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const namespace = await resolveNamespace(app, tenantId);
    const { k8sTenants } = getK8s();
    // Status polling counts as activity — without this, a UI that
    // sits on the loading screen for ~10min would have its pod
    // scaled back to 0 by the idle-cleanup loop while still being
    // actively waited-on by the user.
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const status = await getFileManagerStatus(k8sTenants, namespace);
    return success(status);
  });

  // POST /api/v1/tenants/:tenantId/files/start — start file manager pod
  app.post('/tenants/:tenantId/files/start', {
    schema: { tags: ['Files'], summary: 'Start file manager pod', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const namespace = await resolveNamespace(app, tenantId);
    const { k8sTenants } = getK8s();
    await ensureFileManagerRunning(k8sTenants, namespace, getFileManagerImage());
    // Refresh idle timer so the cleanup loop doesn't immediately
    // scale the pod we just asked for back down. /start is a clear
    // user intent to USE the file-manager.
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const status = await getFileManagerStatus(k8sTenants, namespace);
    return success(status);
  });

  // POST /api/v1/tenants/:tenantId/files/stop — stop file manager pod
  app.post('/tenants/:tenantId/files/stop', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: { tags: ['Files'], summary: 'Stop file manager pod', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const namespace = await resolveNamespace(app, tenantId);
    const { k8sTenants } = getK8s();
    await stopFileManager(k8sTenants, namespace);
    return success({ stopped: true });
  });

  // GET /api/v1/tenants/:tenantId/files/disk-usage — get disk usage
  app.get('/tenants/:tenantId/files/disk-usage', {
    schema: { tags: ['Files'], summary: 'Get disk usage', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();
    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/disk-usage', {});
    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to get disk usage', result.status);
    }
    return success(JSON.parse(result.body));
  });

  // GET /api/v1/tenants/:tenantId/files/folder-size — calculate folder size
  app.get('/tenants/:tenantId/files/folder-size', {
    schema: { tags: ['Files'], summary: 'Calculate folder size', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as Record<string, string>;
    if (!query.path) throw new ApiError('INVALID_FIELD_VALUE', 'path query parameter required', 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();
    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/folder-size', {
      query: { path: query.path },
    });
    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to calculate folder size', result.status);
    }
    return success(JSON.parse(result.body));
  });

  // GET /api/v1/tenants/:tenantId/files — list directory
  app.get('/tenants/:tenantId/files', {
    schema: { tags: ['Files'], summary: 'List directory', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as Record<string, string>;
    const path = query.path || '/';
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/ls', {
      query: { path },
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to list directory', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // GET /api/v1/tenants/:tenantId/files/read — read file content
  app.get('/tenants/:tenantId/files/read', {
    schema: { tags: ['Files'], summary: 'Read file content', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as Record<string, string>;
    if (!query.path) throw new ApiError('INVALID_FIELD_VALUE', 'path query parameter required', 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/read', {
      query: { path: query.path },
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to read file', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // GET /api/v1/tenants/:tenantId/files/download — download file (streaming, no RAM buffering)
  app.get('/tenants/:tenantId/files/download', {
    schema: { tags: ['Files'], summary: 'Download file', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as Record<string, string>;
    if (!query.path) throw new ApiError('INVALID_FIELD_VALUE', 'path query parameter required', 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    // Probe-first ready helper: ~10 ms when FM is healthy (most calls),
    // skips the K8s API ensure+status round-trips that previously made
    // download/preview cold-start take 3-7 s.
    const { directUrl } = await ensureFileManagerReady(k8sTenants, namespace, getFileManagerImage());

    // streamFromFileManager throws on non-2xx upstream BEFORE writing
    // any response headers (it drains a bounded 16 KiB error buffer
    // and re-throws with `upstreamStatus` + `upstreamBody`). On 2xx it
    // hijacks reply.raw, writes upstream headers, and pipes the body.
    // Either way Fastify-compress is bypassed (we never call reply.send
    // on success; we throw via ApiError on failure so the global error
    // handler formats the standard envelope).
    try {
      reply.hijack();
      await streamFromFileManager(kubeconfigPath, namespace, '/download', reply.raw, {
        query: { path: query.path },
        ...(directUrl ? { directUrl } : {}),
      });
    } catch (err) {
      const e = err as { upstreamStatus?: number; upstreamBody?: string };
      if (reply.raw.headersSent) {
        // Streaming already started — TCP-end is the only honest signal.
        try { reply.raw.end(); } catch { /* ignore */ }
        return;
      }
      const status = e.upstreamStatus ?? 500;
      let message = 'Failed to download file';
      if (e.upstreamBody) {
        try {
          const parsed = JSON.parse(e.upstreamBody) as { error?: string; message?: string };
          message = parsed.error ?? parsed.message ?? message;
        } catch { /* non-JSON body — keep generic message */ }
      }
      // We hijacked already, so we have to write the error envelope
      // ourselves. Match `errorResponse()` so tenants/tests parse it
      // identically to any other API error.
      const body = JSON.stringify(errorResponse('FILE_ERROR', message, status, request.id));
      reply.raw.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
      reply.raw.end(body);
    }
  });

  // POST /api/v1/tenants/:tenantId/files/mkdir — create directory
  app.post('/tenants/:tenantId/files/mkdir', {
    schema: { tags: ['Files'], summary: 'Create directory', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = createDirectoryInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: parsed.data.path }),
      contentType: 'application/json',
    });

    if (result.status !== 201) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to create directory', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/tenants/:tenantId/files/write — write file content
  app.post('/tenants/:tenantId/files/write', {
    schema: { tags: ['Files'], summary: 'Write file content', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = writeFileInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/write', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to write file', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/tenants/:tenantId/files/rename — rename/move
  app.post('/tenants/:tenantId/files/rename', {
    schema: { tags: ['Files'], summary: 'Rename file or directory', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = renameInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/rename', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to rename', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/tenants/:tenantId/files/delete — delete file or directory
  // Uses POST instead of DELETE because K8s API proxy can strip DELETE body
  app.post('/tenants/:tenantId/files/delete', {
    schema: { tags: ['Files'], summary: 'Delete file or directory', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = deleteInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/rm', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to delete', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/tenants/:tenantId/files/copy — copy file or directory
  app.post('/tenants/:tenantId/files/copy', {
    schema: { tags: ['Files'], summary: 'Copy file or directory', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = copyInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/copy', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to copy', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/tenants/:tenantId/files/archive — create archive
  app.post('/tenants/:tenantId/files/archive', {
    schema: { tags: ['Files'], summary: 'Create archive from files', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = archiveInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/archive', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 201) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to create archive', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/tenants/:tenantId/files/extract — extract archive
  app.post('/tenants/:tenantId/files/extract', {
    schema: { tags: ['Files'], summary: 'Extract archive', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = extractInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/extract', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to extract archive', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/tenants/:tenantId/files/git-clone — clone git repository
  app.post('/tenants/:tenantId/files/git-clone', {
    schema: { tags: ['Files'], summary: 'Clone git repository', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = gitCloneInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/git-clone', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 201) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to clone repository', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/tenants/:tenantId/files/chmod — change file/directory permissions
  app.post('/tenants/:tenantId/files/chmod', {
    schema: { tags: ['Files'], summary: 'Change file or directory permissions', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = chmodInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/chmod', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to change permissions', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/tenants/:tenantId/files/chown — change file/directory ownership
  app.post('/tenants/:tenantId/files/chown', {
    schema: { tags: ['Files'], summary: 'Change file or directory ownership', security: [{ bearerAuth: [] }] },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = chownInputSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('INVALID_FIELD_VALUE', parsed.error.issues[0].message, 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const result = await fileManagerRequest(k8sTenants, kubeconfigPath, namespace, getFileManagerImage(), '/chown', {
      method: 'POST',
      body: JSON.stringify(parsed.data),
      contentType: 'application/json',
    });

    if (result.status !== 200) {
      const err = JSON.parse(result.body);
      throw new ApiError('FILE_ERROR', err.error || 'Failed to change ownership', result.status);
    }

    return success(JSON.parse(result.body));
  });

  // POST /api/v1/tenants/:tenantId/files/upload-raw — streaming raw binary upload
  // Body limit raised to effectively unbounded (5 TiB; Fastify rejects 0).
  // The route never buffers anyway — request.raw is piped straight to the
  // sidecar. Only the PVC quota actually gates upload size.
  app.post('/tenants/:tenantId/files/upload-raw', {
    bodyLimit: 5 * 1024 * 1024 * 1024 * 1024,
    schema: { tags: ['Files'], summary: 'Upload file (raw binary, streaming)', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as Record<string, string>;
    if (!query.path) throw new ApiError('INVALID_FIELD_VALUE', 'path query parameter required', 400);
    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    // Probe-first ready helper (same fast path as /download).
    const { directUrl } = await ensureFileManagerReady(k8sTenants, namespace, getFileManagerImage());

    // Forward `offset` query param to enable parallel-chunked uploads.
    // When the tenant splits a file into N chunks and POSTs each with
    // ?offset=<absolute byte offset>, the sidecar pwrites at that
    // offset without truncating — so concurrent chunks land in their
    // correct slot and the file is whole when all chunks complete.
    const fwdQuery: Record<string, string> = { path: query.path };
    if (query.offset !== undefined) fwdQuery.offset = query.offset;

    // Stream the raw request body directly to the sidecar
    const result = await streamToFileManager(kubeconfigPath, namespace, '/write-raw', request.raw, {
      contentType: 'application/octet-stream',
      contentLength: request.headers['content-length'],
      query: fwdQuery,
      ...(directUrl ? { directUrl } : {}),
    });

    if (result.status !== 200) {
      let errMsg = 'Failed to upload';
      try { errMsg = JSON.parse(result.body).error || errMsg; } catch { /* ignore parse error */ }
      throw new ApiError('FILE_ERROR', errMsg, result.status);
    }

    return reply.send(success(JSON.parse(result.body)));
  });

  // POST /api/v1/tenants/:tenantId/files/upload — deprecated multipart path.
  // Responds 410 Gone with a pointer to /upload-raw. The multipart handler
  // used to buffer the whole request body in memory inside the sidecar pod
  // (limits.memory=128Mi), which meant any upload over ~80 MiB OOM-killed
  // the sidecar. The streaming /upload-raw replacement has no in-RAM buffer
  // and is what the UI has used from the start. This stub stays so any
  // external tool still hitting the old URL gets a clear error instead of
  // a 404 guessing game.
  app.post('/tenants/:tenantId/files/upload', {
    schema: { tags: ['Files'], summary: 'Upload file (deprecated — use /upload-raw)', security: [{ bearerAuth: [] }] },
  }, async (_request, reply) => {
    reply.status(410).send({
      error: {
        code: 'DEPRECATED_ENDPOINT',
        message: 'Multipart /files/upload was removed. Stream the body to /files/upload-raw instead (Content-Type: application/octet-stream, path=<dest> query).',
      },
    });
  });

  // POST /api/v1/tenants/:tenantId/files/fetch-url — download file from URL
  // Uses streaming proxy (not buffered fileManagerRequest) for real-time progress
  app.post('/tenants/:tenantId/files/fetch-url', {
    schema: { tags: ['Files'], summary: 'Download file from URL to PVC', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { url, path: destPath, force } = request.body as { url?: string; path?: string; force?: boolean };
    if (!url || !destPath) throw new ApiError('MISSING_REQUIRED_FIELD', 'url and path required', 400);

    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const { directUrl } = await ensureFileManagerReady(k8sTenants, namespace, getFileManagerImage());
    const { proxyToFileManagerStream } = await import('./service.js');
    reply.hijack();
    await proxyToFileManagerStream(
      kubeconfigPath,
      namespace,
      '/fetch-url',
      JSON.stringify({ url, path: destPath, force: force ?? false }),
      reply.raw,
      directUrl ? { directUrl } : {},
    );
  });

  // POST /api/v1/tenants/:tenantId/files/clone-site — clone entire website
  app.post('/tenants/:tenantId/files/clone-site', {
    schema: { tags: ['Files'], summary: 'Clone website to PVC', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const { url, path: destPath, maxPages, maxDepth, prettifyHtml, prettifyCss, prettifyJs } = request.body as {
      url?: string; path?: string; maxPages?: number; maxDepth?: number;
      prettifyHtml?: boolean; prettifyCss?: boolean; prettifyJs?: boolean;
    };
    if (!url || !destPath) throw new ApiError('MISSING_REQUIRED_FIELD', 'url and path required', 400);

    const namespace = await resolveNamespace(app, tenantId);
    recordFileManagerAccess(namespace, getK8s().k8sTenants);
    const { k8sTenants, kubeconfigPath } = getK8s();

    const { directUrl } = await ensureFileManagerReady(k8sTenants, namespace, getFileManagerImage());
    const { proxyToFileManagerStream } = await import('./service.js');
    reply.hijack();
    await proxyToFileManagerStream(
      kubeconfigPath,
      namespace,
      '/clone-site',
      JSON.stringify({ url, path: destPath, maxPages: maxPages ?? 50, maxDepth: maxDepth ?? 3, prettifyHtml: prettifyHtml ?? false, prettifyCss: prettifyCss ?? false, prettifyJs: prettifyJs ?? false }),
      reply.raw,
      directUrl ? { directUrl } : {},
    );
  });
}
