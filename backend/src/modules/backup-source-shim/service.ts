/**
 * Where a tenant bundle is read from, and the source shims that make a bundle
 * on another target readable (manifests.ts says what a source shim is).
 *
 * `resolveTenantBundleReadTarget` is the one question every restore asks: the
 * bundle names the target it was written to (`backup_jobs.target_config_id`).
 *   - That target is the one tenant backups are bound to now, or the bundle
 *     names none (rows from before targets were stamped): the real shim, as
 *     always.
 *   - Any other target: its source shim, started here if it is not running.
 *
 * A source shim is removed by `sweepIdleSourceShims` once no Job that reads
 * through it is still running (they carry `insula.host/source-shim`) and it has
 * not been asked for in `SOURCE_SHIM_IDLE_MS` — the grace covers the reads the
 * platform API makes itself (browse, meta.json) and the gaps between a
 * restore's steps.
 */
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import { backupConfigurations } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { BackupTarget } from '../tenant-bundles/restic-driver.js';
import {
  SOURCE_SHIM_APP,
  SOURCE_SHIM_CONFIG_HASH_ANNOTATION,
  SOURCE_SHIM_LABEL,
  SOURCE_SHIM_LAST_USED_ANNOTATION,
  SOURCE_SHIM_NAMESPACE,
  buildSourceShimObjects,
  sourceShimConfigHash,
  sourceShimEndpoint,
  sourceShimId,
  sourceShimName,
} from './manifests.js';

/** How long a source shim with nothing reading through it is kept. */
export const SOURCE_SHIM_IDLE_MS = 30 * 60 * 1000;
const READY_TIMEOUT_MS = 3 * 60 * 1000;
const SHIM_DAEMONSET = 'backup-rclone-shim';

type ShimTarget = Extract<BackupTarget, { kind: 'shim' }>;

export interface BundleReadTarget {
  readonly target: ShimTarget;
  /**
   * The source shim's id when the bundle is read through one, else null.
   * Put it on every Job that reads through it (`sourceShimJobLabels`), so the
   * sweep leaves the shim alone while that Job runs.
   */
  readonly sourceShim: string | null;
}

/** pino's, or `console` where there is no Fastify app (a storage operation). */
export type ReadTargetLog = Pick<Logger, 'info' | 'warn'>;

/** The labels a Job reading through `read` carries; none for the real shim. */
export function sourceShimJobLabels(read: Pick<BundleReadTarget, 'sourceShim'>): Record<string, string> {
  return read.sourceShim ? { [SOURCE_SHIM_LABEL]: read.sourceShim } : {};
}

/**
 * The target tenant backups are bound to now: the winning `tenant` assignment,
 * exactly as the real shim's reconciler picks it. Null when none is.
 */
export async function boundTenantTargetId(db: Database, encryptionKey: string): Promise<string | null> {
  const { loadShimAssignments } = await import('../backup-rclone-shim/service.js');
  const loaded = await loadShimAssignments(db, encryptionKey);
  return loaded.assignments.find((a) => a.className === 'tenant')?.target.id ?? null;
}

/** Pure: does a bundle on `bundleTargetId` need a source shim, given the bound target? */
export function needsSourceShim(bundleTargetId: string | null, boundTargetId: string | null): boolean {
  return bundleTargetId !== null && bundleTargetId !== boundTargetId;
}

/**
 * The restic / S3 endpoint to read a tenant bundle written to `targetConfigId`
 * from. See the module header.
 */
export async function resolveTenantBundleReadTarget(
  db: Database,
  k8s: K8sClients,
  targetConfigId: string | null,
  log: ReadTargetLog,
): Promise<BundleReadTarget> {
  const { resolveShimBackupTarget } = await import('../tenant-bundles/resolve-backup-target.js');
  if (!targetConfigId || !(await bundleNeedsSourceShim(db, targetConfigId, log))) {
    return { target: await resolveShimBackupTarget(k8s.core, 'tenant', log), sourceShim: null };
  }
  const shim = await ensureSourceShim(db, k8s, targetConfigId, platformEncryptionKey(), log);
  return { target: shim, sourceShim: sourceShimId(targetConfigId) };
}

