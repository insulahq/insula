/**
 * Tenant-bundle execution helper for the global scheduler.
 *
 * The legacy per-tenant scheduler (Tier-1, drove tenant_backup_schedules)
 * was retired 2026-05-28 — see migration 0034 and
 * backend/src/modules/tenant-bundles/global-scheduler.ts. This file
 * now exports only `runOneScheduledBundle`, the per-tenant capture
 * helper that the global scheduler dynamic-imports.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { backupConfigurations, backupTargetAssignments } from '../../db/schema.js';
import { runBundle } from './orchestrator.js';
import { decrypt } from '../oidc/crypto.js';
import { S3BackupStore } from './s3-backup-store.js';
import { SshBackupStore } from './ssh-backup-store.js';
import { resolveShimFirstBackupStore } from './shim-backup-store.js';
import type { BackupStore } from './bundle-store.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';

export async function runOneScheduledBundle(app: FastifyInstance, tenantId: string, retentionDays: number): Promise<void> {
  // Prefer the new `backup_target_assignments` model (2026-05-28).
  // Falls back to the legacy `active=true` lookup so a cluster that
  // hasn't migrated assignments yet still fires bundles.
  let cfg: typeof backupConfigurations.$inferSelect | undefined;
  const [assigned] = await app.db.select({ targetId: backupTargetAssignments.targetId })
    .from(backupTargetAssignments)
    .where(eq(backupTargetAssignments.backupClass, 'tenant'))
    .orderBy(backupTargetAssignments.priority)
    .limit(1);
  if (assigned) {
    const [byId] = await app.db.select().from(backupConfigurations)
      .where(eq(backupConfigurations.id, assigned.targetId)).limit(1);
    cfg = byId;
  }
  if (!cfg) {
    const [legacy] = await app.db.select().from(backupConfigurations)
      .where(eq(backupConfigurations.active, true)).limit(1);
    cfg = legacy;
  }
  if (!cfg) throw new Error('no backup target assigned to class=tenant (and no active=true row) — schedule cannot fire');

  const platformVersion = (app.config as Record<string, unknown>).PLATFORM_VERSION as string | undefined ?? '0.0.0';
  const configuredKey = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    throw new Error('PLATFORM_ENCRYPTION_KEY required in production for scheduled bundles');
  }
  const secretsKeyHex = configuredKey ?? '0'.repeat(64);

  // Transport goes through the R-X20 backup-rclone-shim exactly like
  // every manual bundle path (admin POST, tenant run-now, prebundle,
  // internal-upload) — the shim's `tenant` class handles S3/SFTP/CIFS/
  // NFS upstreams uniformly. The direct s3/ssh construction below is
  // only the legacy fallback for a cluster whose shim isn't
  // bootstrapped; anything else (e.g. cifs) without a shim is a hard,
  // named error instead of the silent per-tenant throw that ate every
  // scheduled wave on a CIFS-bound cluster (2026-08-26).
  const store: BackupStore = await resolveShimFirstBackupStore(app, 'tenant', async () => {
    if (cfg.storageType === 's3') {
      const accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, secretsKeyHex) : '';
      const secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, secretsKeyHex) : '';
      return new S3BackupStore({
        bucket: cfg.s3Bucket ?? '',
        region: cfg.s3Region ?? 'us-east-1',
        endpoint: cfg.s3Endpoint ?? undefined,
        accessKeyId: accessKey,
        secretAccessKey: secretKey,
        pathPrefix: cfg.s3Prefix ?? undefined,
      });
    }
    if (cfg.storageType === 'ssh') {
      if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyEncrypted || !cfg.sshPath) {
        throw new Error(`SSH target ${cfg.id} missing required fields`);
      }
      return new SshBackupStore({
        host: cfg.sshHost,
        port: cfg.sshPort ?? 22,
        user: cfg.sshUser,
        privateKey: decrypt(cfg.sshKeyEncrypted, secretsKeyHex),
        basePath: cfg.sshPath,
        logFn: (level, ctx, msg) => app.log[level](ctx, msg),
      });
    }
    throw new Error(
      `Storage type '${cfg.storageType}' needs the backup-rclone-shim (BACKUP_TARGET_KEY Secret missing?) — scheduled bundle cannot fire`,
    );
  }, 'tenant-bundle scheduled wave');

  let k8s;
  try {
    k8s = createK8sClients((app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined);
  } catch {
    k8s = undefined;
  }

  const platformApiUrl = (app.config as Record<string, unknown>).PLATFORM_API_INTERNAL_URL as string | undefined
    ?? process.env.PLATFORM_API_INTERNAL_URL
    ?? 'http://platform-api.platform.svc:3000';

  await runBundle(
    {
      db: app.db,
      k8s,
      store,
      platformVersion,
      secretsKeyHex,
      platformApiUrl,
      // Phase 1.5+ (ADR-047): scheduled runs tag with region id
      // and persist tenant_restic_repo_state.
      platformBaseDomain: (app.config as Record<string, unknown>).PLATFORM_BASE_DOMAIN as string | undefined
        ?? (app.config as Record<string, unknown>).INGRESS_BASE_DOMAIN as string | undefined,
      kubeconfigPath: (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined,
    },
    {
      tenantId,
      initiator: 'system',
      systemTrigger: 'scheduled',
      label: 'scheduled',
      description: null,
      retentionDays,
      targetConfigId: cfg.id,
      // Matches the manual admin path: the store kind (s3 when routed
      // through the shim), not the upstream protocol of the cfg row.
      targetUri: `${store.kind}://${cfg.id}`,
      components: { files: true, mailboxes: true, config: true, secrets: true },
    },
  );
}

// startBackupScheduleTick + runScheduleTick removed 2026-05-28 with
// the tenant_backup_schedules table drop. Global scheduler now drives
// all tenant bundle captures from a single cron — see global-scheduler.ts.
