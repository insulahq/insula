/**
 * Internal download endpoint — `GET /api/v1/internal/bundles/:bundleId
 * /components/:component/:artifactName?token=<>`.
 *
 * Mirror of internal-upload-route.ts: a tenant-namespace Job presents
 * an HMAC-signed token bound to the (bundleId, component, artifactName)
 * triple, and we pipe the bytes from BackupStore.readComponent straight
 * into the response. No buffering on platform-api side.
 *
 * Used by Phase-4.x restore executors:
 *   - files-paths    — Job in tenant ns runs:
 *                       curl ... | tar -xzf - -- <path-list>
 *   - mailboxes      — Job in mail ns runs:
 *                       curl ... > /tmp/<addr>.tar.gz &&
 *                       stalwart-cli account import <addr> /tmp/...
 *
 * Authentication: same HMAC token format as upload (signUploadToken /
 * verifyUploadToken). The token's component+artifact binding restricts
 * what each Job can read. Tokens expire 30 min after issuance.
 *
 * NO `authenticate` hook — the HMAC token IS the auth. Mounted under
 * `/internal/` so a NetworkPolicy can restrict access to in-cluster
 * pods only (same approach as the upload route).
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { backupJobs, backupConfigurations, backupComponents } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { S3BackupStore } from './s3-backup-store.js';
import { SshBackupStore } from './ssh-backup-store.js';
import type { BackupStore } from './bundle-store.js';
import { resolveShimFirstBackupStore } from './shim-backup-store.js';
import { resolveShimBackupTarget } from './resolve-backup-target.js';
import { runResticDump, deriveResticPassword } from './restic-driver.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { decrypt } from '../oidc/crypto.js';
import { verifyUploadToken } from './upload-token.js';

const ALLOWED_COMPONENTS = new Set(['files', 'mailboxes', 'config', 'secrets'] as const);
const RESTIC_STREAM_ARTIFACT = 'restic-stream';
const RESTIC_SNAPSHOT_ID_RE = /^[0-9a-f]{8,64}$/;

export async function backupsV2InternalDownloadRoutes(app: FastifyInstance): Promise<void> {
  const configuredKey = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    // Hard-fail in production. The HMAC tokens are signed with this
    // key — falling back to all-zeros would let an attacker who reads
    // the source forge download tokens. Mirror the upload-route policy.
    throw new Error('backupsV2InternalDownloadRoutes: PLATFORM_ENCRYPTION_KEY is required in production');
  }
  const secretsKeyHex = configuredKey ?? '0'.repeat(64);

  app.get('/internal/bundles/:bundleId/components/:component/:artifactName', {
    schema: { tags: ['TenantBundles-Internal'], summary: 'Stream a component artifact download to a tenant Job' },
  }, async (request, reply) => {
    const { bundleId, component, artifactName } = request.params as {
      bundleId: string;
      component: string;
      artifactName: string;
    };
    const token = (request.query as { token?: string }).token ?? '';

    // Argument-level validation BEFORE any DB or store work — keeps
    // probes (no token, bad token, weird filenames) from hitting DB.
    if (!ALLOWED_COMPONENTS.has(component as 'files' | 'mailboxes' | 'config' | 'secrets')) {
      throw new ApiError('VALIDATION_ERROR', `unsupported component '${component}'`, 400);
    }
    // Reject path-traversal + relative paths defensively. Same regex
    // as upload route — keeps the artifact name to a flat filename.
    if (artifactName === '.' || artifactName === '..' || artifactName.includes('/') || !/^[A-Za-z0-9._@-]+$/.test(artifactName)) {
      throw new ApiError('VALIDATION_ERROR', `invalid artifactName '${artifactName}'`, 400);
    }
    if (!token) throw new ApiError('UNAUTHORIZED', 'missing download token', 401);

    const verifyErr = verifyUploadToken(
      token,
      { bundleId, component: component as 'files' | 'mailboxes' | 'config' | 'secrets', artifactName },
      secretsKeyHex,
    );
    if (verifyErr) {
      // Server-side log carries the precise reason (MALFORMED /
      // EXPIRED / BAD_MAC); the tenant-facing 401 body is intentionally
      // indistinguishable so a probing attacker can't differentiate
      // failure modes — mirrors the upload-route policy.
      app.log.warn({ verifyErr, bundleId, component, artifactName }, 'tenant-bundles internal download: token rejected');
      throw new ApiError('UNAUTHORIZED', 'download token invalid', 401);
    }

    // Resolve the bundle + its target. The HMAC has bound the token to
    // this exact (bundleId, component, artifactName), so we can trust
    // the URL bundleId now.
    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, bundleId)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
    if (!job.targetConfigId) {
      throw new ApiError('CONFIG_INVALID', 'Bundle has no target_config_id', 400);
    }

    const store = await resolveStoreForDownload(app, job.targetConfigId, secretsKeyHex);
    const handle = await store.open(bundleId);
    if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);

    // Stat first so we can set Content-Length and produce a 404 BEFORE
    // committing to the response stream. readComponent throws if the
    // artifact is missing, but throwing after the headers are sent
    // would leave the response half-written.
    const stat = await store.stat(handle, component as 'files' | 'mailboxes' | 'config' | 'secrets', artifactName);
    if (!stat) throw new ApiError('NOT_FOUND', `Artifact ${component}/${artifactName} not found in bundle ${bundleId}`, 404);

    // Open the body stream and pipe straight to the response. Fastify
    // accepts a Readable as the reply payload and handles backpressure.
    const body = await store.readComponent(handle, component as 'files' | 'mailboxes' | 'config' | 'secrets', artifactName);

    // Headers — Content-Type best-effort (artifact extension), and
    // Content-Length from stat() so callers can show progress.
    const contentType = guessContentType(artifactName);
    reply.header('Content-Type', contentType);
    if (Number.isFinite(stat.sizeBytes) && stat.sizeBytes >= 0) {
      reply.header('Content-Length', String(stat.sizeBytes));
    }
    reply.header('Cache-Control', 'no-store');
    return reply.send(body);
  });

  // ── GET /internal/bundles/:bundleId/files-restic-tar ───────────────
  // Restore-into-PVC: stream the files component's restic snapshot as a
  // raw (uncompressed) tar, reconstructed via `restic dump`. The files
  // capture stored the PVC contents with `restic backup --stdin
  // --stdin-filename archive.tar`; this is the exact inverse. A tenant-
  // namespace restore Job curls this endpoint and untars the body into
  // the (freshly recreated) PVC.
  //
  // This is the genuinely-missing files restore-into-PVC primitive: the
  // legacy `files-paths` executor reads a raw `archive.tar.gz` from the
  // bundle store, which the restic capture never writes. Restoring from
  // a restic bundle MUST go through `restic dump`.
  //
  // Auth: same HMAC token bound to (bundleId, 'files', 'restic-stream')
  // as the capture upload. restic + backup creds stay on platform-api —
  // never materialised in the tenant Job (identical trust boundary to
  // the capture path).
  app.get('/internal/bundles/:bundleId/files-restic-tar', {
    schema: { tags: ['TenantBundles-Internal'], summary: 'Stream a files restic snapshot as a tar to a restore Job' },
  }, async (request, reply) => {
    const { bundleId } = request.params as { bundleId: string };
    const token = (request.query as { token?: string }).token ?? '';
    if (!token) throw new ApiError('UNAUTHORIZED', 'missing download token', 401);

    const verifyErr = verifyUploadToken(
      token,
      { bundleId, component: 'files', artifactName: RESTIC_STREAM_ARTIFACT },
      secretsKeyHex,
    );
    if (verifyErr) {
      app.log.warn({ verifyErr, bundleId }, 'tenant-bundles files-restic-tar: token rejected');
      throw new ApiError('UNAUTHORIZED', 'download token invalid', 401);
    }

    const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, bundleId)).limit(1);
    if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);

    // The files component records its restic snapshot id in
    // backup_components.sha256. NOTE: the persisted row's artifact_name
    // is the legacy `archive.tar.gz` (orchestrator.insertComponentRow),
    // NOT the `restic-stream` the upload/download HMAC token binds to —
    // so we filter by component, not artifact_name. There is exactly one
    // files row per bundle (unique index on job+component+artifact).
    const [comp] = await app.db.select()
      .from(backupComponents)
      .where(and(
        eq(backupComponents.backupJobId, bundleId),
        eq(backupComponents.component, 'files'),
      ))
      .limit(1);
    if (!comp?.sha256 || !RESTIC_SNAPSHOT_ID_RE.test(comp.sha256)) {
      throw new ApiError('NOT_FOUND', `Bundle ${bundleId} has no files restic snapshot`, 404);
    }

    // Resolve the shim 'tenant' restic target + the per-tenant repo
    // password. These never leave platform-api.
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined
      ?? process.env.KUBECONFIG_PATH;
    const k8s = createK8sClients(kubeconfigPath);
    const target = await resolveShimBackupTarget(k8s.core, 'tenant', app.log);
    const passwordHex = deriveResticPassword(secretsKeyHex, job.tenantId);

    const stream = await runResticDump({
      target,
      tenantId: job.tenantId,
      component: 'files',
      snapshotId: comp.sha256,
      dumpPath: '/archive.tar',
      passwordHex,
    });

    reply.header('Content-Type', 'application/x-tar');
    reply.header('Cache-Control', 'no-store');
    return reply.send(stream);
  });
}

function guessContentType(name: string): string {
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) return 'application/gzip';
  if (name.endsWith('.json.gz')) return 'application/gzip';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.gz')) return 'application/gzip';
  return 'application/octet-stream';
}

/**
 * Same shape as resolveStoreForUpload — does NOT enforce the `active`
 * flag. A restore from a now-deactivated target must still succeed;
 * the activation gate applies to NEW bundle creates, not reads of
 * existing bundles.
 *
 * B9 routing parity (2026-05-23): tenant bundles WRITE through the
 * backup-rclone-shim regardless of upstream protocol. Restore READS
 * must therefore also try the shim first — otherwise CIFS + NFS
 * targets fail with `Backup store kind 'cifs' is not supported`.
 */