/**
 * Whether a bundle on `targetConfigId` is on a target other than the bound
 * one. When the bound target cannot be read (no encryption key, a database
 * error) the answer is no, with a warning: the real shim, as before this
 * existed — a hiccup must not stop a restore that reads from the bound target.
 */
async function bundleNeedsSourceShim(db: Database, targetConfigId: string, log: ReadTargetLog): Promise<boolean> {
  try {
    return needsSourceShim(targetConfigId, await boundTenantTargetId(db, platformEncryptionKey()));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err), targetConfigId },
      'backup-source-shim: could not tell the bound tenant target — reading through the real shim');
    return false;
  }
}

/**
 * The bundle store (meta.json, config, secrets) of a bundle that sits on
 * another target: an S3 store on its source shim. Null when the bundle is on
 * the bound target — the caller's usual store applies.
 */
export async function sourceShimBundleStore(
  db: Database,
  k8s: K8sClients,
  targetConfigId: string | null,
  log: ReadTargetLog,
): Promise<import('../tenant-bundles/bundle-store.js').BackupStore | null> {
  if (!targetConfigId || !(await bundleNeedsSourceShim(db, targetConfigId, log))) return null;
  const shim = await ensureSourceShim(db, k8s, targetConfigId, platformEncryptionKey(), log);
  const { S3BackupStore } = await import('../tenant-bundles/s3-backup-store.js');
  return new S3BackupStore({
    endpoint: shim.endpoint,
    bucket: shim.bucket,
    region: 'us-east-1', // the shim ignores it; the AWS SDK wants one
    accessKeyId: shim.accessKey,
    secretAccessKey: shim.secretKey,
  });
}

function platformEncryptionKey(): string {
  const key = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!key) throw new ApiError('CONFIG_INVALID', 'PLATFORM_ENCRYPTION_KEY not configured', 500);
  return key;
}

const statusOf = (err: unknown): number | undefined => {
  const e = err as { statusCode?: number; code?: number; body?: { code?: number } };
  return e.statusCode ?? e.code ?? e.body?.code;
};
const isNotFound = (err: unknown): boolean => statusOf(err) === 404;
const isConflict = (err: unknown): boolean => statusOf(err) === 409;

/**
 * Make the source shim for `targetId` run and answer, and say it was asked
 * for now. Idempotent; safe from several replicas at once (a create that
 * loses the race is a 409, read as "there").
 */
