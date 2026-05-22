/**
 * Resolve a `backup_configurations` row into the concrete `BackupTarget`
 * shape that `restic-driver.ts` expects.
 *
 * This is a thin DB→struct converter that:
 *   - decrypts the credential blobs (S3 access key, S3 secret key, SSH
 *     private key) using the platform's PLATFORM_ENCRYPTION_KEY envelope
 *   - validates required fields are present per backend kind
 *   - returns a typed discriminated union that the restic driver can
 *     consume directly (no further coercion needed)
 *
 * Pulled out of internal-upload-route.ts so it can be unit-tested
 * without spinning up Fastify or registering a kube tenant.
 */

import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import { decrypt } from '../oidc/crypto.js';
import { ApiError } from '../../shared/errors.js';
import {
  loadBackupTargetKey,
  SHIM_NAMESPACE,
} from '../backup-rclone-shim/service.js';
import {
  deriveShimAccessKey,
  deriveShimSecretKey,
} from '../backup-rclone-shim/crypto.js';
import { SHIM_S3_ENDPOINT_URL } from '../backup-rclone-shim/mail-restic.js';
import type { BackupTarget } from './restic-driver.js';

/**
 * Subset of `backup_configurations` columns we need to resolve a target.
 * Caller does the SELECT; we accept the row verbatim.
 */
export interface BackupConfigurationRow {
  readonly id: string;
  readonly storageType: string;
  readonly s3Endpoint: string | null;
  readonly s3Bucket: string | null;
  readonly s3Region: string | null;
  readonly s3Prefix: string | null;
  readonly s3AccessKeyEncrypted: string | null;
  readonly s3SecretKeyEncrypted: string | null;
  readonly sshHost: string | null;
  readonly sshPort: number | null;
  readonly sshUser: string | null;
  readonly sshKeyEncrypted: string | null;
  readonly sshPath: string | null;
  readonly hostpathPath?: string | null;
}

/** Pluggable decrypt for tests — defaults to the production envelope. */
export type DecryptFn = (ciphertext: string, keyHex: string) => string;

export interface ResolveOpts {
  readonly secretsKeyHex: string;
  readonly decryptFn?: DecryptFn;
}

export function resolveBackupTarget(
  cfg: BackupConfigurationRow,
  opts: ResolveOpts,
): BackupTarget {
  const dec = opts.decryptFn ?? decrypt;

  if (cfg.storageType === 's3') {
    if (!cfg.s3Endpoint || !cfg.s3Bucket) {
      throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.id} missing S3 endpoint/bucket`, 400);
    }
    if (!cfg.s3AccessKeyEncrypted || !cfg.s3SecretKeyEncrypted) {
      throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.id} has no S3 credentials configured`, 400);
    }
    let accessKey: string;
    let secretKey: string;
    try {
      accessKey = dec(cfg.s3AccessKeyEncrypted, opts.secretsKeyHex);
      secretKey = dec(cfg.s3SecretKeyEncrypted, opts.secretsKeyHex);
    } catch {
      throw new ApiError('CONFIG_INVALID', 'S3 credential decryption failed', 500);
    }
    return {
      kind: 's3',
      s3Endpoint: cfg.s3Endpoint,
      s3Bucket: cfg.s3Bucket,
      s3Region: cfg.s3Region ?? undefined,
      s3Prefix: cfg.s3Prefix ?? undefined,
      s3AccessKey: accessKey,
      s3SecretKey: secretKey,
    };
  }

  if (cfg.storageType === 'ssh') {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyEncrypted || !cfg.sshPath) {
      throw new ApiError(
        'CONFIG_INVALID',
        `Backup target ${cfg.id} missing SSH host/user/key/path`,
        400,
      );
    }
    let privateKey: string;
    try {
      privateKey = dec(cfg.sshKeyEncrypted, opts.secretsKeyHex);
    } catch {
      throw new ApiError('CONFIG_INVALID', 'SSH key decryption failed', 500);
    }
    return {
      kind: 'ssh',
      sshHost: cfg.sshHost,
      sshPort: cfg.sshPort ?? 22,
      sshUser: cfg.sshUser,
      sshKey: privateKey,
      sshPath: cfg.sshPath,
    };
  }

  if (cfg.storageType === 'hostpath') {
    if (!cfg.hostpathPath) {
      throw new ApiError('CONFIG_INVALID', `Backup target ${cfg.id} missing hostpath path`, 400);
    }
    return { kind: 'hostpath', hostPath: cfg.hostpathPath };
  }

  throw new ApiError(
    'NOT_IMPLEMENTED',
    `Backup store kind '${cfg.storageType}' is not supported by restic driver`,
    501,
  );
}

// ─── B9: shim-backed target resolver ────────────────────────────────────────

/**
 * Resolve a "write through the R-X shim" target. Used by ALL new bundle
 * writes regardless of the upstream backup_configurations.storage_type —
 * because the shim universally handles S3/SFTP/CIFS/NFS, and the live
 * staging bench (2026-05-22) showed the shim path is ~35% faster than
 * restic native S3 for the same Hetzner Object Storage upstream.
 *
 * The function reads the BACKUP_TARGET_KEY Secret from the in-cluster
 * `platform` namespace, derives the HKDF root credentials the shim
 * authenticates clients with, and emits a `kind: 'shim'` BackupTarget
 * pointed at the shim's local S3 endpoint.
 *
 * `shimClass` is the bound class on the shim — always `'tenant'` for
 * tenant bundles. Callers MUST ensure the shim has a binding for this
 * class before invoking restic (otherwise the shim returns NoSuchBucket).
 */
export async function resolveShimBackupTarget(
  core: k8s.CoreV1Api,
  shimClass: 'system' | 'tenant' | 'mail',
  log?: Pick<Logger, 'warn'>,
): Promise<Extract<BackupTarget, { kind: 'shim' }>> {
  const ki = await loadBackupTargetKey(core, SHIM_NAMESPACE, {
    log: log ?? { warn: () => {} },
  });
  return {
    kind: 'shim',
    endpoint: SHIM_S3_ENDPOINT_URL,
    bucket: shimClass,
    accessKey: deriveShimAccessKey(ki.rawKey),
    secretKey: deriveShimSecretKey(ki.rawKey),
  };
}
