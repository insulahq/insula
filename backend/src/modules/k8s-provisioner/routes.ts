import type { FastifyInstance } from 'fastify';
import { eq, inArray, desc } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { triggerProvisionSchema } from '@k8s-hosting/api-contracts';
import { tenants, provisioningTasks } from '../../db/schema.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from './k8s-client.js';
import { runProvisionNamespace, runDeprovision, mirrorProvisioningToTaskTracker, PROVISION_STEPS, DEPROVISION_STEPS, buildStepsLog } from './service.js';

export async function provisioningRoutes(app: FastifyInstance): Promise<void> {
  // All provisioning routes require auth + admin role
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // POST /api/v1/admin/tenants/:tenantId/provision
  // Triggers async namespace provisioning
  app.post('/admin/tenants/:tenantId/provision', {
    schema: {
      tags: ['Provisioning'],
      summary: 'Trigger namespace provisioning for a tenant',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['tenantId'],
        properties: { tenantId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };

    // Validate body
    const parsed = triggerProvisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    // Verify tenant exists
    const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) {
      throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404, { tenant_id: tenantId });
    }

    // Check if already provisioning
    if (tenant.provisioningStatus === 'provisioning') {
      throw new ApiError('ALREADY_PROVISIONING', 'Tenant is already being provisioned', 409);
    }

    // Create task record
    const taskId = crypto.randomUUID();
    const stepsLog = buildStepsLog(PROVISION_STEPS);

    await app.db.insert(provisioningTasks).values({
      id: taskId,
      tenantId,
      type: 'provision_namespace',
      status: 'pending',
      totalSteps: PROVISION_STEPS.length,
      completedSteps: 0,
      stepsLog,
      startedBy: request.user!.sub,
    });
    // Best-effort enroll into the chip so the operator sees the task
    // running before runProvisionNamespace's first state update.
    await mirrorProvisioningToTaskTracker(app.db, taskId).catch((err) => {
      app.log.warn({ err, taskId }, 'task tracker enroll failed (non-fatal)');
    });

    // Fire-and-forget: run provisioning in background
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8sTenants = createK8sClients(kubeconfigPath);

    // Don't await — this runs async
    runProvisionNamespace(app.db, k8sTenants, taskId, tenantId, parsed.data).catch((err) => {
      app.log.error({ err, taskId, tenantId }, 'Provisioning failed unexpectedly');
    });

    reply.status(202);
    return success({
      taskId,
      tenantId,
      status: 'pending',
      totalSteps: PROVISION_STEPS.length,
    });
  });

  // GET /api/v1/admin/tenants/:tenantId/provision/status
  // Returns the latest provisioning task for this tenant
  app.get('/admin/tenants/:tenantId/provision/status', {
    schema: {
      tags: ['Provisioning'],
      summary: 'Get provisioning status for a tenant',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['tenantId'],
        properties: { tenantId: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };

    const [task] = await app.db.select()
      .from(provisioningTasks)
      .where(eq(provisioningTasks.tenantId, tenantId))
      .orderBy(desc(provisioningTasks.createdAt))
      .limit(1);

    if (!task) {
      throw new ApiError('TASK_NOT_FOUND', 'No provisioning task found for this tenant', 404);
    }

    return success({
      id: task.id,
      tenantId: task.tenantId,
      type: task.type,
      status: task.status,
      currentStep: task.currentStep,
      totalSteps: task.totalSteps,
      completedSteps: task.completedSteps,
      stepsLog: typeof task.stepsLog === 'string' ? JSON.parse(task.stepsLog) : task.stepsLog,
      errorMessage: task.errorMessage,
      startedBy: task.startedBy,
      startedAt: task.startedAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    });
  });

  // GET /api/v1/admin/provisioning/tasks
  // Returns all active (pending/running) provisioning tasks — for header indicator
  app.get('/admin/provisioning/tasks', {
    schema: {
      tags: ['Provisioning'],
      summary: 'List active provisioning tasks',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const activeTasks = await app.db.select()
      .from(provisioningTasks)
      .where(inArray(provisioningTasks.status, ['pending', 'running']));

    // Enrich with tenant company names
    const tenantIds = [...new Set(activeTasks.map(t => t.tenantId))];
    const tenantMap = new Map<string, string>();

    if (tenantIds.length > 0) {
      const tenantRows = await app.db.select()
        .from(tenants)
        .where(inArray(tenants.id, tenantIds));
      for (const c of tenantRows) {
        tenantMap.set(c.id, c.name);
      }
    }

    const tasks = activeTasks.map(t => ({
      id: t.id,
      tenantId: t.tenantId,
      name: tenantMap.get(t.tenantId) ?? 'Unknown',
      type: t.type,
      status: t.status,
      currentStep: t.currentStep,
      completedSteps: t.completedSteps,
      totalSteps: t.totalSteps,
    }));

    return success({
      count: tasks.length,
      tasks,
    });
  });

  // POST /api/v1/admin/tenants/:tenantId/decommission
  // Deletes the K8s namespace and all resources inside it
  app.post('/admin/tenants/:tenantId/decommission', {
    schema: {
      tags: ['Provisioning'],
      summary: 'Decommission a tenant — delete K8s namespace and all resources',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['tenantId'],
        properties: { tenantId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };

    const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) {
      throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404, { tenant_id: tenantId });
    }

    // Only allow decommission for suspended tenants
    if (tenant.status !== 'suspended') {
      throw new ApiError('CLIENT_NOT_SUSPENDED', 'Tenant must be suspended before decommissioning', 409);
    }

    // Must be provisioned (or failed) to decommission
    if (tenant.provisioningStatus === 'unprovisioned') {
      throw new ApiError('NOT_PROVISIONED', 'Tenant is not provisioned — nothing to decommission', 409);
    }

    if (tenant.provisioningStatus === 'provisioning') {
      throw new ApiError('ALREADY_PROVISIONING', 'Cannot decommission while provisioning is in progress', 409);
    }

    const taskId = crypto.randomUUID();
    const stepsLog = buildStepsLog(DEPROVISION_STEPS);

    await app.db.insert(provisioningTasks).values({
      id: taskId,
      tenantId,
      type: 'deprovision',
      status: 'pending',
      totalSteps: DEPROVISION_STEPS.length,
      completedSteps: 0,
      stepsLog,
      startedBy: request.user!.sub,
    });
    await mirrorProvisioningToTaskTracker(app.db, taskId).catch((err) => {
      app.log.warn({ err, taskId }, 'task tracker enroll failed (non-fatal)');
    });

    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8sTenants = createK8sClients(kubeconfigPath);

    runDeprovision(app.db, k8sTenants, taskId, tenantId).catch((err) => {
      app.log.error({ err, taskId, tenantId }, 'Decommission failed unexpectedly');
    });

    reply.status(202);
    return success({
      taskId,
      tenantId,
      status: 'pending',
      totalSteps: DEPROVISION_STEPS.length,
    });
  });
}