export async function ensureSourceShim(
  db: Database,
  k8s: K8sClients,
  targetId: string,
  encryptionKey: string,
  log: ReadTargetLog,
): Promise<ShimTarget> {
  const [row] = await db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetId)).limit(1);
  if (!row) {
    throw new ApiError(
      'BUNDLE_TARGET_NOT_FOUND',
      `The bundle was written to backup target ${targetId}, which is no longer configured`,
      404,
      { targetConfigId: targetId },
      'Add that target again under Backups → Targets (same endpoint, bucket and path), then retry.',
    );
  }
  const { rowToTargetConfig, loadBackupTargetKey } = await import('../backup-rclone-shim/service.js');
  const { renderShimConfig } = await import('../backup-rclone-shim/rclone-config.js');
  const target = rowToTargetConfig(row, encryptionKey);
  const key = await loadBackupTargetKey(k8s.core, SOURCE_SHIM_NAMESPACE, { log });
  const rendered = renderShimConfig(key.rawKey, [{ className: 'tenant', target }]);
  const image = await shimImage(k8s);
  const configHash = sourceShimConfigHash({ keyFingerprint: key.fingerprint, target, image });
  const objects = buildSourceShimObjects({
    targetId,
    image,
    rendered: { upstreamEnv: rendered.upstreamEnv, rcloneConf: rendered.rcloneConf, sshKeys: rendered.sshKeyMaterializations },
    configHash,
    now: new Date(),
  });
  const name = sourceShimName(targetId);

  // Everything but the Deployment is owned by it: deleting the Deployment —
  // the sweep, a settings change — takes the rest with it, so the sweep never
  // removes a Secret or a Service a restore has just set up beside a new one.
  const startShim = async (): Promise<void> => {
    const uid = await createDeployment(k8s, objects.deployment, name);
    const owned = (body: Record<string, unknown>): Record<string, unknown> => ownedBy(body, name, uid);
    await upsertSecret(k8s, owned(objects.credentials));
    await upsertSecret(k8s, owned(objects.sshKeys));
    await upsertConfigMap(k8s, owned(objects.launcher));
    await upsertService(k8s, owned(objects.service), name, uid);
    log.info({ shim: name, target: row.name }, 'backup-source-shim: started for a bundle on another backup target');
  };

  const current = await readDeployment(k8s, name);
  const currentHash = (current?.metadata?.annotations ?? {})[SOURCE_SHIM_CONFIG_HASH_ANNOTATION];
  if (current && currentHash === configHash && await touchSourceShim(k8s, targetId)) {
    // Running with these settings: nothing to write (an SFTP or CIFS password
    // renders differently every time, so a rewrite would always be a change).
  } else {
    if (current) {
      // The target's settings, the key or the shim image changed. A new pod,
      // not an update: platform-api may not change a system workload's image.
      log.info({ shim: name }, 'backup-source-shim: settings changed — replacing');
      await k8s.apps.deleteNamespacedDeployment({ name, namespace: SOURCE_SHIM_NAMESPACE, body: { propagationPolicy: 'Background' } } as never)
        .catch((e) => { if (!isNotFound(e)) throw e; });
      await waitDeploymentGone(k8s, name);
    }
    await startShim();
  }
  // Removed by the sweep between the look above and now: started again.
  await waitReady(k8s, name, startShim);
  return {
    kind: 'shim',
    endpoint: sourceShimEndpoint(targetId),
    bucket: 'tenant',
    accessKey: rendered.shimAccessKey,
    secretKey: rendered.shimSecretKey,
  };
}

function ownedBy(body: Record<string, unknown>, name: string, uid: string): Record<string, unknown> {
  const metadata = body.metadata as Record<string, unknown>;
  return {
    ...body,
    metadata: { ...metadata, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name, uid }] },
  };
}

/** Create the Deployment (or find it there), and answer its uid — what its objects are owned by. */
async function createDeployment(k8s: K8sClients, body: Record<string, unknown>, name: string): Promise<string> {
  try {
    const made = await k8s.apps.createNamespacedDeployment({ namespace: SOURCE_SHIM_NAMESPACE, body } as never) as DeploymentShape;
    if (made.metadata?.uid) return made.metadata.uid;
  } catch (err) {
    if (!isConflict(err)) throw err;
  }
  const there = await readDeployment(k8s, name);
  if (!there?.metadata?.uid) throw new ApiError('SOURCE_SHIM_UNAVAILABLE', `The source shim ${name} could not be created`, 503);
  return there.metadata.uid;
}

/**
 * Say the source shim was asked for now — what the sweep's grace counts from.
 * The touch also changes its resourceVersion, which a sweep that read it
 * before deletes against (and so does not). False when it is not there.
 */
