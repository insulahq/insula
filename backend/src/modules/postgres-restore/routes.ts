import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  promotePostgresFromSnapshot,
  isPostgresRestoreInProgressClusterWide,
  acquirePitrLockOrThrow,
  type PitrStep,
} from './service.js';

const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
function validateName(s: string, kind: string): void {
  if (!s || s.length > 253 || !NAME_RE.test(s)) {
    throw new ApiError('INVALID_FIELD_VALUE', `Invalid ${kind} name`, 400, { field: kind });
  }
}

export async function postgresRestoreRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/postgres-restore/status
  // Returns whether a PITR is currently in flight. The CNPG-write
  // lockout middleware reads this to gate other postgres-mutating
  // routes during restore.
  app.get('/admin/postgres-restore/status', async () => {
    return success(await isPostgresRestoreInProgressClusterWide(app.db));
  });

  // POST /api/v1/admin/postgres-restore
  // Body: { clusterNamespace, clusterName, snapshotName, recoveryTargetTime? }
  //
  // ASYNC: returns 202 immediately after preflight passes. The
  // orchestration runs in the background (~5-10 min). Poll
  // GET /admin/postgres-restore/status for progress + final result.
  //
  // Why async: nginx ingress kills synchronous requests after ~5 min
  // (proxy_read_timeout). Even if we extend that, holding an HTTP
  // connection across the cutover (when source postgres is briefly
  // unreachable) was producing 502s for the operator. Detaching the
  // orchestration from the request lifecycle decouples HTTP from the
  // long-running CNPG bootstrap dance. recoverInterruptedRestore at
  // platform-api startup picks up any in-flight orchestration that
  // crashed mid-flight.
  app.post('/admin/postgres-restore', {
    schema: {
      tags: ['PostgresRestore'],
      summary: 'PITR restore (async): bootstrap from a Longhorn snapshot, optionally with WAL replay, then auto-promote (replace source cluster). Returns 202 immediately; poll /status for progress.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['clusterNamespace', 'clusterName', 'snapshotName'],
        properties: {
          clusterNamespace: { type: 'string', minLength: 1, maxLength: 253 },
          clusterName: { type: 'string', minLength: 1, maxLength: 253 },
          snapshotName: { type: 'string', minLength: 1, maxLength: 253 },
          recoveryTargetTime: { type: 'string', format: 'date-time' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      clusterNamespace: string;
      clusterName: string;
      snapshotName: string;
      recoveryTargetTime?: string;
    };
    validateName(body.clusterNamespace, 'clusterNamespace');
    validateName(body.clusterName, 'clusterName');
    validateName(body.snapshotName, 'snapshotName');

    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    const actor = (request as unknown as { user?: { sub?: string } }).user;

    // Race-safe lock acquisition. acquirePitrLockOrThrow does:
    //   1. cluster-wide check (in-memory + DB)
    //   2. SYNCHRONOUS in-memory set (no awaits between check and set)
    //   3. DB lock write
    // If two POSTs arrive in the same Node event-loop tick, only the
    // first reaches step 2 — the second sees the in-memory lock and
    // gets 409. This closes the race window the prior `void
    // promotePostgresFromSnapshot(...)` left open (where the route
    // returned 202 before the detached function had set its lock).
    try {
      await acquirePitrLockOrThrow(app.db, {
        clusterNamespace: body.clusterNamespace,
        clusterName: body.clusterName,
        snapshotName: body.snapshotName,
      });
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 409) {
        throw new ApiError('PITR_PRECONDITION_FAILED', (err as Error).message, 409);
      }
      throw err;
    }

    // Lock is held. Detach the orchestration — it sees `activeRestore`
    // already set and skips its own lock acquisition. Errors are
    // logged + admin-notified by the orchestrator's catch block; the
    // finally block always releases both locks.
    void promotePostgresFromSnapshot(
      { k8s, db: app.db, kubeconfigPath: kc },
      {
        clusterNamespace: body.clusterNamespace,
        clusterName: body.clusterName,
        snapshotName: body.snapshotName,
        recoveryTargetTime: body.recoveryTargetTime ?? null,
        actorUserId: actor?.sub ?? null,
      },
    ).catch((err: Error & { steps?: readonly PitrStep[] }) => {
      app.log.error(
        { err, steps: err.steps, snapshot: body.snapshotName },
        'PITR background orchestration failed',
      );
    });

    reply.code(202);
    return success({
      status: 'started',
      clusterNamespace: body.clusterNamespace,
      clusterName: body.clusterName,
      snapshotName: body.snapshotName,
      recoveryTargetTime: body.recoveryTargetTime ?? null,
      pollUrl: '/api/v1/admin/postgres-restore/status',
      message: 'PITR orchestration started in background (~5-10 min). Poll status for progress + final result.',
    });
  });
}
