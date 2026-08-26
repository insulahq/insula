/**
 * Backup-target Secret shape + input types.
 *
 * Extracted from longhorn-reconciler.ts when the legacy target-activate
 * path was retired (2026-08-26). Two surviving consumers:
 *
 *   - backup-rclone-shim/dr-cronjobs.ts — writes `backup-credentials`
 *     pointing at the shim's S3 endpoint for the bridged DR CronJobs.
 *   - backup-config/service.ts getActiveBackupConfig — legacy read-only
 *     fallback for the snapshot store (dies with the `active` column).
 *
 * The key lists are enumerated so a writer switching target kinds
 * leaves no stale fields behind on a Secret `replace`.
 */

import type * as k8s from '@kubernetes/client-node';

export const S3_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ENDPOINTS',
  'VIRTUAL_HOSTED_STYLE',
  'S3_BUCKET',
  'S3_REGION',
  'S3_PATH_PREFIX',
  // "true" → the DR job scripts force aws-cli path-style addressing.
  // Required for the backup-rclone-shim endpoint (no wildcard DNS for
  // virtual-hosted bucket names); empty for real S3 providers.
  'S3_FORCE_PATH_STYLE',
] as const;

export const SSH_KEYS = [
  'SSH_HOST',
  'SSH_PORT',
  'SSH_USER',
  'SSH_PATH',
  'SSH_PRIVATE_KEY',
] as const;

export interface S3BackupTargetInput {
  readonly kind: 's3';
  readonly endpoint: string;       // e.g. https://s3.eu-central.example.test
  readonly region: string;          // e.g. eu-central
  readonly bucket: string;          // e.g. platform-backups
  readonly accessKeyId: string;     // plaintext, handed to K8s Secret
  readonly secretAccessKey: string; // plaintext, handed to K8s Secret
  readonly pathPrefix?: string;     // optional, e.g. "longhorn-staging"
  /** Force aws-cli path-style addressing (shim endpoint). */
  readonly forcePathStyle?: boolean;
}

export interface SshBackupTargetInput {
  readonly kind: 'ssh';
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly path: string;
  // EITHER privateKey OR password is set (not both null).
  readonly privateKey?: string;     // plaintext PEM body, handed to K8s Secret
  readonly password?: string;       // plaintext password, handed to K8s Secret
}

export type LonghornBackupTargetInput = S3BackupTargetInput | SshBackupTargetInput;

/** K8s client set the backup-config routes need (name kept from the
 *  Longhorn era to avoid churning every call site). */
export interface LonghornTenants {
  readonly core: k8s.CoreV1Api;
  readonly custom: k8s.CustomObjectsApi;
  readonly batch?: k8s.BatchV1Api;
}

// Build the Secret data block for an S3 target. Explicit empty strings
// for SSH_* so switching SSH→S3 drops stale SSH keys on `replace`.
export function buildS3SecretData(input: S3BackupTargetInput): Record<string, string> {
  const data: Record<string, string> = {
    TARGET_KIND: 's3',
    AWS_ACCESS_KEY_ID: input.accessKeyId,
    AWS_SECRET_ACCESS_KEY: input.secretAccessKey,
    AWS_ENDPOINTS: input.endpoint,
    VIRTUAL_HOSTED_STYLE: '',
    S3_BUCKET: input.bucket,
    S3_REGION: input.region,
    S3_PATH_PREFIX: input.pathPrefix ?? '',
    S3_FORCE_PATH_STYLE: input.forcePathStyle ? 'true' : '',
  };
  for (const k of SSH_KEYS) data[k] = '';
  return data;
}
