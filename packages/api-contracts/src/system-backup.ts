import { z } from 'zod';

// System Backup, Phase 1: secrets-bundle export.
//
// Scope: cluster-state recovery artifacts (secrets, system DBs,
// Stalwart BLOB, longhorn snapshots — NOT customer/tenant data).
// Tenant data is owned by Tenant Backup (tenant-bundles).
//
// Phase 1 ships only the secrets-bundle subsystem.

export const systemBackupKindSchema = z.enum(['secrets', 'pg_dump']);
export type SystemBackupKind = z.infer<typeof systemBackupKindSchema>;

export const systemBackupRunStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed']);
export type SystemBackupRunStatus = z.infer<typeof systemBackupRunStatusSchema>;

// One row in `system_backup_runs`. The `payload` column on the
// server-side row is never returned over the wire — the API surfaces
// a single-use download URL when status='succeeded' and downloaded_at
// is null. Once downloaded, the download fields go null and the
// payload bytes are wiped (audit metadata stays).
export const systemBackupRunSchema = z.object({
  id: z.string().uuid(),
  kind: systemBackupKindSchema,
  status: systemBackupRunStatusSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  sizeBytes: z.number().int().nullable(),
  sha256: z.string().length(64).nullable(),
  errorEnvelope: z.unknown().nullable(),
  operatorUserId: z.string().nullable(),
  operatorIp: z.string().nullable(),
  operatorUserAgent: z.string().nullable(),
  // Inventory the operator can show without re-decrypting the bundle.
  manifest: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    kind: z.enum(['Secret', 'ConfigMap', 'OperatorKey']),
  })).nullable(),
  // Single-use download. Present only when status='succeeded' AND
  // downloaded_at IS NULL AND now() < downloadUrlExpiresAt.
  downloadUrl: z.string().nullable(),
  downloadUrlExpiresAt: z.string().datetime().nullable(),
  downloadedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  // Phase 2 — pg_dump source identity (NULL for kind='secrets').
  sourceNamespace: z.string().nullable(),
  sourceCluster: z.string().nullable(),
  sourceDatabase: z.string().nullable(),
  targetConfigId: z.string().nullable(),
  bundleId: z.string().nullable(),
  artifactName: z.string().nullable(),
  jobName: z.string().nullable(),
});
export type SystemBackupRun = z.infer<typeof systemBackupRunSchema>;

// RFC 1123 DNS label: lowercase alnum with hyphens, 1-63 chars, no
// leading/trailing hyphen. Used for k8s namespace + CNPG cluster name.
const dnsLabelSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'must be a lowercase DNS label (a-z, 0-9, hyphens)');

// Postgres unquoted identifier: letter or underscore, then alnum or
// underscore. Avoids needing to escape the value when it appears as a
// `-d <db>` argument to pg_dump. Examples: platform, app, mail.
const pgIdentifierSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'must be an unquoted Postgres identifier (a-z, A-Z, 0-9, underscore; cannot start with a digit)',
  );

export const pgDumpRequestSchema = z.object({
  sourceNamespace: dnsLabelSchema,
  sourceCluster: dnsLabelSchema,
  sourceDatabase: pgIdentifierSchema,
  targetConfigId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});
export type PgDumpRequest = z.infer<typeof pgDumpRequestSchema>;

// Query params for GET /pg-dump/runs.
export const pgDumpListQuerySchema = z.object({
  namespace: dnsLabelSchema.optional(),
  cluster: dnsLabelSchema.optional(),
  limit: z.string().regex(/^\d+$/, 'must be a positive integer').optional(),
});
export type PgDumpListQuery = z.infer<typeof pgDumpListQuerySchema>;

// Phase 4b pg_dump schedule contracts removed 2026-05-24 together with
// the scheduler. pg_dump is now super_admin-only on-demand.