export async function touchSourceShim(k8s: K8sClients, targetId: string, now: Date = new Date()): Promise<boolean> {
  try {
    await k8s.apps.patchNamespacedDeployment(
      {
        name: sourceShimName(targetId),
        namespace: SOURCE_SHIM_NAMESPACE,
        body: { metadata: { annotations: { [SOURCE_SHIM_LAST_USED_ANNOTATION]: now.toISOString() } } },
      } as never,
      MERGE_PATCH,
    );
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

async function shimImage(k8s: K8sClients): Promise<string> {
  const ds = await k8s.apps.readNamespacedDaemonSet({ name: SHIM_DAEMONSET, namespace: SOURCE_SHIM_NAMESPACE } as never) as {
    spec?: { template?: { spec?: { containers?: Array<{ name?: string; image?: string }> } } };
  };
  const containers = ds.spec?.template?.spec?.containers ?? [];
  const image = (containers.find((c) => c.name === 'shim') ?? containers[0])?.image;
  if (!image) throw new ApiError('SOURCE_SHIM_UNAVAILABLE', 'The backup shim DaemonSet has no image to start a source shim from', 503);
  return image;
}

interface DeploymentShape {
  metadata?: { name?: string; uid?: string; resourceVersion?: string; annotations?: Record<string, string>; labels?: Record<string, string> };
  spec?: { replicas?: number };
  status?: { readyReplicas?: number; availableReplicas?: number };
}

async function readDeployment(k8s: K8sClients, name: string): Promise<DeploymentShape | null> {
  try {
    return await k8s.apps.readNamespacedDeployment({ name, namespace: SOURCE_SHIM_NAMESPACE } as never) as DeploymentShape;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function waitDeploymentGone(k8s: K8sClients, name: string): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (!(await readDeployment(k8s, name))) return;
    await sleep(2000);
  }
}

async function waitReady(k8s: K8sClients, name: string, startAgain: () => Promise<void>): Promise<void> {
  const until = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < until) {
    const d = await readDeployment(k8s, name);
    if (!d) await startAgain();
    else if ((d.status?.readyReplicas ?? 0) >= 1) return;
    await sleep(2000);
  }
  throw new ApiError(
    'SOURCE_SHIM_NOT_READY',
    `The read-only shim for the bundle's backup target (${name}) did not become ready within ${READY_TIMEOUT_MS / 60_000} minutes`,
    503,
    { shim: name },
    `Check the pod: kubectl -n ${SOURCE_SHIM_NAMESPACE} describe pod -l ${SOURCE_SHIM_LABEL}=${name.replace('backup-source-', '')}; a wrong endpoint or credential on the target shows in its log.`,
  );
}

async function upsertSecret(k8s: K8sClients, body: Record<string, unknown>): Promise<void> {
  const name = (body.metadata as { name: string }).name;
  try {
    // backup-coverage: excluded:cluster-infrastructure
    // (a source shim's rendered config, in `platform` — no tenant data)
    await k8s.core.createNamespacedSecret({ namespace: SOURCE_SHIM_NAMESPACE, body } as never);
  } catch (err) {
    if (!isConflict(err)) throw err;
    await k8s.core.replaceNamespacedSecret({ name, namespace: SOURCE_SHIM_NAMESPACE, body } as never);
  }
}

/** A Service keeps its ClusterIP: an existing one only takes the new owner. */
async function upsertService(k8s: K8sClients, body: Record<string, unknown>, name: string, uid: string): Promise<void> {
  try {
    await k8s.core.createNamespacedService({ namespace: SOURCE_SHIM_NAMESPACE, body } as never);
  } catch (err) {
    if (!isConflict(err)) throw err;
    await k8s.core.patchNamespacedService(
      { name, namespace: SOURCE_SHIM_NAMESPACE, body: { metadata: { ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name, uid }] } } } as never,
      MERGE_PATCH,
    );
  }
}

async function upsertConfigMap(k8s: K8sClients, body: Record<string, unknown>): Promise<void> {
  const name = (body.metadata as { name: string }).name;
  try {
    await k8s.core.createNamespacedConfigMap({ namespace: SOURCE_SHIM_NAMESPACE, body } as never);
  } catch (err) {
    if (!isConflict(err)) throw err;
    await k8s.core.replaceNamespacedConfigMap({ name, namespace: SOURCE_SHIM_NAMESPACE, body } as never);
  }
}

// ─── Sweep ──────────────────────────────────────────────────────────────────

export interface SourceShimFact {
  readonly id: string;
  readonly name: string;
  /** The newest of its last-used stamp and the end of a Job that read through it. */
  readonly lastUsedAt: Date | null;
  /** What a delete is made against: a touch since changes it, and the delete is refused. */
  readonly resourceVersion?: string;
}

/** Pure: which source shims to remove now. */
export function idleSourceShims(
  shims: ReadonlyArray<SourceShimFact>,
  busy: ReadonlySet<string>,
  now: Date,
  idleMs: number = SOURCE_SHIM_IDLE_MS,
): SourceShimFact[] {
  return shims.filter((s) => !busy.has(s.id)
    // An unreadable stamp is not "idle forever": keep it one more grace.
    && s.lastUsedAt !== null
    && now.getTime() - s.lastUsedAt.getTime() >= idleMs);
}

