/**
 * Real snapshot/backup operations for platform-ops (ADR-045 / W17).
 *
 * `capture` and `list` import the SAME backend primitives the in-cluster
 * routes use — `cnpg-backup-now` (Backup CR creation) and
 * `cnpg-backup-catalogue` (object-store listing via the backup-rclone-shim).
 * Zero logic duplication; the host binary works when platform-api is down
 * because it talks to the k8s API + shim directly, not through the API pod.
 *
 * Heavy modules load via dynamic import() so subcommands that never touch
 * backups stay lean and start instantly. esbuild bundles the dynamic-import
 * targets into the SEA.
 */
import type {
  SnapshotBackupInfo, SnapshotCaptureOutcome, SnapshotCaptureRequest,
  SnapshotListOutcome, SnapshotListRequest, SnapshotOps,
} from './deps.js';
import { scrubCreds } from './redact.js';

function messageOf(err: unknown): string {
  return scrubCreds(err instanceof Error ? err.message : String(err));
}

/**
 * Map a CnpgBackupNowError's HTTP-ish statusCode to a stable CLI label.
 * 409 is the common operator-actionable case (no barman-cloud plugin
 * attached → backups can't run until WAL Archive is configured).
 */
function captureLabel(statusCode: number | undefined): string {
  switch (statusCode) {
    case 400: return 'INVALID_INPUT';
    case 404: return 'CLUSTER_NOT_FOUND';
    case 409: return 'PRECONDITION_FAILED';
    default: return 'BACKUP_ERROR';
  }
}

export function realSnapshotOps(): SnapshotOps {
  return {
    async capture(req: SnapshotCaptureRequest): Promise<SnapshotCaptureOutcome> {
      try {
        const [{ createK8sClients }, { createBackupNow }] = await Promise.all([
          import('../../modules/k8s-provisioner/k8s-client.js'),
          import('../../modules/cnpg-backup-now/index.js'),
        ]);
        const k8s = createK8sClients(req.kubeconfig);
        const result = await createBackupNow(k8s.custom, {
          namespace: req.namespace,
          clusterName: req.clusterName,
          description: req.description,
        });
        return { ok: true, backup: result };
      } catch (err) {
        // CnpgBackupNowError carries an HTTP-ish statusCode (its `.name` is
        // set on the class); map it to a label. Anything else is a bug.
        const e = err as { statusCode?: number; name?: string };
        const errorCode = e?.name === 'CnpgBackupNowError' ? captureLabel(e.statusCode) : 'UNEXPECTED';
        return { ok: false, errorCode, detail: messageOf(err) };
      }
    },

    async list(req: SnapshotListRequest): Promise<SnapshotListOutcome> {
      try {
        const [{ createK8sClients }, { listBackupsFromObjectStore }] = await Promise.all([
          import('../../modules/k8s-provisioner/k8s-client.js'),
          import('../../modules/cnpg-backup-catalogue/service.js'),
        ]);
        const k8s = createK8sClients(req.kubeconfig);
        // The catalogue NEVER throws — a CR-missing / shim-down / timeout
        // condition returns source:'unavailable' with an operator reason.
        const result = await listBackupsFromObjectStore(k8s.core, k8s.custom, req.namespace, req.objectStoreName);
        if (result.source === 'unavailable') {
          return {
            ok: false,
            errorCode: 'CATALOGUE_UNAVAILABLE',
            detail: scrubCreds(result.unavailableReason ?? 'object store unavailable'),
            objectStoreName: result.objectStoreName,
            namespace: result.namespace,
          };
        }
        const backups: SnapshotBackupInfo[] = result.backups.map((b) => ({
          backupId: b.backupId,
          status: b.status,
          startedAt: b.startedAt,
          endedAt: b.endedAt,
          dataSizeBytes: b.dataSizeBytes,
          description: b.description ?? null,
          kind: b.kind ?? null,
        }));
        return { ok: true, objectStoreName: result.objectStoreName, namespace: result.namespace, backups };
      } catch (err) {
        return { ok: false, errorCode: 'UNEXPECTED', detail: messageOf(err) };
      }
    },
  };
}
