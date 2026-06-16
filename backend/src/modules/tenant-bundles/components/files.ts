/**
 * `files` component capture (restic-native rewrite, ADR-047).
 *
 * Pipeline (single tenant-namespace Job):
 *
 *   restic -r "$REPO" backup /source <tags…> --pack-size 64
 *       --option s3.connections=5 --json > /tmp/out.json
 *
 * The Job runs `restic backup /source` DIRECTLY against the per-tenant
 * shim-backed repo. There is NO tar pipe and NO curl to platform-api —
 * each on-disk file becomes its own restic node, which enables a tree
 * browser + per-file/folder restore (`restic ls` / `restic restore
 * --include`). The previous "tar → platform-api restic-stream (one
 * opaque /archive.tar blob)" path is REPLACED entirely for files (the
 * `mailboxes` component keeps its tar-stream).
 *
 * Trust boundary change:
 *   The OLD path kept backup creds out of the tenant ns by streaming
 *   the tar through platform-api. The NEW path mounts a per-Job creds
 *   Secret (restic password + shim S3 access/secret keys) at
 *   /var/run/restic-creds. These are the SHIM's HKDF-derived ROOT
 *   credentials (NOT the upstream S3/SFTP creds) — the shim is an
 *   in-cluster ClusterIP, and the per-tenant restic password
 *   cryptographically isolates each tenant's repo. The Secret is
 *   mode-0400 tmpfs, ownerRef'd to the Job for GC.
 *
 * CAPTURE ROOT:
 *   The PVC is mounted READ-ONLY at `/source`. `restic backup /source`
 *   therefore stores absolute paths `/source/<…>`. Browse STRIPS the
 *   `/source` prefix for display; restore RE-ADDS it. api-contracts
 *   file paths are DISPLAY paths (relative, no leading `/source` and no
 *   leading slash).
 *
 * Pre-capture DB dump:
 *   The orchestrator runs preCaptureDatabaseDumps BEFORE this component
 *   spawns the Job. Dump files land at `/exports/predump-…sql` on the
 *   tenant PVC; `restic backup /source` snapshots them alongside the
 *   raw on-disk files. NO DB CLIENTS in this Job's image.
 *
 * Why no gzip / compression:
 *   restic dedups on uncompressed blocks; `--compression off` is the
 *   default for incompressible tenant content (jpegs, mp4, .gz dumps).
 *   We let restic's own packing handle storage. Network cost is
 *   recovered after the first snapshot — incrementals ship only deltas.
 *
 * FILES_DONE log line (UNCHANGED format):
 *   FILES_DONE bundleId=<id> snapshot=<64hex> sizeBytes=<n> fileCount=<n>
 *   parsed by `parseFilesDone`. snapshot id / size / count come from
 *   restic's `--json` summary: snapshot_id, total_bytes_processed,
 *   total_files_processed.
 */

import { eq } from 'drizzle-orm';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import type { Database } from '../../../db/index.js';
import { tailJobLog } from '../../storage-lifecycle/job-log-tail.js';
import { STRATEGIC_MERGE_PATCH } from '../../../shared/k8s-patch.js';
import { resolveBaseDomain } from '../../../config/domains.js';
import { tenantBackupV2Settings, tenants } from '../../../db/schema.js';
import { acquireGlobalSlot, ClusterGateError, type SlotHandle } from '../cluster-concurrency.js';
import { resolveShimBackupTarget } from '../resolve-backup-target.js';
import {
  buildResticRepoUri,
  buildResticEnv,
  buildSnapshotTags,
  deriveResticPassword,
  deriveRegionId,
  ensureResticRepoInitialised,
  type BackupTarget,
} from '../restic-driver.js';

/**
 * PVC mount point inside the capture Job. `restic backup /source`
 * stores absolute paths rooted here. Exported so the browse + restore
 * paths can strip / re-add it consistently (SHARED DECISION).
 */
export const FILES_CAPTURE_ROOT = '/source';

const TOOLS_IMAGE_DEFAULT = 'ghcr.io/insulahq/insula/tenant-backup-tools:latest';