export const pgDumpResponseSchema = z.object({
  runId: z.string().uuid(),
  status: systemBackupRunStatusSchema,
  jobName: z.string(),
  pollUrl: z.string(),
});
export type PgDumpResponse = z.infer<typeof pgDumpResponseSchema>;

// POST /api/v1/system-backup/secrets/export — kicks off a fresh export.
// Returns 202 + the run id. Client polls GET /runs/:id until terminal.
export const exportSecretsBundleRequestSchema = z.object({
  // Optional reason for the audit log. Free-form, ≤500 chars.
  reason: z.string().max(500).optional(),
});
export type ExportSecretsBundleRequest = z.infer<typeof exportSecretsBundleRequestSchema>;

export const exportSecretsBundleResponseSchema = z.object({
  runId: z.string().uuid(),
  status: systemBackupRunStatusSchema,
  pollUrl: z.string(),
});
export type ExportSecretsBundleResponse = z.infer<typeof exportSecretsBundleResponseSchema>;

// GET /api/v1/system-backup/secrets/runs — list (server wraps in {data:[...]}).
export const listSecretsBundleRunsResponseSchema = z.array(systemBackupRunSchema);
export type ListSecretsBundleRunsResponse = z.infer<typeof listSecretsBundleRunsResponseSchema>;

// GET /api/v1/system-backup/secrets/manifest — read-only inventory of
// what *would* be included in the next bundle. No secret values
// returned, only namespace/name pairs.
export const secretsBundleManifestResponseSchema = z.object({
  items: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    kind: z.enum(['Secret', 'ConfigMap', 'OperatorKey']),
    present: z.boolean(),
  })),
  operatorRecipient: z.string().nullable(),
});
export type SecretsBundleManifestResponse = z.infer<typeof secretsBundleManifestResponseSchema>;

// POST /api/v1/system-backup/secrets/import-dryrun — multipart upload
// of an age-encrypted bundle + the operator private key, returns a
// diff between the bundle's contents and the live cluster state. Used
// by operators to verify a bundle decrypts cleanly + matches the
// expected secret list before re-bootstrapping. NEVER mutates state.
export const importDryrunResponseSchema = z.object({
  bundleManifest: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    kind: z.enum(['Secret', 'ConfigMap', 'OperatorKey']),
    sha256: z.string().length(64),
  })),
  diff: z.array(z.object({
    namespace: z.string(),
    name: z.string(),
    kind: z.enum(['Secret', 'ConfigMap', 'OperatorKey']),
    change: z.enum(['create', 'update', 'identical', 'remove']),
    detail: z.string().nullable(),
  })),
  decryptOk: z.boolean(),
  bundleCreatedAt: z.string().datetime().nullable(),
});
export type ImportDryrunResponse = z.infer<typeof importDryrunResponseSchema>;

// ─── DR bundle sidecars (A2) ────────────────────────────────────────
//
// Every secrets-bundle export now carries two extra files inside the
// age-encrypted tar:
//   - dr-inputs.yaml — bootstrap inputs + CNPG recovery pointers needed
//     BEFORE system-db exists. Read by Unit B's dr-restore importer.
//   - dr-rows.json   — JSON dump of backup_configurations +
//     backup_target_assignments rows. Encrypted credential columns
//     pass through as-is (PLATFORM_ENCRYPTION_KEY from the Secrets
//     bundle decrypts them post-restore). Every config row in this
//     dump carries readOnly:true so Unit B's importer inserts the
//     freshly restored cluster into "DR freeze" mode.
//
// Schema-versioned. Bumps are explicit in PRs; readers refuse unknown
// versions with `BundleVersionError`. Adding fields to v1 is
// backwards-incompatible-for-the-reader only if a field is required;
// optional additive fields don't require a bump.
//
// Lives in api-contracts (not backend-internal) so the future
// platform-ops CLI can consume the schemas without a backend import.

export const DR_BUNDLE_VERSION = 1;

