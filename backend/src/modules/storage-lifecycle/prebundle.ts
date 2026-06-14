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
 * The restore is the genuinely-missing files restore-into-PVC primitive:
 * a tenant-namespace Job curls platform-api's `…/files-restic-tar`
 * endpoint (which `restic dump`s the snapshot) and untars the stream
 * into the live PVC. restic + backup creds stay on platform-api; the
 * tenant Job only ever sees an HMAC-scoped HTTP stream.
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
import { signUploadToken } from '../tenant-bundles/upload-token.js';
import { tailJobLog } from './job-log-tail.js';

/** Failure insurance window. The bundle is held this long so a shrink
 *  that dies after the PVC delete still has an off-site rollback source;
 *  it is reaped early (deleted) the moment the resize confirms success. */
const PRE_RESIZE_RETENTION_DAYS = 7;
/** Token lifetime only needs to cover the gap until the restore Job's
 *  curl CONNECTS (the token isn't re-checked during the stream), so 30
 *  min is ample even on a cold node — matches files-paths.ts. The
 *  transfer itself may then run for hours (DEFAULT_RESTORE_TIMEOUT_MS). */
const DOWNLOAD_TOKEN_TTL_SEC = 30 * 60;
const DEFAULT_RESTORE_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const RESTORE_JOB_IMAGE = 'alpine:3.20';

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
      secretAccessKey: cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, secretsKeyHex) : '',
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
  // Job for slow ttlSecondsAfterFinished GC). Delete the Job (+pod) now,
  // mirroring snapshotTenantPVC's explicit Job delete. Background
  // propagation so we don't block; the PVC-delete poll absorbs the brief
  // pod-termination lag.
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
 * Restore a files-only bundle into a tenant PVC. Spawns a tenant-
 * namespace Job that streams platform-api's `restic dump` of the files
 * snapshot and untars it into the PVC mounted RW at `/target`.
 *
 * The Job carries `platform.io/component: restore-files` so the
 * `allow-backup-files-jobs-to-platform-api` NetworkPolicy lets it reach
 * platform-api:3000. The HMAC download token is bound to (bundleId,
 * 'files', 'restic-stream') — the same binding the capture used.
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
  const { k8s, bundleId, namespace, pvcName } = args;
  const token = signUploadToken(
    { bundleId, component: 'files', artifactName: 'restic-stream', ttlSeconds: DOWNLOAD_TOKEN_TTL_SEC },
    secretsKey(),
  );
  const downloadUrl =
    `${platformApiInternalUrl().replace(/\/$/, '')}` +
    `/api/v1/internal/bundles/${bundleId}/files-restic-tar?token=${token}`;

  const jobName = `rs-preresize-${bundleId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`.slice(0, 63);
  const spec = buildRestoreJobSpec({
    jobName,
    namespace,
    pvcName,
    tenantId: args.tenantId,
    bundleId,
    downloadUrl,
  });

  await (k8s.batch as unknown as {
    createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace, body: spec });

  await waitForJob(k8s, namespace, jobName, args.timeoutMs ?? DEFAULT_RESTORE_TIMEOUT_MS, args.onProgress);

  // Delete the Job (and its pod) immediately — the destructive-resize
  // orchestrator does not need the pod log post-mortem on success, and
  // a lingering Completed pod holds nothing but is tidier gone.
  try {
    await (k8s.batch as unknown as {
      deleteNamespacedJob: (a: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
    }).deleteNamespacedJob({ name: jobName, namespace, propagationPolicy: 'Background' });
  } catch {
    /* best-effort — TTL GC will reap it */
  }
}

export function buildRestoreJobSpec(input: {
  jobName: string;
  namespace: string;
  pvcName: string;
  tenantId: string;
  bundleId: string;
  downloadUrl: string;
}): Record<string, unknown> {
  const script = [
    'command -v curl >/dev/null 2>&1 || apk add --no-cache curl >/dev/null 2>&1 || { echo "ERROR: curl install failed"; exit 1; }',
    'echo "Streaming files restic snapshot into /target ..."',
    // The capture used `tar cf - .` (UNCOMPRESSED — restic dedups on raw
    // blocks). restic dump reproduces that exact tar, so extract WITHOUT
    // -z. The curl exit is side-channelled to a file: a mid-stream HTTP
    // failure gives tar a clean EOF, so `set -o pipefail` (bash-only,
    // and busybox-ash lacks it) would miss it.
    '( curl --fail-with-body -sS "$RESTORE_URL"; echo $? > /tmp/curl.exit ) | tar xf - -C /target',
    'TAR_RC=$?',
    'CURL_RC=$(cat /tmp/curl.exit 2>/dev/null || echo 1)',
    'if [ "$CURL_RC" != 0 ]; then echo "ERROR: dump stream failed (curl rc=$CURL_RC)"; exit 1; fi',
    'if [ "$TAR_RC" != 0 ]; then echo "ERROR: tar extract failed (rc=$TAR_RC)"; exit 1; fi',
    'echo "PRERESIZE_RESTORE_DONE bundle=$BUNDLE"',
  ].join('\n');

  return {
    metadata: {
      name: input.jobName,
      namespace: input.namespace,
      labels: {
        // MUST be `restore-files` — that's the label the
        // allow-backup-files-jobs-to-platform-api NetworkPolicy admits
        // for egress to platform-api:3000.
        'platform.io/component': 'restore-files',
        'platform.io/tenant-id': input.tenantId,
        'platform.io/pre-resize-bundle': input.bundleId,
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
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
          // Exempt from the tenant ResourceQuota — the workloads are
          // quiesced during a shrink, but the priority class keeps this
          // consistent with the capture/snapshot Jobs.
          priorityClassName: 'platform-tenant-overhead',
          containers: [{
            name: 'files-restore',
            image: RESTORE_JOB_IMAGE,
            imagePullPolicy: 'IfNotPresent',
            command: ['sh', '-c', script],
            // Runs as root so `tar x` can restore file ownership (chown)
            // into the PVC, but otherwise hardened: no privilege
            // escalation, default seccomp. PSA-baseline compliant.
            securityContext: {
              allowPrivilegeEscalation: false,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            env: [
              { name: 'RESTORE_URL', value: input.downloadUrl },
              { name: 'BUNDLE', value: input.bundleId },
            ],
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '1000m', memory: '512Mi' },
            },
            volumeMounts: [
              { name: 'target', mountPath: '/target', readOnly: false },
              { name: 'scratch', mountPath: '/tmp' },
            ],
          }],
          volumes: [
            { name: 'target', persistentVolumeClaim: { claimName: input.pvcName } },
            { name: 'scratch', emptyDir: { sizeLimit: '100Mi' } },
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
