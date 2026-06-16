/**
 * DR break-glass descriptor: `dr-system-target.json`.
 *
 * Carried inside the age-encrypted secrets bundle (alongside dr-inputs /
 * dr-rows) so an operator can restore etcd off-site on a FRESH NODE with
 * no live cluster. The off-site etcd restore (`restore-etcd-from-shim.sh
 * --offline`) normally has a chicken-and-egg: it reads the shim ClusterIP
 * + creds via kubectl, but in an etcd disaster the kube-API is down. This
 * descriptor breaks that loop by recording the **already-decrypted**
 * upstream backup target for the `system` class + the fully-resolved key
 * prefix where this cluster's etcd snapshots live — so the restore talks
 * DIRECTLY to the real upstream (S3/SFTP/SMB), bypassing the shim AND
 * kubectl entirely.
 *
 * SECURITY: this file holds the real upstream credentials in cleartext —
 * it exists ONLY inside the age-encrypted tar (same blast radius as the
 * keys already in that bundle; the etcd snapshot it unlocks is the whole
 * cluster's state). Never write it to disk unencrypted; never log it.
 *
 * Emitted only when a `system` class target is bound (else null → the
 * exporter omits the file and the offline restore tells the operator to
 * bind a target + re-export, or pass the target on the CLI).
 */

import { z } from 'zod';
import { loadShimAssignments } from '../backup-rclone-shim/service.js';
import type { BackupTargetConfig } from '../backup-rclone-shim/rclone-config.js';
import { getClusterId } from '../system-settings/cluster-id.js';
import type { Database } from '../../db/index.js';

export const drSystemTargetSchema = z.object({
  version: z.literal(1),
  /** Stable per-cluster id; the etcd snapshot path is namespaced by it. */
  clusterId: z.string().min(1),
  storageType: z.enum(['s3', 'ssh', 'cifs']),
  // S3 (the first-class / proven offline path)
  s3Endpoint: z.string().optional(),
  s3Region: z.string().optional(),
  /** The upstream bucket — the rclone S3 "container"; the key lives at
   *  `<s3Bucket>/<etcdKeyPrefix>/`. */
  s3Bucket: z.string().optional(),
  s3AccessKey: z.string().optional(),
  s3SecretKey: z.string().optional(),
  s3UsePathStyle: z.boolean().optional(),
  // SFTP (storage_type='ssh')
  sshHost: z.string().optional(),
  sshPort: z.number().optional(),
  sshUser: z.string().optional(),
  sshKey: z.string().optional(),
  sshPassword: z.string().optional(),
  // CIFS/SMB — the share is the rclone container
  cifsHost: z.string().optional(),
  cifsPort: z.number().optional(),
  cifsShare: z.string().optional(),
  cifsUser: z.string().optional(),
  cifsPassword: z.string().optional(),
  cifsDomain: z.string().optional(),
  /**
   * The fully-resolved key prefix (UNDER the bucket/share/home) where this
   * cluster's etcd snapshots are uploaded by the etcd-snap-via-shim
   * CronJob, e.g. `<s3Prefix>/system/etcd/<clusterId>`. The offline
   * restore lists/copies from here directly — no shim path re-derivation.
   * Invariant (S3): `s3Bucket + '/' + etcdKeyPrefix` ===
   * `upstreamRootPath(target) + '/system/etcd/' + clusterId`.
   */
  etcdKeyPrefix: z.string().min(1),
  generatedAt: z.string(),
});

export type DrSystemTarget = z.infer<typeof drSystemTargetSchema>;

/** Strip leading/trailing slashes — mirrors rclone-config's path joiner. */
function stripSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

/** The operator-set prefix portion UNDER the upstream container (bucket /
 *  share / SFTP home), before the platform appends `system/etcd/<id>`. */
function operatorPrefixFor(t: BackupTargetConfig): string {
  switch (t.storageType) {
    case 's3':
      return t.s3Prefix ? stripSlashes(t.s3Prefix) : '';
    case 'ssh':
      return t.sshPath ? stripSlashes(t.sshPath) : '';
    case 'cifs':
      return t.cifsPath ? stripSlashes(t.cifsPath) : '';
  }
}

/**
 * Build the descriptor for the bound `system` class. Returns null when no
 * system target is bound (the exporter then omits the file). `encryptionKey`
 * is PLATFORM_ENCRYPTION_KEY (loadShimAssignments decrypts upstream creds).
 */
export async function buildDrSystemTargetDescriptor(
  db: Database,
  encryptionKey: string,
  clusterIdOverride?: string,
): Promise<DrSystemTarget | null> {
  const { assignments } = await loadShimAssignments(db, encryptionKey);
  const system = assignments.find((a) => a.className === 'system');
  if (!system) return null;

  const clusterId = clusterIdOverride ?? (await getClusterId(db));
  const t = system.target;
  const etcdKeyPrefix = [operatorPrefixFor(t), 'system', 'etcd', clusterId]
    .filter((s) => s.length > 0)
    .join('/');

  const common = {
    version: 1 as const,
    clusterId,
    storageType: t.storageType,
    etcdKeyPrefix,
    generatedAt: new Date().toISOString(),
  };

  let descriptor: DrSystemTarget;
  switch (t.storageType) {
    case 's3':
      descriptor = {
        ...common,
        s3Endpoint: t.s3Endpoint ?? undefined,
        s3Region: t.s3Region ?? undefined,
        s3Bucket: t.s3Bucket ?? undefined,
        s3AccessKey: t.s3AccessKey ?? undefined,
        s3SecretKey: t.s3SecretKey ?? undefined,
        // Null/undefined legacy rows default to path-style (matches the shim).
        s3UsePathStyle: t.s3UsePathStyle === false ? false : true,
      };
      break;
    case 'ssh':
      descriptor = {
        ...common,
        sshHost: t.sshHost ?? undefined,
        sshPort: t.sshPort ?? undefined,
        sshUser: t.sshUser ?? undefined,
        sshKey: t.sshKey ?? undefined,
        sshPassword: t.sshPassword ?? undefined,
      };
      break;
    case 'cifs':
      descriptor = {
        ...common,
        cifsHost: t.cifsHost ?? undefined,
        cifsPort: t.cifsPort ?? undefined,
        cifsShare: t.cifsShare ?? undefined,
        cifsUser: t.cifsUser ?? undefined,
        cifsPassword: t.cifsPassword ?? undefined,
        cifsDomain: t.cifsDomain ?? undefined,
      };
      break;
  }
  // Validate before emit — defence-in-depth, same as the dr-* sidecars.
  return drSystemTargetSchema.parse(descriptor);
}

/** Pretty JSON for the bundle entry. */
export function serializeDrSystemTarget(d: DrSystemTarget): Buffer {
  return Buffer.from(JSON.stringify(d, null, 2) + '\n', 'utf8');
}
