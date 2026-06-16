/**
 * Restore executor: `files-paths` (restic-native).
 *
 * The files component now captures each on-disk file as a restic node
 * (see tenant-bundles/components/files.ts). Restore therefore runs a
 * tenant-namespace Job that mounts the tenant data PVC READ-WRITE at
 * `/source`, mounts a per-Job creds Secret, and runs:
 *
 *   restic -r "$REPO" restore <snap> --target /restore-tmp \
 *       [--include /source/<path> …] --no-lock
 *   cp -a /restore-tmp/source/. /source/
 *
 * `/restore-tmp` is an emptyDir; restic lands the snapshot tree under
 * `/restore-tmp/source/<...>` (because capture stored absolute paths
 * rooted at `/source`). The `cp -a` then overlays those files onto the
 * live PVC. Files already present are overwritten; files NOT in the
 * snapshot are LEFT ALONE (no DELETE) — same idempotent overwrite
 * semantics as the old tar path.
 *
 * Selector shapes (per api-contracts/restore.ts):
 *   { kind: 'full' }                       → no --include (whole snapshot)
 *   { kind: 'paths', paths: ['var/www/…'] } → DISPLAY paths (relative)
 *
 * Path model (SHARED DECISION): selector paths are DISPLAY paths —
 * relative, no leading `/source`, no leading slash, no `..`. We validate
 * them, then map each to the in-snapshot absolute path `/source/<path>`
 * for `--include`.
 */

