/**
 * Shim-backed BackupStore factory.
 *
 * B9 (2026-05-22): tenant bundle writes go through the R-X20 backup-
 * rclone-shim's local S3 endpoint, regardless of the upstream protocol
 * (S3/SFTP/CIFS/NFS). The shim handles transport; this module just
 * configures an S3BackupStore with the shim's ClusterIP + HKDF-derived
 * ROOT credentials and a bucket name = the shim class.
 *
 * Why a separate helper instead of inlining the S3BackupStore
 * construction at each call site: the credential loading is async
 * (reads the BACKUP_TARGET_KEY Secret from k8s), and four different
 * sites need the same construction (POST /admin/tenant-bundles,
 * orchestrator inline verify, internal-upload, internal-download).
 */

import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';
import {
  loadBackupTargetKey,
  SHIM_NAMESPACE,
} from '../backup-rclone-shim/service.js';
import {
  deriveShimAccessKey,
  deriveShimSecretKey,
} from '../backup-rclone-shim/crypto.js';
import { SHIM_S3_ENDPOINT_URL } from '../backup-rclone-shim/mail-restic.js';
import { S3BackupStore } from './s3-backup-store.js';

export interface ResolveShimStoreOptions {
  /** Logger for credential-loading diagnostics. Optional. */
  readonly log?: Pick<Logger, 'warn'>;
}

/**
 * Build an S3BackupStore configured to hit the shim's local S3
 * endpoint. The shim's `tenant` class (or `system` / `mail`) is the
 * bucket name; the shim's `combined:` remote routes each class to
 * whatever upstream the operator has bound.
 *
 * Throws if the BACKUP_TARGET_KEY Secret is missing — callers should
 * surface that as a clear "shim not bootstrapped" operator error.
 */
export async function resolveShimBackupStore(
  core: k8s.CoreV1Api,
  shimClass: 'system' | 'tenant' | 'mail',
  opts: ResolveShimStoreOptions = {},
): Promise<S3BackupStore> {
  const log = opts.log ?? { warn: () => {} };
  const ki = await loadBackupTargetKey(core, SHIM_NAMESPACE, { log });
  const accessKey = deriveShimAccessKey(ki.rawKey);
  const secretKey = deriveShimSecretKey(ki.rawKey);
  return new S3BackupStore({
    endpoint: SHIM_S3_ENDPOINT_URL,
    bucket: shimClass,
    region: 'us-east-1', // shim ignores; required by AWS SDK
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    // The shim is a path-style S3 endpoint (rclone serve s3 default).
    // S3BackupStore forces path-style automatically when endpoint is set.
  });
}
