/**
 * Pre-resize snapshot via a files-only `system` tenant bundle.
 *
 * Background: a destructive PVC shrink (`quiesce → snapshot → delete PVC
 * → recreate smaller → restore`) needs a FILE-LEVEL snapshot of the old
 * volume — a Longhorn block snapshot can't restore into a *smaller*
 * volume. The original implementation streamed one giant `tar | gzip |
 * rclone rcat` object to the backup-rclone-shim's `serve s3`, which
 * buffers the whole object in RAM (gofakes3) and OOMs past ~1 GiB. That
 * is the bug that made every real shrink fail.
 *
 * The fix (agreed design): the pre-resize snapshot is a **files-only
 * `system` tenant bundle** captured through the standard restic path —
 * the tenant-namespace Job tars the PVC and streams it to platform-api's
 * `restic backup --stdin`, which chunks it into 64 MiB packs. Chunked
 * writes are shim-safe; no single large object ever hits gofakes3.
 *
 * This module provides the three operations the destructive-resize
 * orchestrator needs:
 *   - {@link captureFilesOnlyBundle}    — create the bundle (off-site,
 *                                         restic, standard lifecycle).
 *   - {@link restoreFilesBundleIntoPvc} — restore it into the freshly
 *                                         recreated (smaller) PVC.
 *   - {@link reapPreResizeBundle}       — delete it after a confirmed
 *                                         successful resize.
 *
 * The restore (since the restic-native files migration) spawns a
 * tenant-namespace Job (tenant-backup-tools image) that mounts the target PVC
 * RW + a per-Job creds Secret and runs `restic restore <snap> --target …`
 * directly against the per-tenant shim repo, then overlays the result onto the
 * PVC. Mirrors backup-restore/executors/files-paths.ts (the cart restore).
 */

import { eq, and } from 'drizzle-orm';
import {
  backupConfigurations,
  backupTargetAssignments,
  backupJobs,
  backupComponents,
  tenants,
} from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { runBundle } from '../tenant-bundles/orchestrator.js';
import { resolveShimBackupStore } from '../tenant-bundles/shim-backup-store.js';
import { S3BackupStore } from '../tenant-bundles/s3-backup-store.js';
import { SshBackupStore } from '../tenant-bundles/ssh-backup-store.js';
import type { BackupStore } from '../tenant-bundles/bundle-store.js';
import { decrypt } from '../oidc/crypto.js';
import { requireWritableTarget } from '../backup-config/writable-guard.js';
import { resolveShimBackupTarget } from '../tenant-bundles/resolve-backup-target.js';
import { buildResticRepoUri, buildResticEnv, deriveResticPassword } from '../tenant-bundles/restic-driver.js';
import {
  FILES_CAPTURE_ROOT,
  buildResticCredsStringData,
  createResticCredsSecret,
  wireSecretOwnerRef,
} from '../tenant-bundles/components/files.js';
import { tailJobLog } from './job-log-tail.js';

/** Failure insurance window. The bundle is held this long so a shrink
 *  that dies after the PVC delete still has an off-site rollback source;
 *  it is reaped early (deleted) the moment the resize confirms success. */
const PRE_RESIZE_RETENTION_DAYS = 7;
const DEFAULT_RESTORE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
// Restic-native restore (mirrors backup-restore/executors/files-paths.ts): the
// tenant Job runs `restic restore` directly against the per-tenant shim repo,
// so it needs the restic toolchain image + the creds mount + a staging dir.
const TOOLS_IMAGE_DEFAULT = 'ghcr.io/insulahq/insula/tenant-backup-tools:latest';
const CREDS_MOUNT_PATH = '/var/run/restic-creds';
const RESTORE_TMP = '/restore-tmp';
const RESTIC_SNAPSHOT_ID_RE = /^[0-9a-f]{8,64}$/;

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

