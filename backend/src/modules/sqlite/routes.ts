/**
 * SQLite file management routes.
 *
 * All routes require authentication and tenant access.
 * SQLite files are queried by executing `sqlite3` inside the file-manager pod
 * which has the tenant's shared PVC mounted at /data/.
 */

import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { authenticate, requireRole, requireTenantAccess, requireTenantRoleByMethod } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { tenants } from '../../db/schema.js';
import * as sqliteService from './service.js';

export async function sqliteRoutes(app: FastifyInstance): Promise<void> {
  // Phase 6: method-aware role guard — read open, writes staff+tenant_admin only
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireTenantRoleByMethod());
  app.addHook('onRequest', requireTenantAccess());

  const getK8s = () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      return { k8sTenants: createK8sClients(kubeconfigPath), kubeconfigPath };
    } catch {
      return undefined;
    }
  };

  function requireK8s() {
    const result = getK8s();
    if (!result) {
      throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not available', 503, {}, 'Check that kubeconfig is configured');
    }
    return result;
  }

  async function resolveNamespace(tenantId: string): Promise<string> {
    const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404, { tenant_id: tenantId });
    return tenant.kubernetesNamespace;
  }

  // POST /api/v1/tenants/:tenantId/sqlite/query
  app.post('/tenants/:tenantId/sqlite/query', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const body = (request.body ?? {}) as { file_path?: string; query?: string };

    if (!body.file_path) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'file_path is required', 400, { field: 'file_path' });
    }
    if (!body.query) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'query is required', 400, { field: 'query' });
    }

    const { k8sTenants, kubeconfigPath } = requireK8s();
    const namespace = await resolveNamespace(tenantId);
    const result = await sqliteService.executeQuery(k8sTenants, kubeconfigPath, namespace, body.file_path, body.query);
    return success(result);
  });

  // GET /api/v1/tenants/:tenantId/sqlite/tables?file_path=path/to/db.sqlite
  app.get('/tenants/:tenantId/sqlite/tables', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const filePath = query.file_path as string | undefined;

    if (!filePath) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'file_path query parameter is required', 400, { field: 'file_path' });
    }

    const { k8sTenants, kubeconfigPath } = requireK8s();
    const namespace = await resolveNamespace(tenantId);
    const tables = await sqliteService.listTables(k8sTenants, kubeconfigPath, namespace, filePath);
    return success(tables);
  });

  // GET /api/v1/tenants/:tenantId/sqlite/table-structure?file_path=...&table=users
  app.get('/tenants/:tenantId/sqlite/table-structure', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const filePath = query.file_path as string | undefined;
    const table = query.table as string | undefined;

    if (!filePath) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'file_path query parameter is required', 400, { field: 'file_path' });
    }
    if (!table) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'table query parameter is required', 400, { field: 'table' });
    }

    const { k8sTenants, kubeconfigPath } = requireK8s();
    const namespace = await resolveNamespace(tenantId);
    const columns = await sqliteService.describeTable(k8sTenants, kubeconfigPath, namespace, filePath, table);
    return success(columns);
  });

  // GET /api/v1/tenants/:tenantId/sqlite/table-data?file_path=...&table=users&limit=50&offset=0&orderBy=id&orderDir=desc
  app.get('/tenants/:tenantId/sqlite/table-data', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const filePath = query.file_path as string | undefined;
    const table = query.table as string | undefined;

    if (!filePath) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'file_path query parameter is required', 400, { field: 'file_path' });
    }
    if (!table) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'table query parameter is required', 400, { field: 'table' });
    }

    const limit = query.limit ? parseInt(String(query.limit), 10) : undefined;
    const offset = query.offset ? parseInt(String(query.offset), 10) : undefined;
    const orderBy = query.orderBy as string | undefined;
    const orderDir = (query.orderDir as string | undefined)?.toLowerCase() === 'desc' ? 'desc' as const : 'asc' as const;

    const { k8sTenants, kubeconfigPath } = requireK8s();
    const namespace = await resolveNamespace(tenantId);
    const result = await sqliteService.browseTable(k8sTenants, kubeconfigPath, namespace, filePath, table, { limit, offset, orderBy, orderDir });
    return success(result);
  });

  // GET /api/v1/tenants/:tenantId/sqlite/row-count?file_path=...&table=users
  app.get('/tenants/:tenantId/sqlite/row-count', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const filePath = query.file_path as string | undefined;
    const table = query.table as string | undefined;

    if (!filePath) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'file_path query parameter is required', 400, { field: 'file_path' });
    }
    if (!table) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'table query parameter is required', 400, { field: 'table' });
    }

    const { k8sTenants, kubeconfigPath } = requireK8s();
    const namespace = await resolveNamespace(tenantId);
    const count = await sqliteService.countRows(k8sTenants, kubeconfigPath, namespace, filePath, table);
    return success({ count });
  });

  // POST /api/v1/tenants/:tenantId/sqlite/export?file_path=...
  app.post('/tenants/:tenantId/sqlite/export', async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    const query = request.query as Record<string, unknown>;
    const filePath = query.file_path as string | undefined;

    if (!filePath) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'file_path query parameter is required', 400, { field: 'file_path' });
    }

    const { k8sTenants, kubeconfigPath } = requireK8s();
    const namespace = await resolveNamespace(tenantId);
    const dump = await sqliteService.exportDatabase(k8sTenants, kubeconfigPath, namespace, filePath);

    const filename = filePath.split('/').pop() ?? 'database';
    reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}-export.sql"`)
      .send(dump);
  });

  // POST /api/v1/tenants/:tenantId/sqlite/import
  app.post('/tenants/:tenantId/sqlite/import', async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const body = (request.body ?? {}) as { file_path?: string; sql?: string };

    if (!body.file_path) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'file_path is required', 400, { field: 'file_path' });
    }
    if (!body.sql) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'SQL content is required', 400, { field: 'sql' });
    }

    const { k8sTenants, kubeconfigPath } = requireK8s();
    const namespace = await resolveNamespace(tenantId);
    const result = await sqliteService.importSql(k8sTenants, kubeconfigPath, namespace, body.file_path, body.sql);
    return success(result);
  });
}
