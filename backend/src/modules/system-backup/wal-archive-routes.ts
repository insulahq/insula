// RO-EXEMPT: these routes invoke wal-archive.ts public helpers which
// are themselves RO-EXEMPT (lifecycle config, not per-write paths).
// The actual WAL writes by postgres sidecars are gated via
// wal-suspend.ts whenever a target is frozen.

/**
 * Phase 4 — WAL archive routes (super_admin only).
 *
 *   GET  /api/v1/system-backup/wal-archive/clusters
 *   POST /api/v1/system-backup/wal-archive/enable
 *   POST /api/v1/system-backup/wal-archive/disable
 *
 * One known cluster is listed by default (platform/system-db). The
 * list endpoint augments DB intent with a snapshot of the CNPG CR's
 * `.status` so operators see the actual archive health (last
 * archived WAL, errors).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { backupConfigurations, systemWalArchiveState } from '../../db/schema.js';
import { inArray } from 'drizzle-orm';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  walArchiveEnableRequestSchema,
  walArchiveDisableRequestSchema,
  walStreamingEnableRequestSchema,
  walStreamingDisableRequestSchema,
  scheduledBackupsEnableRequestSchema,
  scheduledBackupsDisableRequestSchema,
  type WalArchiveActionResponse,
  type WalArchiveCluster,
  type WalArchiveListResponse,
} from '@insula/api-contracts';
import {
  enableWalArchive,
  disableWalArchive,
  enableWalStreaming,
  disableWalStreaming,
  enableScheduledBackups,
  disableScheduledBackups,
  readClusterCR,
  readScheduledBackup,
  extractStatus,
  BARMAN_PLUGIN_NAME,
} from './wal-archive.js';

// Hardcoded list of system CNPG clusters with WAL archive surface.
// Names are version-agnostic so future PG-major bumps don't require
// code/UI updates — dump+restore into the same-named cluster.
//
// 2026-05-24: mail-db removed. Stalwart migrated to RocksDB; the
// mail-namespace CNPG cluster no longer exists. The previously
// rendered card was a phantom that always reported "not found".
//
// Cluster name history (cleaned up 2026-05-07):
//   platform: postgres → postgres-18 → system-db
const KNOWN_CLUSTERS = [
  { clusterNamespace: 'platform', clusterName: 'system-db' },
] as const;

export async function systemBackupWalArchiveRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin'));

  // ── GET /system-backup/wal-archive/clusters ────────────────────
  app.get('/system-backup/wal-archive/clusters', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'List system CNPG clusters with WAL archive state + status',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const k8s = createK8sClients();

    const states = await app.db.select().from(systemWalArchiveState);
    const stateByKey = new Map<string, typeof states[number]>(
      states.map((s) => [`${s.clusterNamespace}/${s.clusterName}`, s]),
    );

    // Resolve target names in one query (small list).
    const targetIds = [...new Set(states.map((s) => s.targetConfigId))];
    const targets = targetIds.length > 0
      ? await app.db
        .select({ id: backupConfigurations.id, name: backupConfigurations.name })
        .from(backupConfigurations)
        .where(inArray(backupConfigurations.id, targetIds))
      : [];
    const nameById = new Map(targets.map((t) => [t.id, t.name] as const));

    const out: WalArchiveCluster[] = await Promise.all(KNOWN_CLUSTERS.map(async (c) => {
      const key = `${c.clusterNamespace}/${c.clusterName}`;
      const state = stateByKey.get(key);
      const [cr, sb] = await Promise.all([
        readClusterCR(k8s, c.clusterNamespace, c.clusterName),
        readScheduledBackup(k8s, c.clusterNamespace, c.clusterName),
      ]);
      const status = extractStatus(cr);
      // Plugin model: WAL archive is "attached" when the cluster's
      // spec.plugins[] lists the barman-cloud plugin entry. Replaces
      // the deprecated check on spec.backup.barmanObjectStore.
      const crHasBackup = Boolean(
        cr?.spec?.plugins?.some((p) => p.name === BARMAN_PLUGIN_NAME),
      );
      const dbEnabled = state !== undefined;
      const baseBackupStatus = sb
        ? {
            lastScheduleTime: sb.status?.lastScheduleTime ?? null,
            nextScheduleTime: sb.status?.nextScheduleTime ?? null,
          }
        : null;
      return {
        clusterNamespace: c.clusterNamespace,
        clusterName: c.clusterName,
        enabled: dbEnabled && crHasBackup,
        state: state
          ? {
              targetConfigId: state.targetConfigId,
              targetName: nameById.get(state.targetConfigId) ?? null,
              retentionDays: state.retentionDays,
              destinationPath: state.destinationPath,
              enabledAt: state.enabledAt.toISOString(),
              archiveTimeout: state.archiveTimeout ?? null,
              baseBackupSchedule: state.baseBackupSchedule ?? null,
              baseBackupRetentionDays: state.baseBackupRetentionDays ?? null,
              baseBackupStatus,
            }
          : null,
        status,
      };
    }));

    return success<WalArchiveListResponse>(out);
  });

  // ── POST /system-backup/wal-archive/enable ─────────────────────
  app.post('/system-backup/wal-archive/enable', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Turn on continuous WAL archive for a CNPG cluster',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = walArchiveEnableRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_WAL_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = (request.user as { sub?: string } | undefined)?.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new ApiError('UNAUTHENTICATED', 'no user id in token', 401);
    }
    if (!isKnownCluster(parsed.data.clusterNamespace, parsed.data.clusterName)) {
      throw new ApiError('SYSTEM_WAL_UNKNOWN_CLUSTER',
        `${parsed.data.clusterNamespace}/${parsed.data.clusterName} is not a known system cluster`, 400);
    }

    try {
      const result = await enableWalArchive({
        db: app.db,
        k8s: createK8sClients(),
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        retentionDays: parsed.data.retentionDays,
        operatorUserId: userId,
        operatorIp: tenantIp(request),
        archiveTimeout: parsed.data.archiveTimeout,
        baseBackupSchedule: parsed.data.baseBackupSchedule ?? null,
      });
      return success<WalArchiveActionResponse>({
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        enabled: true,
        destinationPath: result.destinationPath,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError('SYSTEM_WAL_ENABLE_FAILED', msg, 500);
    }
  });

  // ── POST /system-backup/wal-archive/pitr-recipe ────────────────
  // Returns the recipe for an operator-driven PITR. Builds a CNPG
  // Cluster CR yaml the operator can apply to a target namespace
  // (or send to bootstrap.sh on a fresh cluster). Phase 5 DR drill
  // automates the full apply+wait+swap sequence.
  app.post('/system-backup/wal-archive/pitr-recipe', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Build a CNPG recovery Cluster CR yaml for PITR (super_admin)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const body = request.body as {
      clusterNamespace?: string;
      clusterName?: string;
      targetTime?: string;            // ISO 8601 ("latest" if omitted)
      recoveryClusterName?: string;
    } | null;
    const ns = String(body?.clusterNamespace ?? '');
    const name = String(body?.clusterName ?? '');
    if (!isKnownCluster(ns, name)) {
      throw new ApiError('SYSTEM_WAL_UNKNOWN_CLUSTER',
        `${ns}/${name} is not a known system cluster`, 400);
    }
    const states = await app.db.select().from(systemWalArchiveState);
    const state = states.find((s) => s.clusterNamespace === ns && s.clusterName === name);
    if (!state) {
      throw new ApiError('SYSTEM_WAL_DISABLED',
        'WAL archive not enabled for this cluster — nothing to recover from', 400);
    }
    // recoveryClusterName is freeform input → MUST be a DNS label
    // before we interpolate it into YAML. The default we generate is
    // already DNS-label-shaped (no operator input).
    const dnsLabel = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    const defaultName = `${name}-rec-${Date.now()}`.slice(0, 63);
    const recoveryName = (() => {
      const v = body?.recoveryClusterName;
      if (typeof v !== 'string' || v.length === 0) return defaultName;
      if (v.length > 63 || !dnsLabel.test(v)) {
        throw new ApiError('SYSTEM_WAL_BAD_REQUEST',
          'recoveryClusterName must be a lowercase DNS label (1-63 chars)', 400);
      }
      return v;
    })();
    // targetTime: ISO 8601 only — restrict shape so it can't break YAML quoting.
    const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/;
    const targetTime = (() => {
      const v = body?.targetTime;
      if (typeof v !== 'string' || v.length === 0) return null;
      if (!isoRe.test(v)) {
        throw new ApiError('SYSTEM_WAL_BAD_REQUEST',
          'targetTime must be an ISO 8601 datetime', 400);
      }
      return v;
    })();

    // Plugin-shape recovery (replaces deprecated in-tree
    // barmanObjectStore externalCluster). The source cluster's
    // ObjectStore (`<name>-system-store`) was created by enable;
    // the recovery cluster references it by name and the plugin
    // operator pulls WAL/base from the S3 destination configured there.
    //
    // Side benefit: no destinationPath interpolation in this YAML →
    // the security-reviewer's MEDIUM concern about unquoted YAML
    // interpolation is gone (recoveryName + namespace + sourceName
    // + objectStoreName are all dnsLabel-validated; targetTime is
    // ISO-8601 validated and explicitly quoted).
    const objectStoreName = `${name}-system-store`;
    const yaml = [
      `# Apply with: kubectl apply -f <this-file>`,
      `# CNPG will provision a fresh cluster that replays WAL from S3`,
      `# until ${targetTime ? `target time ${targetTime}` : 'the latest archived WAL'}.`,
      `apiVersion: postgresql.cnpg.io/v1`,
      `kind: Cluster`,
      `metadata:`,
      `  name: ${recoveryName}`,
      `  namespace: ${ns}`,
      `spec:`,
      `  instances: 1`,
      `  imageName: ghcr.io/cloudnative-pg/postgresql:18.3-minimal-trixie`,
      `  plugins:`,
      `    - name: barman-cloud.cloudnative-pg.io`,
      `      parameters:`,
      `        barmanObjectName: ${objectStoreName}`,
      `  bootstrap:`,
      `    recovery:`,
      `      source: ${name}`,
      ...(targetTime ? [`      recoveryTarget:`, `        targetTime: "${targetTime}"`] : []),
      `  externalClusters:`,
      `    - name: ${name}`,
      `      plugin:`,
      `        name: barman-cloud.cloudnative-pg.io`,
      `        parameters:`,
      `          barmanObjectName: ${objectStoreName}`,
      `          serverName: ${name}`,
      `  storage:`,
      `    size: 10Gi`,
      `    storageClass: longhorn-system-local`,
    ].join('\n');

    return success({
      recoveryClusterName: recoveryName,
      namespace: ns,
      targetTime,
      destinationPath: state.destinationPath,
      yaml,
      note: 'Apply + watch the new Cluster come up. Phase 5 DR drill will automate this.',
    });
  });

  // ── POST /system-backup/wal-archive/disable ────────────────────
  app.post('/system-backup/wal-archive/disable', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Turn off continuous WAL archive for a CNPG cluster',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = walArchiveDisableRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_WAL_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = (request.user as { sub?: string } | undefined)?.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new ApiError('UNAUTHENTICATED', 'no user id in token', 401);
    }
    if (!isKnownCluster(parsed.data.clusterNamespace, parsed.data.clusterName)) {
      throw new ApiError('SYSTEM_WAL_UNKNOWN_CLUSTER',
        `${parsed.data.clusterNamespace}/${parsed.data.clusterName} is not a known system cluster`, 400);
    }

    try {
      await disableWalArchive({
        db: app.db,
        k8s: createK8sClients(),
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        operatorUserId: userId,
        operatorIp: tenantIp(request),
      });
      return success<WalArchiveActionResponse>({
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        enabled: false,
        destinationPath: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError('SYSTEM_WAL_DISABLE_FAILED', msg, 500);
    }
  });

  // ─── Phase 7a (2026-05-24): split WAL streaming vs Scheduled Backups ──
  //
  // Four narrow endpoints replace the combined enable/disable. Each is
  // idempotent — calling enable while already enabled UPDATES the
  // settings so operators can edit archive_timeout / cron without
  // disable+re-enable. The combined endpoints above stay for back-compat.

  // POST /system-backup/wal-archive/streaming/enable
  app.post('/system-backup/wal-archive/streaming/enable', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Turn on continuous WAL streaming for a CNPG cluster',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = walStreamingEnableRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_WAL_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = requireUserId(request);
    assertKnownCluster(parsed.data.clusterNamespace, parsed.data.clusterName);
    try {
      const r = await enableWalStreaming({
        db: app.db, k8s: createK8sClients(),
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        retentionDays: parsed.data.retentionDays,
        archiveTimeout: parsed.data.archiveTimeout,
        operatorUserId: userId,
        operatorIp: tenantIp(request),
      });
      return success<WalArchiveActionResponse>({
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        enabled: true,
        destinationPath: r.destinationPath,
      });
    } catch (err) {
      throw new ApiError('SYSTEM_WAL_STREAMING_ENABLE_FAILED',
        err instanceof Error ? err.message : String(err), 500);
    }
  });

  // POST /system-backup/wal-archive/streaming/disable
  app.post('/system-backup/wal-archive/streaming/disable', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Turn off continuous WAL streaming (keep scheduled backups if enabled)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = walStreamingDisableRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_WAL_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = requireUserId(request);
    assertKnownCluster(parsed.data.clusterNamespace, parsed.data.clusterName);
    try {
      await disableWalStreaming({
        db: app.db, k8s: createK8sClients(),
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        operatorUserId: userId,
        operatorIp: tenantIp(request),
      });
      return success<WalArchiveActionResponse>({
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        enabled: false,
        destinationPath: null,
      });
    } catch (err) {
      throw new ApiError('SYSTEM_WAL_STREAMING_DISABLE_FAILED',
        err instanceof Error ? err.message : String(err), 500);
    }
  });

  // POST /system-backup/wal-archive/schedule/enable
  app.post('/system-backup/wal-archive/schedule/enable', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Turn on scheduled base backups (idempotent — call again to update cron)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = scheduledBackupsEnableRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_WAL_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = requireUserId(request);
    assertKnownCluster(parsed.data.clusterNamespace, parsed.data.clusterName);
    try {
      await enableScheduledBackups({
        db: app.db, k8s: createK8sClients(),
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        cron: parsed.data.cron,
        operatorUserId: userId,
        operatorIp: tenantIp(request),
      });
      return success({ enabled: true, cron: parsed.data.cron });
    } catch (err) {
      throw new ApiError('SYSTEM_SCHEDULED_BACKUPS_ENABLE_FAILED',
        err instanceof Error ? err.message : String(err), 500);
    }
  });

  // POST /system-backup/wal-archive/schedule/disable
  app.post('/system-backup/wal-archive/schedule/disable', {
    schema: {
      tags: ['SystemBackup'],
      summary: 'Turn off scheduled base backups (keep WAL streaming if enabled)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = scheduledBackupsDisableRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('SYSTEM_WAL_BAD_REQUEST', parsed.error.message, 400);
    }
    const userId = requireUserId(request);
    assertKnownCluster(parsed.data.clusterNamespace, parsed.data.clusterName);
    try {
      await disableScheduledBackups({
        db: app.db, k8s: createK8sClients(),
        clusterNamespace: parsed.data.clusterNamespace,
        clusterName: parsed.data.clusterName,
        operatorUserId: userId,
        operatorIp: tenantIp(request),
      });
      return success({ enabled: false });
    } catch (err) {
      throw new ApiError('SYSTEM_SCHEDULED_BACKUPS_DISABLE_FAILED',
        err instanceof Error ? err.message : String(err), 500);
    }
  });

}

function requireUserId(request: FastifyRequest): string {
  const userId = (request.user as { sub?: string } | undefined)?.sub;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new ApiError('UNAUTHENTICATED', 'no user id in token', 401);
  }
  return userId;
}

function assertKnownCluster(ns: string, name: string): void {
  if (!isKnownCluster(ns, name)) {
    throw new ApiError('SYSTEM_WAL_UNKNOWN_CLUSTER',
      `${ns}/${name} is not a known system cluster`, 400);
  }
}

function isKnownCluster(ns: string, name: string): boolean {
  return KNOWN_CLUSTERS.some((c) => c.clusterNamespace === ns && c.clusterName === name);
}

// Fastify is configured with trustProxy globally, so request.ip is
// already the real tenant IP (last hop outside trustProxy chain).
// Don't re-parse X-Forwarded-For — that would re-introduce a spoofing
// surface for super_admins manipulating their own audit trail.
function tenantIp(request: FastifyRequest): string | null {
  return request.ip || null;
}