/**
 * dr-inputs.yaml — non-Secret bootstrap inputs and CNPG recovery
 * pointers. Per the locked PARTIAL-mode design, this carries only
 * what's needed BEFORE the DB exists. workload_repos, dns_providers,
 * platform_settings are NOT in this file by design (operator
 * reconfigures via UI / fresh defaults activate automatically).
 */
export const drBundleVersionSchema = z.literal(DR_BUNDLE_VERSION);

/** DNS-label regex matching CNPG's webhook + barman-cloud serverName
 *  conventions. Mirrors `NAME_RE` in
 *  backend/src/modules/postgres-barman-restore/service.ts so the bundle
 *  cannot smuggle path-traversal sequences, special characters, or
 *  uppercase chars into the K8s API or the S3 bucket path. The 50-char
 *  cap matches CNPG's cluster-name webhook limit; cluster recovery
 *  appends `-dr-<13-digit-ts>` so the practical input cap is ~36 chars,
 *  but we enforce 50 here to match CNPG and use a tighter cap at the
 *  consumer site (security review SEC#1 + TS review HIGH#3). */
const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const drDnsLabel = (max = 50) =>
  z.string().min(1).max(max).regex(DNS_LABEL_RE, 'must be a DNS-label-compatible name (lowercase alphanumeric + hyphens/dots)');

export const cnpgRecoveryPointerSchema = z.object({
  /** Namespace of the CNPG Cluster CR (e.g. `platform`). */
  namespace: drDnsLabel(),
  /** Cluster CR name (e.g. `system-db`). 36-char cap leaves room for
   *  the `-dr-<13-digit-ts>` suffix the recovery orchestrator appends
   *  while staying under CNPG's 50-char limit. */
  clusterName: drDnsLabel(36),
  /** `externalClusters[0].plugin.parameters.serverName` from the
   *  source cluster. CRITICAL: must match the source's value for
   *  barman bootstrap.recovery to find the WAL archive. Fix from
   *  commit 97bb0ab5 in memory project_restore_wiring_phases.
   *  DNS-label-validated so a crafted bundle can't smuggle
   *  path-traversal sequences into the S3 bucket path
   *  (security review HIGH#1). */
  serverName: drDnsLabel(),
  /** `spec.plugins[barman-cloud].parameters.barmanObjectName` from the
   *  source cluster. Points at the ObjectStore CR (which the shim
   *  reconciler materializes from `backup_configurations`).
   *  DNS-label-validated for the same reason as serverName. */
  objectStoreName: drDnsLabel(),
});
export type CnpgRecoveryPointer = z.infer<typeof cnpgRecoveryPointerSchema>;

export const drInputsSchema = z.object({
  drBundleVersion: drBundleVersionSchema,
  /** ISO-8601 timestamp the bundle was built. */
  createdAt: z.string().datetime(),
  /** Apex domain operator used at bootstrap (e.g. `example.test`).
   *  Restore-side operator must re-bootstrap on the same apex. */
  apexDomain: z.string().min(1),
  /** Cluster name the operator chose at bootstrap (e.g. `prod-1`). */
  clusterName: z.string().min(1),
  /** Mesh CIDR for the cluster's pod network (e.g. `10.42.0.0/16`).
   *  Informational on the restore path — the restored cluster's CIDR
   *  is decided by bootstrap.sh flags, not by this value. Surfaced so
   *  the operator can spot a mismatch in the pre-flight UI. */
  meshCidr: z.string().min(1),
  /** Pinned platform image tag (e.g. `0.1.0-abc1234`). Unit B will
   *  refuse to restore a bundle whose pin doesn't match the cluster's
   *  current image tag unless --accept-version-skew is set. */
  platformVersion: z.string().min(1),
  /** Per-cluster CNPG recovery pointers. Today there's only one
   *  (system-db); mail-db was dropped 2026-05-12 (RocksDB on PVC). */
  cnpgClusters: z.array(cnpgRecoveryPointerSchema),
  /** `haproxy` (the locked production HA path) or `hostport`. Bundle
   *  carries source value; Unit B warns on mismatch with the restored
   *  cluster's current mode. */
  mailPortMode: z.enum(['haproxy', 'hostport']),
  /** Source cluster topology — `single` (1 node, CNPG instances=1) or
   *  `ha` (≥3 control-plane, CNPG instances=3). Warn-only at restore;
   *  downsize/upsize is acceptable but worth flagging. */
  bundleTopology: z.enum(['single', 'ha']),
});
export type DrInputs = z.infer<typeof drInputsSchema>;