function secretsKey(): string {
  return readEnv('PLATFORM_ENCRYPTION_KEY') ?? '0'.repeat(64);
}

function platformApiInternalUrl(): string {
  return readEnv('PLATFORM_API_INTERNAL_URL') ?? 'http://platform-api.platform.svc:3000';
}

/**
 * Resolve the platform's tenant-class backup target — the same one the
 * global scheduler writes tenant bundles to. Prefers the
 * `backup_target_assignments` model (class=tenant), falls back to the
 * legacy `active=true` row. Fail-loud (`NO_SNAPSHOT_TARGET`) when none
 * exists: a destructive shrink MUST have an off-site rollback snapshot.
 */
async function resolveTenantBundleTarget(
  db: Database,
): Promise<typeof backupConfigurations.$inferSelect> {
  let cfg: typeof backupConfigurations.$inferSelect | undefined;
  const [assigned] = await db
    .select({ targetId: backupTargetAssignments.targetId })
    .from(backupTargetAssignments)
    .where(eq(backupTargetAssignments.backupClass, 'tenant'))
    .orderBy(backupTargetAssignments.priority)
    .limit(1);
  if (assigned) {
    const [byId] = await db
      .select()
      .from(backupConfigurations)
      .where(eq(backupConfigurations.id, assigned.targetId))
      .limit(1);
    cfg = byId;
  }
  if (!cfg) {
    const [legacy] = await db
      .select()
      .from(backupConfigurations)
      .where(eq(backupConfigurations.active, true))
      .limit(1);
    cfg = legacy;
  }
  if (!cfg) {
    throw new ApiError(
      'NO_SNAPSHOT_TARGET',
      'A destructive shrink needs an off-site backup target for the pre-resize snapshot, but no tenant-class backup target is configured. Configure one under Admin → Backup Settings, then retry.',
      400,
    );
  }
  return cfg;
}

/** Build the direct (non-shim) store from a cfg row — used only when the
 *  shim creds Secret isn't bootstrapped (fresh cluster fallback). */
function buildDirectStore(
  cfg: typeof backupConfigurations.$inferSelect,
  secretsKeyHex: string,
): BackupStore {
  if (cfg.storageType === 's3') {
    return new S3BackupStore({
      bucket: cfg.s3Bucket ?? '',
      region: cfg.s3Region ?? 'us-east-1',
      endpoint: cfg.s3Endpoint ?? undefined,
      accessKeyId: cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, secretsKeyHex) : '',
      // Not a literal secret — decrypts the encrypted target credential at runtime.
      secretAccessKey: cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, secretsKeyHex) : '', // gitleaks:allow
      pathPrefix: cfg.s3Prefix ?? undefined,
    });
  }
  if (cfg.storageType === 'ssh') {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyEncrypted || !cfg.sshPath) {
      throw new ApiError('CONFIG_INVALID', `SSH backup target ${cfg.id} is missing required fields`, 400);
    }
    return new SshBackupStore({
      host: cfg.sshHost,
      port: cfg.sshPort ?? 22,
      user: cfg.sshUser,
      privateKey: decrypt(cfg.sshKeyEncrypted, secretsKeyHex),
      basePath: cfg.sshPath,
    });
  }
  throw new ApiError('CONFIG_INVALID', `Unsupported storage type '${cfg.storageType}' for pre-resize bundle`, 400);
}

/** Prefer the shim store (chunked, multi-protocol upstreams), fall back
 *  to the direct store when the shim creds aren't bootstrapped. */
async function resolveBundleStore(
  k8s: K8sClients,
  cfg: typeof backupConfigurations.$inferSelect,
  secretsKeyHex: string,
): Promise<BackupStore> {
  try {
    return await resolveShimBackupStore(k8s.core, 'tenant', { log: { warn: (...a: unknown[]) => console.warn(...a) } });
  } catch (err) {
    // Observable: capture + reap both call this. If the shim flickers
    // between them they could resolve different stores, so a silent
    // fallback on a destructive op is a trap — log it loudly.
    console.warn(`[prebundle] shim store unavailable, falling back to direct store: ${(err as Error).message}`);
    return buildDirectStore(cfg, secretsKeyHex);
  }
}