export interface FilesComponentResult {
  /** Restic snapshot id (full 64-char) parsed from the Job log. */
  readonly snapshotId: string;
  /** Bytes processed by restic for this snapshot (total_bytes_processed). */
  readonly sizeBytes: number;
  /** Files processed by restic for this snapshot (total_files_processed). */
  readonly fileCount: number;
  /**
   * @deprecated Compatibility shim. The pre-restic path recorded a sha256
   * of the tar.gz on backup_components.sha256. Restic content-addresses
   * internally and the snapshot id IS the new identity. This field is the
   * snapshot id so the orchestrator's existing `markComponentDone({ sha256 })`
   * call keeps the snapshot id persisted in backup_components.sha256 —
   * which is exactly where browse + restore resolve it from.
   */
  readonly sha256: string;
}

export interface CaptureFilesComponentOpts {
  readonly k8s: K8sClients;
  readonly db: Database;
  readonly namespace: string;
  readonly pvcName: string;
  readonly tenantId: string;
  readonly backupId: string;
  readonly secretsKeyHex: string;
  /** Platform DNS apex used to derive the snapshot-tag region id. */
  readonly platformBaseDomain: string;
  /** Tenant CNAME base domain — second input to resolveBaseDomain. */
  readonly ingressBaseDomain: string;
  readonly platformVersion: string;
  /** Cluster-wide concurrency cap (settings.globalMaxInFlight). 0 = disabled. */
  readonly globalMaxInFlight: number;
  readonly jobImage?: string;
  readonly timeoutMs?: number;
  readonly onProgress?: (msg: string) => Promise<void> | void;
}

/**
 * Outcome of `captureFilesComponent` when the PVC is missing.
 * The orchestrator translates this into `status='skipped'` on the
 * backup_components row instead of a partial bundle.
 */
export class FilesComponentSkippedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'FilesComponentSkippedError';
  }
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const JOB_DEADLINE_BUFFER_SEC = 60;

const CREDS_MOUNT_PATH = '/var/run/restic-creds';

/**
 * Build the restic backup Job shell (POSIX sh). The tenant-backup-tools
 * image is debian (bash/coreutils available) but the script stays POSIX
 * so a future image swap can't silently break it.
 *
 *  1. Export RESTIC_PASSWORD / AWS_* from the mounted creds Secret.
 *  2. REPO=$(cat …/repo_uri).
 *  3. `restic … backup /source <--tag …> --pack-size 64
 *     --option s3.connections=5 --json > /tmp/out.json 2>/tmp/err`.
 *  4. Assert exit 0 (else echo ERROR + tail err + exit 1).
 *  5. Parse snapshot_id / total_bytes_processed / total_files_processed
 *     from the JSON summary via grep -o + sed (POSIX, busybox-safe);
 *     assert a 64-hex snapshot id is present.
 *  6. Echo the canonical FILES_DONE line.
 */