interface JobShape {
  metadata?: { labels?: Record<string, string> };
  status?: {
    active?: number; succeeded?: number; failed?: number; completionTime?: string;
    conditions?: Array<{ type?: string; status?: string; lastTransitionTime?: string }>;
  };
}

/** A Job still running: not finished, by any of the ways a Job says so. */
export function jobStillRunning(job: JobShape): boolean {
  const s = job.status ?? {};
  if (s.completionTime) return false;
  if ((s.conditions ?? []).some((c) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True')) return false;
  return true;
}

/** When a finished Job finished; null for one still running or that says nothing. */
export function jobFinishedAt(job: JobShape): Date | null {
  const s = job.status ?? {};
  const stamp = s.completionTime
    ?? (s.conditions ?? []).find((c) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True')?.lastTransitionTime;
  const at = stamp ? new Date(stamp) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

const later = (a: Date | null, b: Date | null): Date | null => (a && b ? (a > b ? a : b) : a ?? b);

/**
 * Remove every source shim no running Job reads through and nobody has used
 * in the grace — counted from its last-used stamp or the end of the last Job
 * that read through it, whichever is later: a restore whose files Job ran for
 * hours goes on to its mail, and the shim is still there. Only the Deployment
 * is deleted, against the resourceVersion it was read at: one touched since —
 * a restore asked for it — is refused, and stays. Its other objects go with
 * it (owner references). Run under the sweeper's lease (one replica).
 */
export async function sweepIdleSourceShims(
  k8s: K8sClients,
  log: ReadTargetLog,
  now: Date = new Date(),
): Promise<{ removed: string[] }> {
  const list = await k8s.apps.listNamespacedDeployment({ namespace: SOURCE_SHIM_NAMESPACE, labelSelector: `app=${SOURCE_SHIM_APP}` } as never) as {
    items?: DeploymentShape[];
  };
  const jobs = ((await k8s.batch.listJobForAllNamespaces({ labelSelector: SOURCE_SHIM_LABEL } as never) as { items?: JobShape[] }).items ?? []);
  const busy = new Set(jobs.filter(jobStillRunning).map((j) => j.metadata?.labels?.[SOURCE_SHIM_LABEL]).filter((v): v is string => !!v));
  const lastJobEnd = new Map<string, Date>();
  for (const j of jobs) {
    const id = j.metadata?.labels?.[SOURCE_SHIM_LABEL];
    const at = jobFinishedAt(j);
    if (id && at) lastJobEnd.set(id, later(lastJobEnd.get(id) ?? null, at) as Date);
  }
  const shims: SourceShimFact[] = (list.items ?? []).flatMap((d) => {
    const id = d.metadata?.labels?.[SOURCE_SHIM_LABEL];
    const name = d.metadata?.name;
    if (!id || !name) return [];
    const stamp = d.metadata?.annotations?.[SOURCE_SHIM_LAST_USED_ANNOTATION];
    const at = stamp ? new Date(stamp) : null;
    const used = at && !Number.isNaN(at.getTime()) ? at : null;
    return [{ id, name, lastUsedAt: used ? later(used, lastJobEnd.get(id) ?? null) : null, resourceVersion: d.metadata?.resourceVersion }];
  });

  const removed: string[] = [];
  for (const shim of idleSourceShims(shims, busy, now)) {
    try {
      await k8s.apps.deleteNamespacedDeployment({
        name: shim.name,
        namespace: SOURCE_SHIM_NAMESPACE,
        body: {
          propagationPolicy: 'Background',
          ...(shim.resourceVersion ? { preconditions: { resourceVersion: shim.resourceVersion } } : {}),
        },
      } as never);
      removed.push(shim.name);
      log.info({ shim: shim.name }, 'backup-source-shim: removed (idle)');
    } catch (err) {
      if (isConflict(err)) continue; // asked for since it was read: it stays
      if (isNotFound(err)) continue;
      log.warn({ shim: shim.name, err: err instanceof Error ? err.message : String(err) }, 'backup-source-shim: remove failed');
    }
  }
  return { removed };
}
