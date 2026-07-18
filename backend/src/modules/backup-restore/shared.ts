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
} from '@insula/api-contracts';
import { decrypt } from '../oidc/crypto.js';
import { S3BackupStore } from '../tenant-bundles/s3-backup-store.js';
import { SshBackupStore } from '../tenant-bundles/ssh-backup-store.js';
import { RcloneBackupStore } from '../tenant-bundles/rclone-backup-store.js';
import {
  renderUpstreamSection,
  upstreamRootPath,
  type BackupTargetConfig,
} from '../backup-rclone-shim/rclone-config.js';
import type { BackupStore } from '../tenant-bundles/bundle-store.js';
import { resolveShimFirstBackupStore } from '../tenant-bundles/shim-backup-store.js';
import { execConfigTablesItem } from './executors/config-tables.js';
import { execDatabasesByIdItem } from './executors/databases-by-id.js';
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

export async function resolveDirectStoreForBundle(
  app: FastifyInstance,
  targetConfigId: string,
  opts: { readonly classSubpath?: string } = {},
): Promise<BackupStore> {
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) throw new ApiError('NOT_FOUND', 'Backup target not found', 404);
  // The shim writes each backup class under a `<prefix>/<class>/<bundleId>`
  // segment; a DIRECT store (this fallback / the migration source, R20) must add
  // the same segment or it scans/opens the wrong path. Callers reading tenant
  // bundles via the direct path pass classSubpath='tenant'.
  const classSub = (opts.classSubpath ?? '').replace(/^\/+|\/+$/g, '');
  const withClass = (base: string | null | undefined): string | undefined => {
    const b = (base ?? '').replace(/\/+$/, '');
    const joined = [b, classSub].filter((s) => s.length > 0).join('/');
    return joined.length > 0 ? joined : undefined;
  };
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
      pathPrefix: withClass(cfg.s3Prefix),
    });
  }
  if (cfg.storageType === 'ssh') {
    // SSH targets authenticate by private KEY or PASSWORD (the DB enforces at
    // least one) — e.g. Hetzner storageboxes use a password. Direct reads
    // (migration source, DR) must honour BOTH, mirroring the backup-rclone-shim
    // write path; requiring the key alone rejected valid password targets with
    // "missing required fields".
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshPath || (!cfg.sshKeyEncrypted && !cfg.sshPasswordEncrypted)) {
      throw new ApiError('CONFIG_INVALID', 'SSH backup target missing required fields (host, user, path, and a key or password)', 400);
    }
    let privateKey: string | undefined;
    let password: string | undefined;
    try {
      if (cfg.sshKeyEncrypted) privateKey = decrypt(cfg.sshKeyEncrypted, encKey);
      if (cfg.sshPasswordEncrypted) password = decrypt(cfg.sshPasswordEncrypted, encKey);
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-backup-restore: SSH credential decryption failed');
      throw new ApiError('CONFIG_INVALID', 'SSH credential decryption failed (encryption key may have rotated)', 500);
    }
    // The shim writes tenant bundles HOME-RELATIVE on the SFTP target
    // (rclone-config's upstreamRootPath → stripSlashes drops the LEADING slash;
    // storagebox SFTP is chrooted to $HOME). `withClass` keeps the leading slash,
    // so a direct read would hit an absolute path the shim never wrote to and
    // find 0 bundles. Strip both slashes here to match the shim's write path.
    const sshBase = [cfg.sshPath.replace(/^\/+|\/+$/g, ''), classSub].filter((s) => s.length > 0).join('/');
    return new SshBackupStore({
      host: cfg.sshHost,
      port: cfg.sshPort ?? 22,
      user: cfg.sshUser,
      privateKey,
      password,
      basePath: sshBase || cfg.sshPath,
      logFn: (level, ctx, msg) => app.log[level](ctx, msg),
    });
  }
  if (cfg.storageType === 'cifs') {
    // CIFS/SMB has no native BackupStore (Node has no SMB client) — read it
    // via the rclone CLI, reusing the shim's own target-agnostic section
    // renderer so obscured-password + SMB semantics match the write path
    // exactly. This is what lets a CIFS source be a valid migration/DR source.
    if (!cfg.cifsHost || !cfg.cifsShare || !cfg.cifsUser || !cfg.cifsPasswordEncrypted) {
      throw new ApiError('CONFIG_INVALID', 'CIFS backup target missing required fields (host, share, user, password)', 400);
    }
    let cifsPassword: string;
    try {
      cifsPassword = decrypt(cfg.cifsPasswordEncrypted, encKey);
    } catch (err) {
      app.log.error({ err, configId: cfg.id }, 'tenant-backup-restore: CIFS password decryption failed');
      throw new ApiError('CONFIG_INVALID', 'CIFS credential decryption failed (encryption key may have rotated)', 500);
    }
    const target: BackupTargetConfig = {
      id: cfg.id,
      name: cfg.name ?? cfg.id,
      storageType: 'cifs',
      cifsHost: cfg.cifsHost,
      cifsPort: cfg.cifsPort ?? null,
      cifsShare: cfg.cifsShare,
      cifsUser: cfg.cifsUser,
      cifsPassword,
      cifsDomain: cfg.cifsDomain ?? null,
      cifsPath: cfg.cifsPath ?? null,
    };
    const REMOTE = 'src';
    const rendered = renderUpstreamSection(REMOTE, target);
    // basePath = the target's root (share[/path]) + the class subpath, matching
    // the shim's combined alias `root/<class>` and the direct stores' withClass.
    const basePath = [upstreamRootPath(target), classSub].filter((s) => s.length > 0).join('/');
    return new RcloneBackupStore({
      rcloneEnv: rcloneEnvFromSection(REMOTE, rendered.conf),
      remoteName: REMOTE,
      basePath,
      logFn: (level, ctx, msg) => app.log[level](ctx, msg),
    });
  }
  throw new ApiError('NOT_IMPLEMENTED', `Store kind '${cfg.storageType}' not supported`, 501);
}

/**
 * Turn a shim-rendered rclone.conf `[section]` block into
 * `RCLONE_CONFIG_<REMOTE>_<KEY>` env vars so rclone reads the remote's config
 * from the environment (no secret written to disk). The rendered section is
 * `[name]\n key = value\n …` (SMB/SFTP passwords already `rclone obscure`d).
 */
function rcloneEnvFromSection(remoteName: string, conf: string): Record<string, string> {
  const env: Record<string, string> = {};
  const prefix = `RCLONE_CONFIG_${remoteName.toUpperCase()}_`;
  for (const line of conf.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[`${prefix}${m[1].toUpperCase()}`] = m[2];
  }
  return env;
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
    case 'databases-by-id':
      await execDatabasesByIdItem({ app, item, store });
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