function buildScript(opts: { tags: ReadonlyArray<string>; bundleId: string }): string {
  // Each tag is a `--tag k=v` pair. buildSnapshotTags already restricts
  // values to TAG_VALUE_RE ([A-Za-z0-9._@+/-]) — shell-safe, no quoting
  // needed, but quote defensively anyway.
  const tagArgs = opts.tags.map((t) => `--tag '${t.replace(/'/g, `'\\''`)}'`).join(' ');
  return [
    'set -e',
    `export RESTIC_PASSWORD="$(cat ${CREDS_MOUNT_PATH}/restic_password)"`,
    `[ -n "$RESTIC_PASSWORD" ] || { echo "ERROR: restic password missing"; exit 1; }`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_access_key_id ]; then export AWS_ACCESS_KEY_ID="$(cat ${CREDS_MOUNT_PATH}/aws_access_key_id)"; fi`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_secret_access_key ]; then export AWS_SECRET_ACCESS_KEY="$(cat ${CREDS_MOUNT_PATH}/aws_secret_access_key)"; fi`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_region ]; then export AWS_DEFAULT_REGION="$(cat ${CREDS_MOUNT_PATH}/aws_region)"; fi`,
    `REPO="$(cat ${CREDS_MOUNT_PATH}/repo_uri)"`,
    `[ -n "$REPO" ] || { echo "ERROR: repo uri missing"; exit 1; }`,
    'echo "Running restic backup of /source..."',
    // Capture root is /source; restic stores absolute paths /source/<...>.
    // Disable set -e around restic so we can inspect $? — restic exits 3
    // when it couldn't read SOME files (e.g. a file locked by a running
    // process) but STILL writes a valid snapshot; we accept that as a
    // warning rather than failing the whole bundle. Any other non-zero is
    // fatal. Only a short stderr tail is surfaced (the repo is the
    // in-cluster shim — no off-site presigned URLs leak here).
    'set +e',
    `restic -r "$REPO" backup ${FILES_CAPTURE_ROOT} ${tagArgs} --pack-size 64 --option s3.connections=5 --json > /tmp/out.json 2>/tmp/err`,
    'RC=$?',
    'set -e',
    '[ "$RC" = "3" ] && echo "WARN: restic backup completed with partial read errors (exit 3)"',
    '{ [ "$RC" = "0" ] || [ "$RC" = "3" ]; } || { echo "ERROR: restic backup failed (exit $RC)"; tail -n 20 /tmp/err 2>/dev/null || true; exit 1; }',
    // Summary parse — grep the LAST summary object's fields. restic emits
    // one JSON object per line; the summary line carries snapshot_id +
    // total_bytes_processed + total_files_processed. grep -o + sed is
    // order-independent and busybox-safe (reviewer pattern from the old
    // path).
    'SNAP=$(grep -o \'"snapshot_id":"[0-9a-f]\\{64\\}"\' /tmp/out.json | tail -n1 | sed \'s/.*":"//;s/"$//\')',
    '[ -n "$SNAP" ] || { echo "ERROR: no snapshot_id in restic output"; tail -n 40 /tmp/out.json; exit 1; }',
    'SIZE=$(grep -o \'"total_bytes_processed":[0-9]\\+\' /tmp/out.json | tail -n1 | sed \'s/.*://\')',
    'COUNT=$(grep -o \'"total_files_processed":[0-9]\\+\' /tmp/out.json | tail -n1 | sed \'s/.*://\')',
    `echo "FILES_DONE bundleId=${opts.bundleId} snapshot=$SNAP sizeBytes=\${SIZE:-0} fileCount=\${COUNT:-0}"`,
  ].join('\n');
}

/**
 * Build the K8s Job spec for the restic-native files-component capture.
 * Pure function — exposed for unit-testing the spec without a kube
 * tenant.
 *
 * The Job mounts:
 *   - the tenant PVC READ-ONLY at /source (capture root),
 *   - a scratch emptyDir at /tmp (restic cache + side-channel files),
 *   - the per-Job creds Secret at /var/run/restic-creds (mode 0400).
 */
