/**
 * DR row importer (Unit B.2).
 *
 * Consumes the parsed sidecars from `readBundle()` and INSERTs
 * backup_configurations + backup_target_assignments into a freshly
 * bootstrapped system-db. Wrapped in a single transaction so a
 * partial failure rolls back cleanly.
 *
 * Locked design decisions (do not change without the operator):
 *   - PARTIAL mode imports ONLY these two tables. platform_settings,
 *     workload_repos, dns_providers, admin_users do NOT travel — the
 *     operator reconfigures via the admin UI / SSO / manual.
 *   - readOnly is forced to true on every config row by the Zod
 *     literal in the sidecar schema. The Drizzle insert here mirrors
 *     that — no path lets a writable target slip in.
 *   - `enabled` is PRESERVED from the source (per DB review L4).
 *     A disabled target stays disabled on import; operator reviews
 *     before flipping. Force-enabling would defeat the freeze model.
 *   - FK order: configs MUST be inserted before assignments
 *     (backup_target_assignments.targetId has ON DELETE RESTRICT, so
 *     the assignment FK requires the parent to exist).
 *   - active=false on every restored row regardless of source — the
 *     Longhorn-BackupTarget active flag is cluster-specific (only one
 *     row per cluster can be active), and the restore importer is
 *     not the right place to pick. Operator activates via UI.
 *
 * Drift handling: the importer reads dr-inputs.yaml's apex/version/
 * topology and compares against the running cluster's current state.
 * Mismatches are logged + returned in the result; the operator can
 * abort by setting --strict in the CLI shim.
 */