/**
 * dr-rows.json — JSON dump of the two tables that the dr-restore
 * importer in Unit B INSERTs into the freshly bootstrapped system-db.
 *
 * Per the locked PARTIAL-mode design, ONLY these two tables travel:
 * platform_settings, workload_repos, dns_providers do NOT.
 */
export const backupConfigurationRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  storageType: z.enum(['ssh', 's3', 'cifs']),
  // All credential columns travel encrypted-at-rest. We keep them as
  // base64-or-similar strings here without trying to validate the
  // shape — the encrypt() helper produces a versioned base64 string
  // and changes to its format would surface elsewhere.
  sshHost: z.string().nullable(),
  sshPort: z.number().int().nullable(),
  sshUser: z.string().nullable(),
  // ssh credential columns are `text` in the DB (no length cap). The
  // SSH-private-key encrypted blob can run to several KB after AES-GCM
  // + base64. We allow the same range here.
  sshKeyEncrypted: z.string().max(16384).nullable(),
  sshPasswordEncrypted: z.string().max(16384).nullable(),
  sshPath: z.string().nullable(),
  s3Endpoint: z.string().nullable(),
  s3Bucket: z.string().nullable(),
  s3Region: z.string().nullable(),
  // s3/cifs encrypted columns are varchar(500) in the DB (database
  // review M-D2). Zod cap mirrors the DB cap so an oversized blob
  // fails at parse time with a clear error rather than mid-INSERT.
  s3AccessKeyEncrypted: z.string().max(500).nullable(),
  s3SecretKeyEncrypted: z.string().max(500).nullable(),
  s3Prefix: z.string().nullable(),
  s3UsePathStyle: z.boolean(),
  cifsHost: z.string().nullable(),
  cifsPort: z.number().int().nullable(),
  cifsShare: z.string().nullable(),
  cifsUser: z.string().nullable(),
  cifsPasswordEncrypted: z.string().max(500).nullable(),
  cifsDomain: z.string().nullable(),
  cifsPath: z.string().nullable(),
  retentionDays: z.number().int(),
  scheduleExpression: z.string().nullable(),
  enabled: z.number().int(),
  active: z.boolean(),
  // Range matches the CHECK constraint added in migration 0017
  // (database review M-D1): an out-of-range source value now fails
  // at parse time, before any transaction opens.
  drainTimeoutSeconds: z.number().int().min(30).max(1800),
  /** Forced to TRUE for every row on export. Unit B's importer
   *  expects this and would refuse a row with readOnly:false (that
   *  would be a malformed bundle — DR cannot ship a writable target). */
  readOnly: z.literal(true),
});
export type BackupConfigurationRow = z.infer<typeof backupConfigurationRowSchema>;

export const backupTargetAssignmentRowSchema = z.object({
  backupClass: z.enum(['system', 'tenant', 'mail']),
  targetId: z.string().uuid(),
  priority: z.number().int(),
});
export type BackupTargetAssignmentRow = z.infer<typeof backupTargetAssignmentRowSchema>;

export const drRowsSchema = z.object({
  drBundleVersion: drBundleVersionSchema,
  createdAt: z.string().datetime(),
  backupConfigurations: z.array(backupConfigurationRowSchema),
  backupTargetAssignments: z.array(backupTargetAssignmentRowSchema),
});
export type DrRows = z.infer<typeof drRowsSchema>;