export function buildFilesComponentJobSpec(input: {
  jobName: string;
  namespace: string;
  pvcName: string;
  tenantId: string;
  backupId: string;
  jobImage: string;
  /** Name of the per-Job creds Secret (restic_password, aws_*, repo_uri). */
  credsSecretName: string;
  /** Snapshot tags — one `--tag k=v` per entry. */
  tags: ReadonlyArray<string>;
  pinToNode?: string | null;
  activeDeadlineSeconds?: number;
}): Record<string, unknown> {
  const script = buildScript({ tags: input.tags, bundleId: input.backupId });
  const podSpec: Record<string, unknown> = {
    restartPolicy: 'Never',
    priorityClassName: 'platform-tenant-overhead',
    containers: [{
      name: 'files',
      image: input.jobImage,
      // Always pull: tenant-backup-tools floats on :latest but worker
      // nodes cache by tag. A cached older image (pre-restic-native)
      // would silently run the wrong entrypoint. Mirrors mailboxes.ts.
      imagePullPolicy: 'Always',
      command: ['sh', '-c', script],
      resources: {
        requests: { cpu: '100m', memory: '256Mi' },
        // restic's pack buffer (s3.connections=5 × pack-size=64 = 320 MiB)
        // plus working set fits comfortably in 1Gi. 1500m lets restic
        // saturate the shim's bandwidth slot.
        limits: { cpu: '1500m', memory: '1Gi' },
      },
      volumeMounts: [
        { name: 'source', mountPath: FILES_CAPTURE_ROOT, readOnly: true },
        { name: 'scratch', mountPath: '/tmp' },
        {
          name: 'restic-creds',
          mountPath: CREDS_MOUNT_PATH,
          readOnly: true,
        },
      ],
    }],
    volumes: [
      { name: 'source', persistentVolumeClaim: { claimName: input.pvcName, readOnly: true } },
      // restic keeps a local cache + scratch under /tmp. 2Gi covers the
      // index/cache for a large tenant without bloating the pod.
      { name: 'scratch', emptyDir: { sizeLimit: '2Gi' } },
      {
        name: 'restic-creds',
        secret: {
          secretName: input.credsSecretName,
          // tmpfs-backed; defaultMode 0400 — only root in the container
          // can read.
          defaultMode: 0o400,
        },
      },
    ],
  };
  if (input.pinToNode) {
    podSpec.nodeName = input.pinToNode;
  }
  const jobSpec: Record<string, unknown> = {
    backoffLimit: 0,
    ttlSecondsAfterFinished: 600,
    template: {
      metadata: {
        labels: {
          'platform.io/component': 'backup-files',
          'platform.io/tenant-id': input.tenantId,
          'platform.io/backup-id': input.backupId,
        },
      },
      spec: podSpec,
    },
  };
  if (input.activeDeadlineSeconds && input.activeDeadlineSeconds > 0) {
    jobSpec.activeDeadlineSeconds = input.activeDeadlineSeconds;
  }
  return {
    metadata: {
      name: input.jobName,
      namespace: input.namespace,
      labels: {
        'platform.io/component': 'backup-files',
        'platform.io/tenant-id': input.tenantId,
        'platform.io/backup-id': input.backupId,
      },
    },
    spec: jobSpec,
  };
}

/**
 * Capture the `files` component into the per-tenant restic repo via a
 * Job that runs `restic backup /source` directly. Returns the restic
 * snapshot id parsed from the Job log line `FILES_DONE snapshot=<id>`.
 *
 * Pre-condition: orchestrator has already run preCaptureDatabaseDumps
 * for this tenant's database deployments (so dumps are on the PVC and
 * will be included in the snapshot).
 */