import { eq, sql } from 'drizzle-orm';
import {
  backupConfigurations,
  backupTargetAssignments,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type {
  DrInputs,
  DrRows,
  BackupConfigurationRow,
  BackupTargetAssignmentRow,
} from '@k8s-hosting/api-contracts';

export class DrImportError extends Error {
  readonly cause: string;
  constructor(message: string, cause: string) {
    super(`${message}: ${cause}`);
    this.name = 'DrImportError';
    this.cause = cause;
  }
}

export interface DriftReport {
  readonly bundleApex: string;
  readonly clusterApex: string | null;
  readonly bundleVersion: string;
  readonly clusterVersion: string | null;
  readonly bundleTopology: 'single' | 'ha';
  readonly clusterTopology: 'single' | 'ha' | null;
  /** True if any of (apex / version / topology) doesn't match. */
  readonly hasDrift: boolean;
  /** Human-readable summary lines, one per detected mismatch. */
  readonly notes: ReadonlyArray<string>;
}

export interface ImportResult {
  readonly configsInserted: number;
  readonly configsSkippedExisting: number;
  readonly assignmentsInserted: number;
  readonly assignmentsSkippedExisting: number;
  readonly drift: DriftReport;
}

export interface ImportOpts {
  readonly db: Database;
  readonly drInputs: DrInputs;
  readonly drRows: DrRows;
  /** Live cluster state, for drift detection. Caller queries before
   *  invoking us; we don't reach for env vars here so the function
   *  stays test-pure. */
  readonly cluster: {
    readonly apex: string | null;
    readonly platformVersion: string | null;
    readonly topology: 'single' | 'ha' | null;
  };
  /** When true, drift is a hard error (DrImportError thrown before
   *  any INSERT). Default: false (drift is warned, import proceeds). */
  readonly strict?: boolean;
}

/**
 * Import the two tables in a single transaction. Skips rows whose `id`
 * (configs) or composite key (assignments) already exists — re-running
 * the import on a half-restored cluster picks up where it left off.
 */
export async function importDrRows(opts: ImportOpts): Promise<ImportResult> {
  const drift = computeDrift(opts.drInputs, opts.cluster);
  if (drift.hasDrift && opts.strict) {
    throw new DrImportError(
      'Bundle/cluster drift detected and --strict is set',
      drift.notes.join('; '),
    );
  }

  // Single transaction: if assignment insert fails (FK violation,
  // duplicate key, etc.), the config inserts roll back too.
  const result = await opts.db.transaction(async (tx) => {
    let configsInserted = 0;
    let configsSkippedExisting = 0;
    let assignmentsInserted = 0;
    let assignmentsSkippedExisting = 0;

    // ── 1. backup_configurations (parent — must go first per FK) ────
    for (const row of opts.drRows.backupConfigurations) {
      const insertResult = await tx
        .insert(backupConfigurations)
        .values(toBackupConfigInsert(row))
        .onConflictDoNothing({ target: backupConfigurations.id })
        .returning({ id: backupConfigurations.id });
      if (insertResult.length > 0) configsInserted++;
      else configsSkippedExisting++;
    }

    // ── 2. backup_target_assignments (child) ────────────────────────
    for (const row of opts.drRows.backupTargetAssignments) {
      const insertResult = await tx
        .insert(backupTargetAssignments)
        .values(toAssignmentInsert(row))
        .onConflictDoNothing({
          target: [backupTargetAssignments.backupClass, backupTargetAssignments.targetId],
        })
        .returning({ targetId: backupTargetAssignments.targetId });
      if (insertResult.length > 0) assignmentsInserted++;
      else assignmentsSkippedExisting++;
    }

    return { configsInserted, configsSkippedExisting, assignmentsInserted, assignmentsSkippedExisting };
  });

  return { ...result, drift };
}

// ─── Row mappers ─────────────────────────────────────────────────────

function toBackupConfigInsert(row: BackupConfigurationRow) {
  // CRITICAL invariants enforced here even though the Zod schema
  // already locks them — defense in depth in case a future schema
  // bump loosens the literal:
  //   readOnly: true   (DR-freeze on restore)
  //   active:   false  (operator activates the Longhorn target later)
  return {
    id: row.id,
    name: row.name,
    storageType: row.storageType,
    sshHost: row.sshHost,
    sshPort: row.sshPort,
    sshUser: row.sshUser,
    sshKeyEncrypted: row.sshKeyEncrypted,
    sshPasswordEncrypted: row.sshPasswordEncrypted,
    sshPath: row.sshPath,
    s3Endpoint: row.s3Endpoint,
    s3Bucket: row.s3Bucket,
    s3Region: row.s3Region,
    s3AccessKeyEncrypted: row.s3AccessKeyEncrypted,
    s3SecretKeyEncrypted: row.s3SecretKeyEncrypted,
    s3Prefix: row.s3Prefix,
    s3UsePathStyle: row.s3UsePathStyle,
    cifsHost: row.cifsHost,
    cifsPort: row.cifsPort,
    cifsShare: row.cifsShare,
    cifsUser: row.cifsUser,
    cifsPasswordEncrypted: row.cifsPasswordEncrypted,
    cifsDomain: row.cifsDomain,
    cifsPath: row.cifsPath,
    retentionDays: row.retentionDays,
    scheduleExpression: row.scheduleExpression,
    // PRESERVE the source enabled value (per DB review L4). A
    // disabled target stays disabled on restore; operator reviews
    // before flipping. NEVER force enabled=1 here.
    enabled: row.enabled,
    active: false,
    drainTimeoutSeconds: row.drainTimeoutSeconds,
    readOnly: true,
  } as const;
}

function toAssignmentInsert(row: BackupTargetAssignmentRow) {
  return {
    backupClass: row.backupClass,
    targetId: row.targetId,
    priority: row.priority,
  } as const;
}

// ─── Drift detection ────────────────────────────────────────────────

function computeDrift(
  inputs: DrInputs,
  cluster: ImportOpts['cluster'],
): DriftReport {
  const notes: string[] = [];
  if (cluster.apex && cluster.apex !== inputs.apexDomain) {
    notes.push(`apex: bundle=${inputs.apexDomain} cluster=${cluster.apex}`);
  }
  if (cluster.platformVersion && cluster.platformVersion !== inputs.platformVersion) {
    notes.push(`platformVersion: bundle=${inputs.platformVersion} cluster=${cluster.platformVersion}`);
  }
  if (cluster.topology && cluster.topology !== inputs.bundleTopology) {
    notes.push(`topology: bundle=${inputs.bundleTopology} cluster=${cluster.topology}`);
  }
  return {
    bundleApex: inputs.apexDomain,
    clusterApex: cluster.apex,
    bundleVersion: inputs.platformVersion,
    clusterVersion: cluster.platformVersion,
    bundleTopology: inputs.bundleTopology,
    clusterTopology: cluster.topology,
    hasDrift: notes.length > 0,
    notes,
  };
}

// ─── Cluster state probe ────────────────────────────────────────────

/**
 * Read the cluster's current apex / version / topology so the drift
 * report has something to compare against. Returns nulls for any
 * field whose source isn't yet initialised — drift detector treats
 * those as "no mismatch" rather than "definitely a mismatch."
 */
export async function probeClusterState(
  db: Database,
  config: { PLATFORM_BASE_DOMAIN?: string; INGRESS_BASE_DOMAIN?: string; PLATFORM_VERSION?: string },
): Promise<ImportOpts['cluster']> {
  const apex = config.PLATFORM_BASE_DOMAIN ?? config.INGRESS_BASE_DOMAIN ?? null;
  const platformVersion = config.PLATFORM_VERSION ?? null;

  // Topology from platform_storage_policy singleton. Empty table
  // (fresh bootstrap) → null, treated as no-mismatch.
  let topology: 'single' | 'ha' | null = null;
  try {
    const { platformStoragePolicy } = await import('../../db/schema.js');
    const [row] = await db
      .select({ tier: platformStoragePolicy.systemTier })
      .from(platformStoragePolicy)
      .limit(1);
    if (row?.tier === 'ha') topology = 'ha';
    else if (row?.tier === 'local') topology = 'single';
  } catch {
    // Fresh schema may not have the table yet; treat as null.
  }
  // Silence the unused import warning when sql is conditionally
  // referenced (kept for future drift-check queries).
  void sql;
  // Silence the unused import warning when eq is conditionally
  // referenced (kept for future drift-check queries).
  void eq;

  return { apex, platformVersion, topology };
}
