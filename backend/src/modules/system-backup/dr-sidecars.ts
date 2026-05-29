/**
 * DR bundle sidecars (A2).
 *
 * Every secrets-bundle export now carries two extra files inside the
 * age-encrypted tar:
 *
 *   dr-inputs.yaml — bootstrap inputs + CNPG recovery pointers needed
 *     BEFORE system-db exists. Read by Unit B's dr-restore importer.
 *   dr-rows.json   — JSON dump of backup_configurations +
 *     backup_target_assignments rows. Encrypted credential columns
 *     pass through as-is. Every config row carries readOnly:true so
 *     Unit B's importer inserts the freshly restored cluster into "DR
 *     freeze" mode.
 *
 * This module is BUILDER-ONLY. No restore/import logic — that's Unit
 * B's job. The parsers below are exported so Unit B (and the harness)
 * can consume the sidecars, but they only decode + version-check;
 * application is deferred.
 *
 * Per the locked PARTIAL-mode design, dr-rows.json carries only the
 * two tables. platform_settings, workload_repos, dns_providers do NOT
 * travel — operator reconfigures via UI / fresh defaults activate.
 */

import yaml from 'js-yaml';
// js-yaml 4.x defaults to CORE_SCHEMA which already rejects unsafe
// tags like !!js/function and !!js/regexp. We pass JSON_SCHEMA
// explicitly to signal intent and protect against an accidental
// downgrade to a pre-4.x version that allowed those tags.
const SAFE_LOAD_OPTS: yaml.LoadOptions = { schema: yaml.JSON_SCHEMA };
import {
  DR_BUNDLE_VERSION,
  drInputsSchema,
  drRowsSchema,
  type DrInputs,
  type DrRows,
  type CnpgRecoveryPointer,
} from '@insula/api-contracts';
import {
  backupConfigurations,
  backupTargetAssignments,
  platformStoragePolicy,
  systemSettings,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export class BundleVersionError extends Error {
  readonly receivedVersion: unknown;
  constructor(receivedVersion: unknown) {
    super(
      `Unsupported drBundleVersion: ${String(receivedVersion)} (this build supports ${DR_BUNDLE_VERSION})`,
    );
    this.name = 'BundleVersionError';
    this.receivedVersion = receivedVersion;
  }
}

/**
 * Per-cluster CNPG recovery pointer source. Today there's exactly one
 * (system-db); mail-db was dropped 2026-05-12 in the RocksDB-on-PVC
 * migration. Stalwart's PVC restore goes via mail-restic (Unit C), not
 * CNPG bootstrap.recovery, so no pointer is emitted for mail.
 */
interface ClusterCRReader {
  readClusterCR(
    namespace: string,
    name: string,
  ): Promise<{ spec?: { plugins?: ReadonlyArray<{ name?: string; parameters?: Readonly<Record<string, string>> }> } } | null>;
}

const KNOWN_CNPG_CLUSTERS: ReadonlyArray<{ namespace: string; clusterName: string }> = [
  { namespace: 'platform', clusterName: 'system-db' },
];

/**
 * Build dr-inputs.yaml. Reads:
 *   - apex domain from `app.config.PLATFORM_BASE_DOMAIN`
 *   - cluster name derived from the apex's first label (e.g.
 *     'prod.example.com' -> 'prod'). Operators using a flat apex (just
 *     'example.com') get clusterName='example' — informational only;
 *     not a hard contract.
 *   - mesh CIDR from `platform/platform-cluster-cidrs` ConfigMap
 *     (seeded by bootstrap.sh) with a k3s-default fallback.
 *   - platform version pin from `app.config.PLATFORM_VERSION`.
 *   - mail port mode from `system_settings.mail_port_exposure_mode`.
 *   - CNPG pointer per KNOWN_CNPG_CLUSTERS by reading
 *     `spec.plugins[barman-cloud].parameters.barmanObjectName` +
 *     `externalClusters[0].plugin.parameters.serverName`. Clusters
 *     not currently archiving (no barman plugin attached) are simply
 *     omitted — Unit B's importer treats an empty cnpgClusters[] as
 *     "no archive to recover, operator wants fresh DB".
 */
export interface BuildDrInputsDeps {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly config: {
    readonly PLATFORM_BASE_DOMAIN?: string;
    readonly INGRESS_BASE_DOMAIN?: string;
    readonly PLATFORM_VERSION?: string;
  };
  /** Test-injection hook for reading the Cluster CR without hitting
   *  the real k8s tenant. */
  readonly clusterCRReader?: ClusterCRReader;
}

export async function buildDrInputs(deps: BuildDrInputsDeps): Promise<DrInputs> {
  const apexDomain = deps.config.PLATFORM_BASE_DOMAIN
    ?? deps.config.INGRESS_BASE_DOMAIN
    ?? 'unknown.example';
  // Cluster name = first label of the apex. Operators who set
  // PLATFORM_BASE_DOMAIN=staging.example.test get clusterName='staging';
  // flat apex 'example.com' yields 'example'. Informational only —
  // restore-side operator may use a different one and the bundle just
  // shows what was current at export time.
  const clusterName = apexDomain.split('.')[0] || 'cluster';

  const platformVersion = deps.config.PLATFORM_VERSION ?? '0.0.0';

  // Mail port mode from system_settings (singleton). If the row doesn't
  // exist yet (fresh cluster never touched the mail page), default to
  // 'haproxy' since that's the locked production HA path.
  let mailPortMode: 'haproxy' | 'hostport' = 'haproxy';
  try {
    const [row] = await deps.db
      .select({ mode: systemSettings.mailPortExposureMode })
      .from(systemSettings)
      .limit(1);
    if (row?.mode === 'thisNodeOnly') {
      mailPortMode = 'hostport';
    } else if (row?.mode === 'allServerNodes') {
      mailPortMode = 'haproxy';
    }
  } catch {
    // Empty table on fresh installs — keep default.
  }

  // Mesh CIDR from the ConfigMap bootstrap.sh seeds.
  const meshCidr = await readMeshCidr(deps.k8s).catch(() => '10.42.0.0/16');

  // CNPG pointers — one read per known cluster. Misses (cluster doesn't
  // exist yet, or has no barman plugin attached) are silently omitted.
  const reader: ClusterCRReader = deps.clusterCRReader ?? defaultClusterCRReader(deps.k8s);
  const cnpgClusters: CnpgRecoveryPointer[] = [];
  for (const c of KNOWN_CNPG_CLUSTERS) {
    const pointer = await readCnpgPointer(reader, c.namespace, c.clusterName).catch(() => null);
    if (pointer) cnpgClusters.push(pointer);
  }

  // Topology heuristic: if CNPG cluster reports instances=3 or any
  // existing systemBackup state indicates HA, mark as ha; otherwise
  // single. We don't read CNPG status here — operator's current
  // platform-storage-policy.systemTier is the canonical source.
  const bundleTopology: 'single' | 'ha' = await readBundleTopology(deps.db);

  const inputs: DrInputs = {
    drBundleVersion: DR_BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    apexDomain,
    clusterName,
    meshCidr,
    platformVersion,
    cnpgClusters,
    mailPortMode,
    bundleTopology,
  };
  // Validate before emit — defense in depth against schema drift.
  return drInputsSchema.parse(inputs);
}

async function readMeshCidr(k8s: K8sClients): Promise<string> {
  // SDK shape assumption: @kubernetes/client-node v1.x returns the
  // object body directly from readNamespacedConfigMap (no `.body`
  // wrapper, which existed in 0.x). Same pattern as other reads in
  // this codebase (see backend/src/modules/system-backup/wal-archive.ts).
  const core = k8s.core as unknown as {
    readNamespacedConfigMap: (a: { namespace: string; name: string }) => Promise<{ data?: Record<string, string> }>;
  };
  const cm = await core.readNamespacedConfigMap({
    namespace: 'platform',
    name: 'platform-cluster-cidrs',
  });
  const cidr = cm.data?.POD_CIDR;
  if (!cidr) throw new Error('platform-cluster-cidrs ConfigMap missing POD_CIDR');
  return cidr;
}

function defaultClusterCRReader(k8s: K8sClients): ClusterCRReader {
  return {
    async readClusterCR(namespace: string, name: string) {
      // SDK shape assumption: @kubernetes/client-node v1.x returns the
      // CR body directly (no `.body` wrapper). Same pattern as
      // wal-archive.ts:readClusterCR. If the SDK shape changes, the
      // optional chaining further down (`cr.spec?.plugins?.find`)
      // degrades gracefully — pointer simply omitted from sidecar.
      const custom = k8s.custom as unknown as {
        getNamespacedCustomObject: (a: {
          group: string; version: string; namespace: string; plural: string; name: string;
        }) => Promise<{ spec?: { plugins?: ReadonlyArray<{ name?: string; parameters?: Readonly<Record<string, string>> }> } }>;
      };
      try {
        return await custom.getNamespacedCustomObject({
          group: 'postgresql.cnpg.io',
          version: 'v1',
          namespace,
          plural: 'clusters',
          name,
        });
      } catch {
        return null;
      }
    },
  };
}

async function readCnpgPointer(
  reader: ClusterCRReader,
  namespace: string,
  clusterName: string,
): Promise<CnpgRecoveryPointer | null> {
  const cr = await reader.readClusterCR(namespace, clusterName);
  if (!cr) return null;
  const barman = cr.spec?.plugins?.find((p) => p.name === 'barman-cloud.cloudnative-pg.io');
  if (!barman) return null;
  const objectStoreName = barman.parameters?.barmanObjectName;
  if (!objectStoreName) return null;
  // serverName for bootstrap.recovery — convention: same as the
  // cluster name. The platform's own backup-rclone-shim materialises
  // the ObjectStore with this serverName implicitly (see memory
  // project_restore_wiring_phases). We don't try to introspect it from
  // the ObjectStore CR; the convention is stable.
  return {
    namespace,
    clusterName,
    serverName: clusterName,
    objectStoreName,
  };
}

async function readBundleTopology(db: Database): Promise<'single' | 'ha'> {
  try {
    const [row] = await db
      .select({ tier: platformStoragePolicy.systemTier })
      .from(platformStoragePolicy)
      .limit(1);
    return row?.tier === 'ha' ? 'ha' : 'single';
  } catch {
    return 'single';
  }
}

/**
 * Build dr-rows.json. Selects ALL backup_configurations rows
 * (regardless of enabled state — DR may want to restore a config that
 * was temporarily disabled) and the full backup_target_assignments
 * table. Forces readOnly:true on every config row.
 */
export async function buildDrRows(db: Database): Promise<DrRows> {
  // Snapshot both tables in a single repeatable-read transaction so
  // a concurrent INSERT of (config + assignment) between the two
  // reads can't produce a dangling assignment in the dump (Unit B's
  // FK-aware importer would fail on it). RESTRICT on the FK means
  // the inverse (config deleted, assignment kept) is impossible.
  const { configRows, assignmentRows } = await db.transaction(async (tx) => {
    const cfgs = await tx.select().from(backupConfigurations);
    const asgs = await tx.select().from(backupTargetAssignments);
    return { configRows: cfgs, assignmentRows: asgs };
  });

  const rows: DrRows = {
    drBundleVersion: DR_BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    backupConfigurations: configRows.map((r) => ({
      id: r.id,
      name: r.name,
      storageType: r.storageType,
      sshHost: r.sshHost ?? null,
      sshPort: r.sshPort ?? null,
      sshUser: r.sshUser ?? null,
      sshKeyEncrypted: r.sshKeyEncrypted ?? null,
      sshPasswordEncrypted: r.sshPasswordEncrypted ?? null,
      sshPath: r.sshPath ?? null,
      s3Endpoint: r.s3Endpoint ?? null,
      s3Bucket: r.s3Bucket ?? null,
      s3Region: r.s3Region ?? null,
      s3AccessKeyEncrypted: r.s3AccessKeyEncrypted ?? null,
      s3SecretKeyEncrypted: r.s3SecretKeyEncrypted ?? null,
      s3Prefix: r.s3Prefix ?? null,
      s3UsePathStyle: r.s3UsePathStyle,
      cifsHost: r.cifsHost ?? null,
      cifsPort: r.cifsPort ?? null,
      cifsShare: r.cifsShare ?? null,
      cifsUser: r.cifsUser ?? null,
      cifsPasswordEncrypted: r.cifsPasswordEncrypted ?? null,
      cifsDomain: r.cifsDomain ?? null,
      cifsPath: r.cifsPath ?? null,
      retentionDays: r.retentionDays,
      scheduleExpression: r.scheduleExpression ?? null,
      enabled: r.enabled,
      active: r.active,
      drainTimeoutSeconds: r.drainTimeoutSeconds,
      // CRITICAL: every exported row is RO. Unit B's importer expects
      // this — a writable target in a bundle would defeat the entire
      // DR-safety mechanism A1 ships.
      readOnly: true as const,
    })),
    backupTargetAssignments: assignmentRows.map((r) => ({
      // Drizzle's column is varchar('backup_class'); the Zod parse on
      // the next line is the authoritative validator that rejects
      // unexpected values. No runtime cast needed.
      backupClass: r.backupClass as 'system' | 'tenant' | 'mail',
      targetId: r.targetId,
      priority: r.priority,
    })),
  };
  // Schema-validate before emit — same defence-in-depth as buildDrInputs.
  return drRowsSchema.parse(rows);
}

// ─── Serialisation (used by the bundle exporter) ─────────────────────

export function serializeDrInputs(inputs: DrInputs): Buffer {
  // YAML for human readability inside the bundle. The exporter still
  // schema-validates first via buildDrInputs.
  return Buffer.from(yaml.dump(inputs), 'utf8');
}

export function serializeDrRows(rows: DrRows): Buffer {
  // JSON for dr-rows — it's machine-only data (UUIDs, encrypted blobs)
  // and the readability tradeoff isn't worth the YAML overhead.
  return Buffer.from(JSON.stringify(rows, null, 2) + '\n', 'utf8');
}

// ─── Readers (Unit B + harness will use these) ──────────────────────

export function parseDrInputs(raw: Buffer | string): DrInputs {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const parsed: unknown = yaml.load(text, SAFE_LOAD_OPTS);
  // Version-check BEFORE the full Zod parse so we emit a precise error
  // for forward-incompatible bundles instead of a noisy schema diff.
  const v = (parsed as { drBundleVersion?: unknown })?.drBundleVersion;
  if (v !== DR_BUNDLE_VERSION) {
    throw new BundleVersionError(v);
  }
  return drInputsSchema.parse(parsed);
}

export function parseDrRows(raw: Buffer | string): DrRows {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`dr-rows.json is not valid JSON: ${(err as Error).message}`);
  }
  const v = (parsed as { drBundleVersion?: unknown })?.drBundleVersion;
  if (v !== DR_BUNDLE_VERSION) {
    throw new BundleVersionError(v);
  }
  return drRowsSchema.parse(parsed);
}