export async function captureFilesComponent(
  opts: CaptureFilesComponentOpts,
): Promise<FilesComponentResult> {
  const pvcExists = await checkPvcExists(opts.k8s, opts.namespace, opts.pvcName);
  if (!pvcExists) {
    throw new FilesComponentSkippedError(
      `tenant data PVC '${opts.pvcName}' does not exist in namespace '${opts.namespace}' yet`,
    );
  }

  // ── Resolve repo backend (the SHIM) ───────────────────────────────
  // Mirror internal-upload-route.ts: bundle writes go through the R-X20
  // shim's local S3 endpoint regardless of upstream protocol. The shim
  // is an always-present in-cluster ClusterIP; if its Secret is missing
  // we have no backup_configurations row in this opts shape to fall back
  // to, so we surface a clear error and the orchestrator records a real
  // failure rather than a silent skip.
  let target: BackupTarget;
  try {
    target = await resolveShimBackupTarget(opts.k8s.core, 'tenant');
  } catch (err) {
    throw new Error(
      `files-component: shim backup target unavailable: ${(err as Error).message}`,
    );
  }

  const passwordHex = deriveResticPassword(opts.secretsKeyHex, opts.tenantId);
  const repoUri = buildResticRepoUri(target, opts.tenantId, 'files');
  const env = buildResticEnv(target);

  // ── Snapshot tags (replicate internal-upload-route.ts) ────────────
  const [tenant] = await opts.db.select().from(tenants).where(eq(tenants.id, opts.tenantId)).limit(1);
  if (!tenant) {
    throw new Error(`files-component: tenant ${opts.tenantId} not found`);
  }
  const [settings] = await opts.db.select().from(tenantBackupV2Settings).limit(1);
  const regionOverride = settings?.regionIdOverride ?? '';
  const apex = resolveBaseDomain({
    PLATFORM_BASE_DOMAIN: opts.platformBaseDomain,
    INGRESS_BASE_DOMAIN: opts.ingressBaseDomain,
  });
  const regionId = deriveRegionId(apex, regionOverride);
  const tags = buildSnapshotTags({
    bundleId: opts.backupId,
    tenantId: opts.tenantId,
    tenantSlug: tenant.kubernetesNamespace,
    component: 'files',
    regionId,
    platformVersion: opts.platformVersion,
  });

  // ── Init the repo BEFORE dispatching the Job ──────────────────────
  // `restic backup` against an uninitialised repo exits non-zero; init
  // up-front (idempotent — "already initialized" is treated as success).
  await ensureResticRepoInitialised({ target, passwordHex, repoUri });

  const pinToNode = await findNodeAttachingPvc(opts.k8s, opts.namespace, opts.pvcName);
  const jobName = `bk-files-${opts.backupId}`.slice(0, 63);
  const credsSecretName = `bk-files-creds-${opts.backupId}`.slice(0, 63);
  const orchestratorTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const spec = buildFilesComponentJobSpec({
    jobName,
    namespace: opts.namespace,
    pvcName: opts.pvcName,
    tenantId: opts.tenantId,
    backupId: opts.backupId,
    jobImage: opts.jobImage ?? TOOLS_IMAGE_DEFAULT,
    credsSecretName,
    tags,
    pinToNode,
    activeDeadlineSeconds: Math.max(60, Math.ceil(orchestratorTimeoutMs / 1000) - JOB_DEADLINE_BUFFER_SEC),
  });

  // ── Cluster-wide concurrency gate ─────────────────────────────────
  // Acquire the slot BEFORE creating the creds Secret — if the gate
  // refuses we must not leave an orphaned per-tenant creds Secret in the
  // tenant namespace.
  let slot: SlotHandle | null = null;
  let credsCreated = false;
  let ownerRefWired = false;
  try {
    try {
      slot = await acquireGlobalSlot(opts.db, {
        bundleId: opts.backupId,
        component: 'files',
        podName: process.env.HOSTNAME ?? undefined,
        globalMaxInFlight: opts.globalMaxInFlight,
      });
    } catch (err) {
      if (err instanceof ClusterGateError) {
        throw new Error(`files cluster gate refused (${err.code}): ${err.message}`);
      }
      throw err;
    }

    await createResticCredsSecret(
      opts.k8s,
      opts.namespace,
      credsSecretName,
      buildResticCredsStringData({ passwordHex, repoUri, env }),
    );
    credsCreated = true;

    const createdJob = await (opts.k8s.batch as unknown as {
      createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<{ metadata?: { uid?: string } }>;
    }).createNamespacedJob({ namespace: opts.namespace, body: spec });

    // ownerRef the creds Secret to the Job so kube-controller GCs it
    // when the Job's ttlSecondsAfterFinished elapses.
    const jobUid = createdJob.metadata?.uid;
    if (jobUid) {
      try {
        await wireSecretOwnerRef(opts.k8s, opts.namespace, credsSecretName, jobName, jobUid);
        ownerRefWired = true;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[files-component] could not wire ownerRef on creds Secret '${credsSecretName}': ${(err as Error).message}`,
        );
      }
    }

    await waitForJob(opts.k8s, opts.namespace, jobName, orchestratorTimeoutMs, opts.onProgress);

    const log = await readEndOfJobLog(opts.k8s, opts.namespace, jobName);
    const parsed = parseFilesDone(log, opts.backupId);
    if (!parsed) {
      throw new Error(
        `files-component: could not parse FILES_DONE bundleId=${opts.backupId} snapshot=… from Job log (jobName=${jobName})`,
      );
    }
    return {
      snapshotId: parsed.snapshotId,
      sizeBytes: parsed.sizeBytes,
      fileCount: parsed.fileCount,
      sha256: parsed.snapshotId, // see FilesComponentResult.sha256 deprecation note
    };
  } finally {
    if (slot) await slot.release();
    // If the creds Secret was created but the Job's ownerRef never got
    // wired (Job create failed, or the ownerRef patch failed), kube won't
    // GC it — delete it ourselves so the per-tenant creds don't linger.
    if (credsCreated && !ownerRefWired) {
      await deleteSecretBestEffort(opts.k8s, opts.namespace, credsSecretName);
    }
  }
}

/** Best-effort delete of a per-Job creds Secret (404 tolerated). */
async function deleteSecretBestEffort(k8s: K8sClients, namespace: string, name: string): Promise<void> {
  try {
    await (k8s.core as unknown as {
      deleteNamespacedSecret: (args: { name: string; namespace: string }) => Promise<unknown>;
    }).deleteNamespacedSecret({ name, namespace });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[files-component] best-effort delete of creds Secret '${name}' failed: ${(err as Error).message}`);
  }
}

async function readEndOfJobLog(k8s: K8sClients, namespace: string, jobName: string): Promise<string> {
  try {
    const last = await tailJobLog(k8s, namespace, jobName, { tailLines: 30, maxLineLength: 5000 });
    return last ?? '';
  } catch {
    return '';
  }
}

/**
 * Parse the canonical FILES_DONE line from the Job log:
 *
 *   FILES_DONE bundleId=<id> snapshot=<64-hex-id> sizeBytes=<n> fileCount=<n>
 *
 * - bundleId match defends against stale Job-log re-use on a recycled
 *   namespace (deterministic Job name `bk-files-<bundleId>`).
 * - snapshot id is restricted to exactly 64 hex chars (full restic id)
 *   so any truncation produces a parse failure rather than silent
 *   storage of a partial id.
 *
 * Exported for unit-testing without spinning up a Job.
 */
export function parseFilesDone(
  log: string,
  expectedBundleId: string,
): { snapshotId: string; sizeBytes: number; fileCount: number } | null {
  const lines = log.split('\n').reverse();
  for (const line of lines) {
    const m = line.match(
      /FILES_DONE bundleId=(\S+) snapshot=([0-9a-f]{64}) sizeBytes=(\d+) fileCount=(\d+)/,
    );
    if (!m) continue;
    if (m[1] !== expectedBundleId) continue;
    return {
      snapshotId: m[2]!,
      sizeBytes: Number.parseInt(m[3]!, 10),
      fileCount: Number.parseInt(m[4]!, 10),
    };
  }
  return null;
}

async function waitForJob(
  k8s: K8sClients,
  namespace: string,
  jobName: string,
  timeoutMs: number,
  onProgress?: (msg: string) => Promise<void> | void,
): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await (k8s.batch as unknown as {
      readNamespacedJob: (args: { name: string; namespace: string }) => Promise<{
        status?: {
          conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
          succeeded?: number;
          failed?: number;
        };
      }>;
    }).readNamespacedJob({ name: jobName, namespace });

    const status = job.status ?? {};
    const completed = (status.conditions ?? []).find((c) => c.type === 'Complete' && c.status === 'True');
    const failed = (status.conditions ?? []).find((c) => c.type === 'Failed' && c.status === 'True');
    if (completed || (status.succeeded ?? 0) > 0) return;
    if (failed || (status.failed ?? 0) > 0) {
      let logTail = '';
      try {
        const tail = await tailJobLog(k8s, namespace, jobName, { tailLines: 30, maxLineLength: 400 });
        if (tail) logTail = `; logs: ${tail.slice(-1200)}`;
      } catch { /* ignore */ }
      const msg = failed?.message ?? 'Job failed';
      throw new Error(`files-component Job ${jobName} failed: ${msg}${logTail}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`files-component Job ${jobName} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (onProgress) await onProgress('Capturing files…');
    await new Promise((res) => setTimeout(res, 3000));
  }
}

async function findNodeAttachingPvc(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
): Promise<string | null> {
  try {
    const res = await k8s.core.listNamespacedPod({ namespace });
    for (const pod of res.items ?? []) {
      const phase = pod.status?.phase;
      if (phase !== 'Running' && phase !== 'Pending') continue;
      const usesPvc = (pod.spec?.volumes ?? []).some(
        (v) => v.persistentVolumeClaim?.claimName === pvcName,
      );
      if (!usesPvc) continue;
      const node = pod.spec?.nodeName;
      if (typeof node === 'string' && /^[a-z0-9.\-]+$/i.test(node) && node.length <= 253) {
        return node;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build the stringData for a restic creds Secret from a resolved target
 * + per-tenant password + repo URI. Keys:
 *   restic_password        — per-tenant HKDF password
 *   aws_access_key_id      — shim/S3 access key (present for s3/shim)
 *   aws_secret_access_key  — shim/S3 secret key (present for s3/shim)
 *   aws_region             — optional (omitted if absent)
 *   repo_uri               — full restic repo URI for this (tenant, comp)
 *
 * `buildResticEnv(target)` yields the AWS_* keys for s3 + shim targets;
 * empty for ssh/hostpath. Exported + reused by the restore executor.
 */
export function buildResticCredsStringData(args: {
  passwordHex: string;
  repoUri: string;
  env: Record<string, string>;
}): Record<string, string> {
  const stringData: Record<string, string> = {
    restic_password: args.passwordHex,
    repo_uri: args.repoUri,
  };
  if (args.env.AWS_ACCESS_KEY_ID) stringData.aws_access_key_id = args.env.AWS_ACCESS_KEY_ID;
  if (args.env.AWS_SECRET_ACCESS_KEY) stringData.aws_secret_access_key = args.env.AWS_SECRET_ACCESS_KEY;
  if (args.env.AWS_DEFAULT_REGION) stringData.aws_region = args.env.AWS_DEFAULT_REGION;
  return stringData;
}

/**
 * Create a per-Job creds Secret. Idempotent on AlreadyExists (transient
 * Job-create retries are safe). Exported + reused by the restore
 * executor (`component` label distinguishes capture vs restore).
 */
export async function createResticCredsSecret(
  k8s: K8sClients,
  namespace: string,
  name: string,
  stringData: Record<string, string>,
  componentLabel = 'backup-files',
): Promise<void> {
  const body = {
    metadata: {
      name,
      namespace,
      labels: {
        'platform.io/component': componentLabel,
        'platform.io/managed-by': 'tenant-bundles',
      },
    },
    type: 'Opaque',
    stringData,
  };
  try {
    // backup-coverage: excluded:transient-job-creds
    await (k8s.core as unknown as {
      createNamespacedSecret: (args: { namespace: string; body: unknown }) => Promise<unknown>;
    }).createNamespacedSecret({ namespace, body });
  } catch (err) {
    const httpErr = err as { code?: number; statusCode?: number };
    const code = httpErr.code ?? httpErr.statusCode;
    if (code === 409) return; // AlreadyExists — idempotent retry.
    throw err;
  }
}

/**
 * After the Job is created, set ownerReferences on the creds Secret so
 * kube-controller-manager GCs it when the Job is GC'd via
 * ttlSecondsAfterFinished. Strategic-merge patch.
 *
 * Exported so the restore executor can reuse the same GC wiring.
 */
export async function wireSecretOwnerRef(
  k8s: K8sClients,
  namespace: string,
  secretName: string,
  jobName: string,
  jobUid: string,
): Promise<void> {
  const body = {
    metadata: {
      ownerReferences: [{
        apiVersion: 'batch/v1',
        kind: 'Job',
        name: jobName,
        uid: jobUid,
        controller: true,
        blockOwnerDeletion: false,
      }],
    },
  };
  await (k8s.core as unknown as {
    patchNamespacedSecret: (
      args: { name: string; namespace: string; body: unknown },
      override: typeof STRATEGIC_MERGE_PATCH,
    ) => Promise<unknown>;
  }).patchNamespacedSecret(
    { name: secretName, namespace, body },
    STRATEGIC_MERGE_PATCH,
  );
}

async function checkPvcExists(
  k8s: K8sClients,
  namespace: string,
  pvcName: string,
): Promise<boolean> {
  try {
    await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
    return true;
  } catch (err) {
    const httpErr = err as { code?: number; statusCode?: number };
    const code = httpErr.code ?? httpErr.statusCode;
    if (code === 404) return false;
    throw err;
  }
}