export interface PreResizeBundleResult {
  readonly bundleId: string;
  readonly status: 'completed' | 'partial';
  readonly sizeBytes: number;
}

/**
 * Capture a files-only `system` bundle (initiator='system',
 * systemTrigger='pre_resize'). Returns once meta.json is committed.
 * Caller MUST assert `status === 'completed'` before deleting the PVC —
 * a `partial` means the files component did not fully capture.
 */
export async function captureFilesOnlyBundle(args: {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly tenantId: string;
  readonly label: string;
  readonly retentionDays?: number;
}): Promise<PreResizeBundleResult> {
  const { db, k8s, tenantId } = args;
  const secretsKeyHex = secretsKey();
  const cfg = await resolveTenantBundleTarget(db);
  const store = await resolveBundleStore(k8s, cfg, secretsKeyHex);

  const result = await runBundle(
    {
      db,
      k8s,
      store,
      platformVersion: readEnv('PLATFORM_VERSION') ?? '0.0.0',
      secretsKeyHex,
      platformApiUrl: platformApiInternalUrl(),
      platformBaseDomain: readEnv('PLATFORM_BASE_DOMAIN') ?? readEnv('INGRESS_BASE_DOMAIN'),
      kubeconfigPath: readEnv('KUBECONFIG_PATH'),
    },
    {
      tenantId,
      initiator: 'system',
      systemTrigger: 'pre_resize',
      label: args.label,
      description: 'Pre-resize rollback snapshot (files-only, off-site).',
      retentionDays: args.retentionDays ?? PRE_RESIZE_RETENTION_DAYS,
      targetConfigId: cfg.id,
      targetUri: `${store.kind}://${cfg.id}`,
      // Files only: the rest of the bundle (mailboxes/config/secrets) is
      // irrelevant for a PVC rollback and would needlessly slow the
      // shrink + grow the artifact.
      components: { files: true, mailboxes: false, config: false, secrets: false },
    },
  );

  // Pull the files-component size for the storage_snapshots row.
  const [comp] = await db
    .select({ sizeBytes: backupComponents.sizeBytes })
    .from(backupComponents)
    .where(and(
      eq(backupComponents.backupJobId, result.bundleId),
      eq(backupComponents.component, 'files'),
    ))
    .limit(1);

  // CRITICAL for the destructive-shrink path: the files-capture Job's
  // Completed pod still holds the PVC RO mount, and the pvc-protection
  // finalizer blocks a PVC delete while ANY pod (even Completed) mounts
  // it — so the resize's `waitForPvcGone` would time out (it leaves the
  // Job for slow ttlSecondsAfterFinished GC). Explicitly delete the Job
  // (+pod) now rather than waiting for GC — Background propagation so we
  // don't block; the PVC-delete poll absorbs the brief pod-termination lag.
  await deleteCaptureJob(db, k8s, tenantId, result.bundleId);

  return {
    bundleId: result.bundleId,
    status: result.status,
    sizeBytes: comp?.sizeBytes ?? 0,
  };
}

/**
 * Delete the files-capture Job (`bk-files-<bundleId>`) for a finished
 * pre-resize bundle so its Completed pod releases the tenant PVC mount
 * before the destructive resize deletes the PVC. Best-effort: the Job's
 * own ttlSecondsAfterFinished is the backstop, and a lingering capture
 * pod only matters on the immediate-PVC-delete (shrink) path.
 */
