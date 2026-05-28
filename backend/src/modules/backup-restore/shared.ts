/**
 * Shared helpers for backup-restore routes.
 *
 * Both admin (`/api/v1/admin/restores/*`) and tenant
 * (`/api/v1/tenants/:tenantId/restore-carts/*`, added 2026-05-28)
 * route surfaces use the same cart machinery, executors, and bundle
 * read paths. The tenant surface adds policy filtering on top.
 *
 * These functions were originally private inside `routes.ts`; lifted
 * here so the new `tenant-routes.ts` can call them without
 * duplicating logic.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { gunzipSync } from 'node:zlib';
import { ApiError } from '../../shared/errors.js';
import {
  backupJobs,
  backupConfigurations,
  type RestoreJob,
  type RestoreItem,
} from '../../db/schema.js';
import type {
  RestoreJobSummary,
  RestoreItemInfo,
  RestoreItemType,
} from '@k8s-hosting/api-contracts';
import { decrypt } from '../oidc/crypto.js';
import { S3BackupStore } from '../tenant-bundles/s3-backup-store.js';
import { SshBackupStore } from '../tenant-bundles/ssh-backup-store.js';
import type { BackupStore } from '../tenant-bundles/bundle-store.js';
import { resolveShimFirstBackupStore } from '../tenant-bundles/shim-backup-store.js';
import { execConfigTablesItem } from './executors/config-tables.js';
import { execDeploymentsByIdItem } from './executors/deployments-by-id.js';
import { execDomainsByIdItem } from './executors/domains-by-id.js';
import { execFilesPathsItem } from './executors/files-paths.js';
import { execMailboxesByAddressItem } from './executors/mailboxes-by-address.js';
import type { TenantRestorePolicy } from './tenant-restore-policy.js';

export function toJobSummary(j: RestoreJob): RestoreJobSummary {
  return {
    id: j.id,
    tenantId: j.tenantId,
    initiatorUserId: j.initiatorUserId,
    status: j.status,
    preRestoreSnapshotId: j.preRestoreSnapshotId,
    description: j.description,
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
    lastError: j.lastError,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

export function toItemInfo(i: RestoreItem): RestoreItemInfo {
  return {
    id: i.id,
    restoreJobId: i.restoreJobId,
    bundleId: i.bundleId,
    type: i.type as RestoreItemType,
    selector: i.selector,
    label: i.label,
    seq: i.seq,
    status: i.status,
    progressMessage: i.progressMessage,
    sizeBytes: Number(i.sizeBytes),
    startedAt: i.startedAt ? i.startedAt.toISOString() : null,
    finishedAt: i.finishedAt ? i.finishedAt.toISOString() : null,
    lastError: i.lastError,
  };
}

export async function loadBundle(app: FastifyInstance, bundleId: string) {
  const [job] = await app.db.select().from(backupJobs).where(eq(backupJobs.id, bundleId)).limit(1);
  if (!job) throw new ApiError('NOT_FOUND', 'Bundle not found', 404);
  if (!job.targetConfigId) {
    throw new ApiError('CONFIG_INVALID', 'Bundle has no target_config_id (legacy row)', 400);
  }
  return job;
}

export async function resolveStoreForBundle(app: FastifyInstance, bundleId: string): Promise<BackupStore> {
  const job = await loadBundle(app, bundleId);
  // B9 routing parity: tenant bundles are WRITTEN through the
  // backup-rclone-shim regardless of upstream (S3/SFTP/CIFS/NFS).
  // The restore READ must therefore also go through the shim,
  // otherwise CIFS + NFS targets fail with `Store kind 'cifs' not
  // supported` — the restore cart can only see s3+ssh directly.
  return resolveShimFirstBackupStore(
    app, 'tenant',
    () => resolveDirectStoreForBundle(app, job.targetConfigId!),
    'tenant-backup-restore',
  );
}

export async function resolveDirectStoreForBundle(app: FastifyInstance, targetConfigId: string): Promise<BackupStore> {
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);
  const configuredKey = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    app.log.error('tenant-backup-restore: PLATFORM_ENCRYPTION_KEY is not set in production — refusing to decrypt target credentials with zero-key fallback');
    throw new ApiError('CONFIG_INVALID', 'PLATFORM_ENCRYPTION_KEY is not configured; cannot decrypt backup target credentials', 500);
  }
  const encKey = configuredKey ?? '0'.repeat(64);
  if (cfg.storageType === 's3') {
    // Wrap decrypt() in try/catch — OpenSSL error strings can leak
    // ciphertext fragments. Match tenant-bundles/routes.ts pattern.
    let accessKey: string;
    let secretKey: string;
    try {
      accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, encKey) : '';
      secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, encKey) : '';
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-backup-restore: S3 credential decryption failed');
      throw new ApiError('CONFIG_INVALID', 'S3 credential decryption failed (encryption key may have rotated)', 500);
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
      throw new ApiError('CONFIG_INVALID', 'SSH backup target missing required fields', 400);
    }
    let privateKey: string;
    try {
      privateKey = decrypt(cfg.sshKeyEncrypted, encKey);
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-backup-restore: SSH private-key decryption failed');
      throw new ApiError('CONFIG_INVALID', 'SSH key decryption failed (encryption key may have rotated)', 500);
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

export async function readConfigDump(app: FastifyInstance, bundleId: string): Promise<{ tables: Record<string, unknown[]> }> {
  const store = await resolveStoreForBundle(app, bundleId);
  const handle = await store.open(bundleId);
  if (!handle) throw new ApiError('NOT_FOUND', 'Bundle artefacts not found on remote target', 404);
  const stream = await store.readComponent(handle, 'config', 'db-rows.json.gz');
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  const buf = gunzipSync(Buffer.concat(chunks));
  const dump = JSON.parse(buf.toString('utf8')) as { tables?: Record<string, unknown[]> };
  return { tables: dump.tables ?? {} };
}

/**
 * Dispatch one item to its type-specific executor.
 *
 * `tenantPolicy` — when set (tenant-cart path), executors that can
 * mutate operator-only fields (currently just `config-tables`) apply
 * per-row column redaction before upsert. Admin path passes
 * `undefined` so admin restores remain unmodified.
 */
export async function dispatchExecutor(
  app: FastifyInstance,
  item: RestoreItem,
  store: BackupStore,
  tenantPolicy?: TenantRestorePolicy,
): Promise<void> {
  switch (item.type) {
    case 'config-tables':
      await execConfigTablesItem({ app, item, store, tenantPolicy });
      return;
    case 'deployments-by-id':
      await execDeploymentsByIdItem({ app, item, store });
      return;
    case 'domains-by-id':
      await execDomainsByIdItem({ app, item, store });
      return;
    case 'files-paths':
      await execFilesPathsItem({ app, item, store });
      return;
    case 'mailboxes-by-address':
      await execMailboxesByAddressItem({ app, item, store });
      return;
    default: {
      const err = new Error(`Unknown restore item type '${item.type}'`);
      (err as Error & { code?: string }).code = 'UNKNOWN_TYPE';
      throw err;
    }
  }
}
