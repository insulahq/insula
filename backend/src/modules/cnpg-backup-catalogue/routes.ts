import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { listBackupsFromObjectStore } from './service.js';
import { getWalSummary } from './wal-summary.js';

const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
function validateName(s: string, kind: string): void {
  if (!s || s.length > 253 || !NAME_RE.test(s)) {
    throw new ApiError('INVALID_FIELD_VALUE', `Invalid ${kind} name`, 400, { field: kind });
  }
}

export async function cnpgBackupCatalogueRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  // Match the cnpg-backup-health endpoint exactly — read_only operators
  // performing incident triage should see the same source-of-truth view
  // that powers the health card.
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'read_only'));

  // GET /api/v1/admin/cnpg-backup-catalogue/:namespace/:objectStoreName
  //
  // Object-store source-of-truth listing of barman-cloud backups for the
  // named ObjectStore. Reads via the backup-rclone-shim's local S3
  // endpoint — works EVEN WHEN THE CNPG OPERATOR IS DEAD, because the
  // shim owns the upstream connection (S3/CIFS/NFS/SFTP) independently
  // of the cluster control plane.
  //
  // Response: `source` is 'object-store' on success, 'unavailable' on
  // any failure (CR missing, shim creds missing, LIST timeout). The
  // catalogue NEVER throws; callers always get a structured response.
  app.get('/admin/cnpg-backup-catalogue/:namespace/:objectStoreName', {
    schema: {
      tags: ['CnpgBackupCatalogue'],
      summary: 'List barman-cloud backups by reading the object store directly via the backup-rclone-shim (resilient to CNPG operator outages).',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['namespace', 'objectStoreName'],
        properties: {
          namespace: { type: 'string', minLength: 1, maxLength: 253 },
          objectStoreName: { type: 'string', minLength: 1, maxLength: 253 },
        },
      },
    },
  }, async (request) => {
    const p = request.params as { namespace: string; objectStoreName: string };
    validateName(p.namespace, 'namespace');
    validateName(p.objectStoreName, 'objectStoreName');

    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    const result = await listBackupsFromObjectStore(
      k8s.core,
      k8s.custom,
      p.namespace,
      p.objectStoreName,
      { log: request.log },
    );
    return success(result);
  });
  // GET /api/v1/admin/cnpg-backup-catalogue/:namespace/:objectStoreName/wal-summary
  //
  // How much write-ahead log is retained at the target, and how far back it
  // reaches. Deliberately separate from the catalogue above: that one costs a
  // GET + HEAD per base backup through the shim (minutes on a slow upstream),
  // this one is paginated LISTs and answers in seconds. Bounded by its own
  // deadline and cached for 10 minutes; on failure it returns `readError`
  // rather than throwing, so the panel can SAY it could not measure.
  app.get('/admin/cnpg-backup-catalogue/:namespace/:objectStoreName/wal-summary', {
    schema: {
      tags: ['CnpgBackupCatalogue'],
      summary: 'Summarise retained WAL segments (count, bytes, age range) for an ObjectStore.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['namespace', 'objectStoreName'],
        properties: {
          namespace: { type: 'string', minLength: 1, maxLength: 253 },
          objectStoreName: { type: 'string', minLength: 1, maxLength: 253 },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          // Naming the cluster skips a bucket-wide discovery LIST, which on the
          // rclone shim costs more than the measurement itself.
          cluster: { type: 'string', minLength: 1, maxLength: 253 },
        },
      },
    },
  }, async (request) => {
    const p = request.params as { namespace: string; objectStoreName: string };
    const q = request.query as { cluster?: string };
    validateName(p.namespace, 'namespace');
    validateName(p.objectStoreName, 'objectStoreName');
    if (q.cluster !== undefined) validateName(q.cluster, 'cluster');

    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    // Returns immediately: the walk runs in the background and the response
    // carries `state` so the panel can poll rather than hold a request open.
    const result = getWalSummary(
      k8s.core, k8s.custom, p.namespace, p.objectStoreName,
      { log: request.log, clusterName: q.cluster },
    );
    return success(result);
  });

}