import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import type { BackupStore } from '../../tenant-bundles/bundle-store.js';
import { restoreItems, restoreJobs, tenants, backupComponents, type RestoreItem } from '../../../db/schema.js';
import { ApiError } from '../../../shared/errors.js';
import { tailJobLog } from '../../storage-lifecycle/job-log-tail.js';
import { createK8sClients, type K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { resolveShimBackupTarget } from '../../tenant-bundles/resolve-backup-target.js';
import {
  buildResticRepoUri,
  buildResticEnv,
  deriveResticPassword,
} from '../../tenant-bundles/restic-driver.js';
import {
  FILES_CAPTURE_ROOT,
  buildResticCredsStringData,
  createResticCredsSecret,
  wireSecretOwnerRef,
} from '../../tenant-bundles/components/files.js';

interface Selector {
  kind: 'full' | 'paths';
  paths?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const JOB_DEADLINE_BUFFER_SEC = 60;
const TOOLS_IMAGE_DEFAULT = 'ghcr.io/insulahq/insula/tenant-backup-tools:latest';
const CREDS_MOUNT_PATH = '/var/run/restic-creds';
const RESTIC_SNAPSHOT_ID_RE = /^[0-9a-f]{8,64}$/;
const RESTORE_TMP = '/restore-tmp';

export async function execFilesPathsItem(args: {
  app: FastifyInstance;
  item: RestoreItem;
  store: BackupStore;
}): Promise<void> {
  const { app, item } = args;
  const selector = item.selector as unknown as Selector;

  // ── Selector validation (DISPLAY paths: relative, no `..`) ────────
  const displayPaths = validateSelector(selector);

  // ── Resolve tenant + namespace + PVC ──────────────────────────────
  const [job] = await app.db.select().from(restoreJobs).where(eq(restoreJobs.id, item.restoreJobId)).limit(1);
  if (!job) throw new ApiError('NOT_FOUND', `Restore job ${item.restoreJobId} not found`, 404);
  const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, job.tenantId)).limit(1);
  if (!tenant) throw new ApiError('NOT_FOUND', `Tenant ${job.tenantId} not found`, 404);
  const namespace = tenant.kubernetesNamespace;
  if (!namespace) throw new ApiError('CONFIG_INVALID', `Tenant ${job.tenantId} has no kubernetes_namespace`, 400);

  // Tenant data PVC convention mirrors tenant-bundles/orchestrator.ts.
  // Capture mounts it RO; restore mounts it RW.
  const pvcName = `${namespace}-storage`;

  // ── Resolve the files restic snapshot id ──────────────────────────
  // Persisted on backup_components.sha256 (component='files') by the
  // orchestrator — same source the browse + download paths read.
  const [comp] = await app.db.select()
    .from(backupComponents)
    .where(and(
      eq(backupComponents.backupJobId, item.bundleId),
      eq(backupComponents.component, 'files'),
    ))
    .limit(1);
  if (!comp?.sha256 || !RESTIC_SNAPSHOT_ID_RE.test(comp.sha256)) {
    throw new ApiError('NOT_FOUND', `Bundle ${item.bundleId} has no files restic snapshot`, 404);
  }
  const snapshotId = comp.sha256;

  const secretsKeyHex = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!secretsKeyHex) {
    throw new ApiError('CONFIG_INVALID', 'PLATFORM_ENCRYPTION_KEY not configured', 500);
  }

  // ── Resolve the shim target + per-tenant password + repo URI ──────
  const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined
    ?? process.env.KUBECONFIG_PATH ?? process.env.KUBECONFIG;
  const k8s: K8sClients = createK8sClients(kubeconfigPath);
  const target = await resolveShimBackupTarget(k8s.core, 'tenant', app.log);
  const passwordHex = deriveResticPassword(secretsKeyHex, job.tenantId);
  const repoUri = buildResticRepoUri(target, job.tenantId, 'files');
  const env = buildResticEnv(target);

  // ── Build + dispatch the restore Job ──────────────────────────────
  const jobName = `rs-files-${item.id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 50)}`;
  const credsSecretName = `rs-files-creds-${item.id.replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 63);
  const pinToNode = await findNodeAttachingPvc(k8s, namespace, pvcName);

  // Map DISPLAY paths → in-snapshot absolute include paths (/source/<p>).
  const includePaths = displayPaths.map((p) => `${FILES_CAPTURE_ROOT}/${p}`);

  let credsCreated = false;
  let ownerRefWired = false;
  try {
    await createResticCredsSecret(
      k8s,
      namespace,
      credsSecretName,
      buildResticCredsStringData({ passwordHex, repoUri, env }),
      'restore-files',
    );
    credsCreated = true;

    const spec = buildFilesPathsJobSpec({
      jobName,
      namespace,
      pvcName,
      tenantId: job.tenantId,
      cartId: item.restoreJobId,
      itemId: item.id,
      credsSecretName,
      snapshotId,
      includePaths,
      jobImage: TOOLS_IMAGE_DEFAULT,
      pinToNode,
      activeDeadlineSeconds: Math.max(60, Math.ceil(DEFAULT_TIMEOUT_MS / 1000) - JOB_DEADLINE_BUFFER_SEC),
    });

    const createdJob = await (k8s.batch as unknown as {
      createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<{ metadata?: { uid?: string } }>;
    }).createNamespacedJob({ namespace, body: spec });

    // ownerRef the creds Secret to the Job so it GCs with the Job.
    const jobUid = createdJob.metadata?.uid;
    if (jobUid) {
      try {
        await wireSecretOwnerRef(k8s, namespace, credsSecretName, jobName, jobUid);
        ownerRefWired = true;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[files-paths] could not wire ownerRef on creds Secret '${credsSecretName}': ${(err as Error).message}`);
      }
    }

    await waitForJob(k8s, namespace, jobName, DEFAULT_TIMEOUT_MS, async (msg) => {
      await app.db.update(restoreItems)
        .set({ progressMessage: msg })
        .where(eq(restoreItems.id, item.id));
    });

    // Read the Job's tail log to surface a result line.
    let log = '';
    try { log = (await tailJobLog(k8s, namespace, jobName, { tailLines: 30, maxLineLength: 5000 })) ?? ''; } catch { /* ignore */ }
    const extracted = (log.match(/FILES_RESTORED count=(\d+)/) ?? [])[1] ?? '?';

    await app.db.update(restoreItems)
      .set({ progressMessage: `restored ${extracted} item(s) into ${namespace}/${pvcName}` })
      .where(eq(restoreItems.id, item.id));
  } finally {
    // If ownerRef never wired (Job create / patch failed), kube won't GC
    // the per-tenant creds Secret — delete it ourselves.
    if (credsCreated && !ownerRefWired) {
      try {
        await (k8s.core as unknown as {
          deleteNamespacedSecret: (a: { name: string; namespace: string }) => Promise<unknown>;
        }).deleteNamespacedSecret({ name: credsSecretName, namespace });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[files-paths] best-effort delete of creds Secret '${credsSecretName}' failed: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Validate the selector and return the list of DISPLAY paths to
 * restore. `kind: 'full'` → empty list (no --include). `kind: 'paths'`
 * → validated relative paths (non-empty, no leading slash, no `..`,
 * conservative char allowlist). Exported for unit-testing.
 */
export function validateSelector(selector: Selector): string[] {
  if (selector.kind === 'full') return [];
  if (selector.kind === 'paths' && Array.isArray(selector.paths) && selector.paths.length > 0) {
    const out: string[] = [];
    for (const p of selector.paths) {
      if (typeof p !== 'string' || p.length === 0) {
        throw new ApiError('VALIDATION_ERROR', `files-paths: path must be a non-empty string`, 400);
      }
      // Normalise a leading `./` (legacy shape) away to a clean relative path.
      const rel = p.replace(/^\.\//, '');
      if (rel.startsWith('/')) {
        throw new ApiError('VALIDATION_ERROR', `files-paths: absolute path '${p}' rejected`, 400);
      }
      if (rel.split('/').includes('..')) {
        throw new ApiError('VALIDATION_ERROR', `files-paths: '..' segment rejected in '${p}'`, 400);
      }
      // Reject only control chars / NUL. Real filenames hold `+ ( ) [ ] # ~`
      // etc. (WordPress, numbered archives); restic --include args are
      // single-quote-escaped in the Job shell, so any printable byte is safe.
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f]/.test(rel)) {
        throw new ApiError('VALIDATION_ERROR', `files-paths: path '${p}' contains control characters`, 400);
      }
      out.push(rel);
    }
    return out;
  }
  throw new Error(`files-paths: unsupported selector ${JSON.stringify(selector)}`);
}

export function buildFilesPathsJobSpec(input: {
  jobName: string;
  namespace: string;
  pvcName: string;
  tenantId: string;
  cartId: string;
  itemId: string;
  credsSecretName: string;
  snapshotId: string;
  /** Absolute in-snapshot include paths (/source/<display>). Empty = full. */
  includePaths: ReadonlyArray<string>;
  jobImage: string;
  pinToNode?: string | null;
  activeDeadlineSeconds?: number;
}): Record<string, unknown> {
  const script = buildScript({ snapshotId: input.snapshotId, includePaths: input.includePaths });
  const podSpec: Record<string, unknown> = {
    restartPolicy: 'Never',
    priorityClassName: 'platform-tenant-overhead',
    containers: [{
      name: 'files-restore',
      image: input.jobImage,
      imagePullPolicy: 'Always',
      command: ['sh', '-c', script],
      resources: {
        requests: { cpu: '100m', memory: '256Mi' },
        limits: { cpu: '1500m', memory: '1Gi' },
      },
      volumeMounts: [
        { name: 'source', mountPath: FILES_CAPTURE_ROOT, readOnly: false },
        { name: 'restore-tmp', mountPath: RESTORE_TMP },
        { name: 'scratch', mountPath: '/tmp' },
        { name: 'restic-creds', mountPath: CREDS_MOUNT_PATH, readOnly: true },
      ],
    }],
    volumes: [
      { name: 'source', persistentVolumeClaim: { claimName: input.pvcName } },
      // restic stages the restore tree here before the cp -a overlay.
      { name: 'restore-tmp', emptyDir: { sizeLimit: '50Gi' } },
      { name: 'scratch', emptyDir: { sizeLimit: '2Gi' } },
      {
        name: 'restic-creds',
        secret: {
          secretName: input.credsSecretName,
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
          'platform.io/component': 'restore-files',
          'platform.io/tenant-id': input.tenantId,
          'platform.io/restore-cart': input.cartId,
          'platform.io/restore-item': input.itemId,
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
        // restore-files matches the (tightened) NetworkPolicy pod selector.
        'platform.io/component': 'restore-files',
        'platform.io/tenant-id': input.tenantId,
        'platform.io/restore-cart': input.cartId,
        'platform.io/restore-item': input.itemId,
      },
    },
    spec: jobSpec,
  };
}

function buildScript(opts: { snapshotId: string; includePaths: ReadonlyArray<string> }): string {
  // --include paths come from validated DISPLAY paths (control chars + `..`
  // + leading `/` rejected) mapped to /source/<p>. Real filenames may hold
  // shell metacharacters (`$ ( ) [ ] ' "` …), so single-quote-wrap each arg
  // and escape any embedded single quote — `$(...)` etc. inside single
  // quotes is literal, never executed.
  const includeArgs = opts.includePaths
    .map((p) => `--include '${p.replace(/'/g, `'\\''`)}'`)
    .join(' ');
  return [
    'set -e',
    `export RESTIC_PASSWORD="$(cat ${CREDS_MOUNT_PATH}/restic_password)"`,
    `[ -n "$RESTIC_PASSWORD" ] || { echo "ERROR: restic password missing"; exit 1; }`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_access_key_id ]; then export AWS_ACCESS_KEY_ID="$(cat ${CREDS_MOUNT_PATH}/aws_access_key_id)"; fi`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_secret_access_key ]; then export AWS_SECRET_ACCESS_KEY="$(cat ${CREDS_MOUNT_PATH}/aws_secret_access_key)"; fi`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_region ]; then export AWS_DEFAULT_REGION="$(cat ${CREDS_MOUNT_PATH}/aws_region)"; fi`,
    `REPO="$(cat ${CREDS_MOUNT_PATH}/repo_uri)"`,
    `[ -n "$REPO" ] || { echo "ERROR: repo uri missing"; exit 1; }`,
    `mkdir -p ${RESTORE_TMP}`,
    'echo "Running restic restore..."',
    `restic -r "$REPO" restore ${opts.snapshotId} --target ${RESTORE_TMP} ${includeArgs} --no-lock || { echo "ERROR: restic restore failed"; exit 1; }`,
    // restic lands files under <target>/source/<...> (capture root was
    // /source). Overlay them onto the live PVC. If nothing matched the
    // includes, the staged tree is empty and cp -a is a no-op.
    `if [ -d ${RESTORE_TMP}${FILES_CAPTURE_ROOT} ]; then cp -a ${RESTORE_TMP}${FILES_CAPTURE_ROOT}/. ${FILES_CAPTURE_ROOT}/; fi`,
    // Count restored entries for the progress line (best-effort).
    `COUNT=$(find ${RESTORE_TMP}${FILES_CAPTURE_ROOT} -type f 2>/dev/null | wc -l | tr -d ' ')`,
    'echo "FILES_RESTORED count=${COUNT:-0}"',
  ].join('\n');
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
      readNamespacedJob: (a: { name: string; namespace: string }) => Promise<{
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
      throw new Error(`files-paths Job ${jobName} failed: ${msg}${logTail}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`files-paths Job ${jobName} did not complete within ${timeoutMs}ms`);
    }
    if (onProgress) {
      const elapsedSec = Math.floor((Date.now() - start) / 1000);
      await onProgress(`files-restore in progress (${elapsedSec}s)`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