async function resolveStoreForDownload(app: FastifyInstance, targetConfigId: string, encKey: string): Promise<BackupStore> {
  return resolveShimFirstBackupStore(
    app, 'tenant',
    () => resolveDirectStoreForDownload(app, targetConfigId, encKey),
    'tenant-bundles download',
  );
}

async function resolveDirectStoreForDownload(app: FastifyInstance, targetConfigId: string, encKey: string): Promise<BackupStore> {
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);
  // encKey is the same hex captured at route registration time —
  // keeps HMAC verification and store decryption keys in lock-step
  // for one request, even if process.env mutates at runtime.

  if (cfg.storageType === 's3') {
    let accessKey = '';
    let secretKey = '';
    try {
      accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, encKey) : '';
      secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, encKey) : '';
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-bundles download: S3 credential decryption failed');
      throw new ApiError('CONFIG_INVALID', 'S3 credential decryption failed', 500);
    }
    if (!accessKey || !secretKey) {
      throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.id} has no S3 credentials configured`, 400);
    }
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
      throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.id} is missing SSH host/user/key/path`, 400);
    }
    let privateKey = '';
    try {
      privateKey = decrypt(cfg.sshKeyEncrypted, encKey);
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-bundles download: SSH key decryption failed');
      throw new ApiError('CONFIG_INVALID', 'SSH key decryption failed', 500);
    }
    if (!privateKey) {
      throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.id} has empty SSH key`, 400);
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

  throw new ApiError('NOT_IMPLEMENTED', `Backup store kind '${cfg.storageType}' is not supported`, 501);
}