async function deleteCaptureJob(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  bundleId: string,
): Promise<void> {
  try {
    const [t] = await db
      .select({ ns: tenants.kubernetesNamespace })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!t?.ns) return;
    // Job name mirrors components/files.ts: `bk-files-${bundleId}`.slice(0, 63).
    const jobName = `bk-files-${bundleId}`.slice(0, 63);
    await (k8s.batch as unknown as {
      deleteNamespacedJob: (a: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
    }).deleteNamespacedJob({ name: jobName, namespace: t.ns, propagationPolicy: 'Background' });
  } catch {
    /* best-effort — ttl GC is the backstop */
  }
}

/**
 * Restore a files-only bundle into a tenant PVC via a restic-NATIVE restore.
 *
 * Since #105 the files bundle is restic-native (each file a node, NO single
 * `/archive.tar` blob), so the old `restic dump … | tar x` stream no longer
 * works. This spawns a tenant-namespace Job (tenant-backup-tools image) that
 * mounts the target PVC RW at `/source` + a per-Job creds Secret, and runs:
 *
 *   restic -r "$REPO" restore <snap> --target /restore-tmp --no-lock
 *   cp -a /restore-tmp/source/. /source/
 *
 * It mirrors the PROVEN `backup-restore/executors/files-paths.ts` (the cart
 * restore), but as a FULL restore (no `--include`) into the freshly recreated
 * PVC. Used by destructive shrink AND tenant-archive restore. The Job carries
 * `platform.io/component: restore-files` for the shim NetworkPolicy.
 */
export async function restoreFilesBundleIntoPvc(args: {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly bundleId: string;
  readonly tenantId: string;
  readonly namespace: string;
  readonly pvcName: string;
  readonly onProgress?: (msg: string) => Promise<void> | void;
  readonly timeoutMs?: number;
}): Promise<void> {
  const { db, k8s, bundleId, tenantId, namespace, pvcName } = args;

  // Resolve the files restic snapshot id — same source the browse + cart
  // restore read (persisted on backup_components.sha256 by the orchestrator).
  const [comp] = await db.select().from(backupComponents)
    .where(and(eq(backupComponents.backupJobId, bundleId), eq(backupComponents.component, 'files')))
    .limit(1);
  if (!comp?.sha256 || !RESTIC_SNAPSHOT_ID_RE.test(comp.sha256)) {
    throw new ApiError('NOT_FOUND', `Bundle ${bundleId} has no files restic snapshot`, 404);
  }
  const snapshotId = comp.sha256;

  // Shim target + per-tenant restic password + repo (same as the capture).
  const target = await resolveShimBackupTarget(k8s.core, 'tenant');
  const passwordHex = deriveResticPassword(secretsKey(), tenantId);
  const repoUri = buildResticRepoUri(target, tenantId, 'files');
  const env = buildResticEnv(target);

  const safe = bundleId.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const jobName = `rs-preresize-${safe}`.slice(0, 63);
  const credsSecretName = `rs-preresize-creds-${safe}`.slice(0, 63);

  let credsCreated = false;
  let ownerRefWired = false;
  try {
    await createResticCredsSecret(
      k8s, namespace, credsSecretName,
      buildResticCredsStringData({ passwordHex, repoUri, env }),
      'restore-files',
    );
    credsCreated = true;

    const timeoutMs = args.timeoutMs ?? DEFAULT_RESTORE_TIMEOUT_MS;
    const spec = buildResticRestoreJobSpec({
      jobName, namespace, pvcName, tenantId, bundleId, credsSecretName, snapshotId,
      // Bound the Job's wall-clock in k8s so a platform-api restart mid-restore
      // doesn't leave it running forever with the PVC + creds mounted.
      activeDeadlineSeconds: Math.max(60, Math.ceil(timeoutMs / 1000) - 60),
    });
    const createdJob = await (k8s.batch as unknown as {
      createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<{ metadata?: { uid?: string } }>;
    }).createNamespacedJob({ namespace, body: spec });

    const jobUid = createdJob.metadata?.uid;
    if (jobUid) {
      try { await wireSecretOwnerRef(k8s, namespace, credsSecretName, jobName, jobUid); ownerRefWired = true; }
      catch (err) { console.warn(`[prebundle] could not wire ownerRef on creds Secret '${credsSecretName}': ${(err as Error).message}`); }
    }

    await waitForJob(k8s, namespace, jobName, timeoutMs, args.onProgress);

    try {
      await (k8s.batch as unknown as {
        deleteNamespacedJob: (a: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
      }).deleteNamespacedJob({ name: jobName, namespace, propagationPolicy: 'Background' });
    } catch { /* best-effort — TTL GC will reap it */ }
  } finally {
    // If the ownerRef never wired, kube won't GC the per-tenant creds Secret.
    if (credsCreated && !ownerRefWired) {
      try {
        await (k8s.core as unknown as {
          deleteNamespacedSecret: (a: { name: string; namespace: string }) => Promise<unknown>;
        }).deleteNamespacedSecret({ name: credsSecretName, namespace });
      } catch { /* best-effort */ }
    }
  }
}

export function buildResticRestoreJobSpec(input: {
  jobName: string;
  namespace: string;
  pvcName: string;
  tenantId: string;
  bundleId: string;
  credsSecretName: string;
  snapshotId: string;
  activeDeadlineSeconds?: number;
}): Record<string, unknown> {
  const script = [
    'set -e',
    `export RESTIC_PASSWORD="$(cat ${CREDS_MOUNT_PATH}/restic_password)"`,
    `[ -n "$RESTIC_PASSWORD" ] || { echo "ERROR: restic password missing"; exit 1; }`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_access_key_id ]; then export AWS_ACCESS_KEY_ID="$(cat ${CREDS_MOUNT_PATH}/aws_access_key_id)"; fi`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_secret_access_key ]; then export AWS_SECRET_ACCESS_KEY="$(cat ${CREDS_MOUNT_PATH}/aws_secret_access_key)"; fi`,
    `if [ -f ${CREDS_MOUNT_PATH}/aws_region ]; then export AWS_DEFAULT_REGION="$(cat ${CREDS_MOUNT_PATH}/aws_region)"; fi`,
    `REPO="$(cat ${CREDS_MOUNT_PATH}/repo_uri)"`,
    `[ -n "$REPO" ] || { echo "ERROR: repo uri missing"; exit 1; }`,
    `mkdir -p ${RESTORE_TMP}`,
    'echo "Running restic restore (full) into PVC..."',
    // Full restore (no --include). restic stages files under
    // <target>/source/<...> because the capture stored absolute paths rooted
    // at /source; overlay them onto the freshly recreated PVC at /source.
    `restic -r "$REPO" restore ${input.snapshotId} --target ${RESTORE_TMP} --no-lock || { echo "ERROR: restic restore failed"; exit 1; }`,
    `if [ -d ${RESTORE_TMP}${FILES_CAPTURE_ROOT} ]; then cp -a ${RESTORE_TMP}${FILES_CAPTURE_ROOT}/. ${FILES_CAPTURE_ROOT}/; fi`,
    `COUNT=$(find ${RESTORE_TMP}${FILES_CAPTURE_ROOT} -type f 2>/dev/null | wc -l | tr -d ' ')`,
    `echo "PRERESIZE_RESTORE_DONE bundle=${input.bundleId} count=\${COUNT:-0}"`,
  ].join('\n');

  return {
    metadata: {
      name: input.jobName,
      namespace: input.namespace,
      labels: {
        'platform.io/component': 'restore-files',
        'platform.io/tenant-id': input.tenantId,
        'platform.io/pre-resize-bundle': input.bundleId,
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      ...(input.activeDeadlineSeconds && input.activeDeadlineSeconds > 0
        ? { activeDeadlineSeconds: input.activeDeadlineSeconds }
        : {}),
      template: {
        metadata: {
          labels: {
            'platform.io/component': 'restore-files',
            'platform.io/tenant-id': input.tenantId,
            'platform.io/pre-resize-bundle': input.bundleId,
          },
        },
        spec: {
          restartPolicy: 'Never',
          // Exempt from the tenant ResourceQuota — workloads are quiesced
          // during a shrink/restore; the priority class keeps this consistent
          // with the capture/snapshot Jobs.
          priorityClassName: 'platform-tenant-overhead',
          containers: [{
            name: 'files-restore',
            image: TOOLS_IMAGE_DEFAULT,
            imagePullPolicy: 'Always',
            command: ['sh', '-c', script],
            // Root so `cp -a` can restore file ownership into the PVC, but
            // otherwise hardened (no privilege escalation, default seccomp).
            securityContext: {
              allowPrivilegeEscalation: false,
              seccompProfile: { type: 'RuntimeDefault' },
            },
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
            { name: 'restic-creds', secret: { secretName: input.credsSecretName, defaultMode: 0o400 } },
          ],
        },
      },
    },
  };
}

async function waitForJob(
  k8s: K8sClients,
  namespace: string,
  jobName: string,
  timeoutMs: number,
  onProgress?: (msg: string) => Promise<void> | void,
): Promise<void> {
  const start = Date.now();
  while (true) {
    const job = await (k8s.batch as unknown as {
      readNamespacedJob: (a: { name: string; namespace: string }) => Promise<{
        status?: {
          conditions?: Array<{ type: string; status: string; message?: string }>;
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
      let tail = '';
      try { tail = (await tailJobLog(k8s, namespace, jobName, { tailLines: 20, maxLineLength: 5000 })) ?? ''; } catch { /* ignore */ }
      const reason = failed?.message ?? 'Job failed';
      throw new Error(`pre-resize restore Job ${jobName} failed: ${reason}${tail ? ` — ${tail}` : ''}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pre-resize restore Job ${jobName} did not complete within ${timeoutMs}ms`);
    }
    if (onProgress) {
      const tail = await tailJobLog(k8s, namespace, jobName).catch(() => null);
      if (tail) await onProgress(`restore: ${tail}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/**
 * Reap a pre-resize bundle after a confirmed-successful resize. Mirrors
 * the admin bundle-delete: best-effort remote artifact delete +
 * backup_jobs row delete (cascades backup_components). The restic files
 * snapshot in the per-tenant repo is left to restic retention — same as
 * every other bundle delete. Never throws: a failed reap must not fail
 * an already-successful resize (the bundle's 7-day expiry is the
 * backstop).
 */
export async function reapPreResizeBundle(args: {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly bundleId: string;
}): Promise<void> {
  const { db, k8s, bundleId } = args;
  try {
    const [job] = await db.select().from(backupJobs).where(eq(backupJobs.id, bundleId)).limit(1);
    if (!job) return;
    if (job.targetConfigId) {
      const [cfg] = await db
        .select()
        .from(backupConfigurations)
        .where(eq(backupConfigurations.id, job.targetConfigId))
        .limit(1);
      if (cfg) {
        // DR safety: never prune a frozen/read-only target (e.g. one a
        // freshly DR-restored cluster restored FROM). requireWritableTarget
        // throws TargetFrozenError when read_only — the surrounding
        // try/catch swallows it, so the bundle is simply retained until its
        // 7-day expiry rather than deleted off a target we must not touch.
        await requireWritableTarget(db, job.targetConfigId);
        const store = await resolveBundleStore(k8s, cfg, secretsKey());
        const handle = await store.open(bundleId);
        if (handle) await store.delete(handle);
      }
    }
    await db.delete(backupJobs).where(eq(backupJobs.id, bundleId));
  } catch (err) {
    console.warn(`[prebundle] reap of pre-resize bundle ${bundleId} failed (held until 7-day expiry): ${(err as Error).message}`);
  }
}
