import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { authenticate, requireRole, requireTenantRoleByMethod, requireTenantAccess } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { tenants, domains, ingressRoutes } from '../../db/schema.js';
import {
  createRoute,
  updateRoute,
  deleteRoute,
  listRoutesForDomain,
  getIngressSettings,
  updateIngressSettings,
} from './service.js';
import {
  updateRedirectSettings,
  updateSecuritySettings,
  updateAdvancedSettings,
  listWafLogs,
  mapRouteToResponse,
} from './settings-service.js';
import {
  listProtectedDirs,
  createProtectedDir,
  updateProtectedDir,
  deleteProtectedDir,
  listDirUsers,
  createDirUser,
  deleteDirUser,
  toggleDirUser,
  changeDirUserPassword,
} from './protected-dirs-service.js';
import { deleteProtectedDirIngress } from './annotation-sync.js';
import { reconcileIngress } from '../domains/k8s-ingress.js';
import { ensureDomainCertificate } from '../certificates/service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  createIngressRouteSchema,
  createTenantWafRuleExclusionRequestSchema,
  updateIngressRouteSchema,
  updateRedirectSettingsSchema,
  updateSecuritySettingsSchema,
  updateAdvancedSettingsSchema,
  createRouteProtectedDirSchema,
  updateRouteProtectedDirSchema,
  createAuthUserSchema,
  toggleAuthUserSchema,
  changeAuthUserPasswordSchema,
} from '@insula/api-contracts';
import {
  createExclusionForTenantRoute,
  deleteExclusionForTenantRoute,
  listExclusionsForTenantRoute,
  WafRuleExclusionError,
} from '../waf-rule-exclusions/service.js';
import { reconcileWafExclusions } from '../waf-rule-exclusions/reconciler.js';

// Same minimal shape as security-hardening/routes.ts:userOf — keeps
// the audit `createdBy` field aligned with the rest of the platform
// instead of relying on a `'tenant'` literal that loses context.
interface AuthedRequestForWaf {
  readonly user?: { readonly sub?: string; readonly email?: string };
}
const actorOf = (req: AuthedRequestForWaf): string =>
  req.user?.email ?? req.user?.sub ?? 'unknown';

export async function ingressRouteRoutes(app: FastifyInstance): Promise<void> {
  const getK8s = () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      return createK8sClients(kubeconfigPath);
    } catch {
      return undefined;
    }
  };

  const triggerReconcile = async (tenantId: string) => {
    const k8s = getK8s();
    if (!k8s) return;
    const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, tenantId));
    if (tenant?.kubernetesNamespace) {
      try {
        await reconcileIngress(app.db, k8s, tenantId, tenant.kubernetesNamespace);
      } catch {
        // Non-blocking
      }
    }
  };

  // Triggering route reconciliation. In the Traefik model annotation
  // sync no longer mutates a shared Ingress — the per-route Middlewares
  // are owned by reconcileIngress, which calls buildAllRouteSpecs to
  // rebuild every Middleware + IngressRoute from the current DB state.
  // Callers historically passed routeId; we accept it for API
  // compatibility but ignore it because the full tenant namespace
  // reconciles in one pass anyway.
  const triggerAnnotationSync = async (_routeId: string, tenantId: string) => {
    await triggerReconcile(tenantId);
  };

  // ─── Client-scoped routes ─────────────────────────────────────────────────

  // GET /api/v1/tenants/:tenantId/domains/:domainId/routes
  app.get('/tenants/:tenantId/domains/:domainId/routes', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Routes'],
      summary: 'List ingress routes for a domain',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { domainId } = request.params as { domainId: string };
    const routes = await listRoutesForDomain(app.db, domainId);
    return success(routes);
  });

  // POST /api/v1/tenants/:tenantId/domains/:domainId/routes
  app.post('/tenants/:tenantId/domains/:domainId/routes', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Routes'],
      summary: 'Create an ingress route for a hostname under this domain',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const parsed = createIngressRouteSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }

    const body = parsed.data;
    const route = await createRoute(
      app.db,
      domainId,
      tenantId,
      body.hostname,
      body.deployment_id,
      body.path ?? '/',
      body.private_worker_id,
      body.service_port,
    );
    await triggerReconcile(tenantId);

    // Phase 2c: delegate cert provisioning to the central certificates
    // module. It picks the right ClusterIssuer based on the domain's
    // dnsMode + DNS provider, issues a wildcard when possible, and
    // writes a single Certificate CR per domain (not per-route).
    // Issue the cert as soon as we have ANY backend (deployment or
    // private_worker) so TLS is ready before the user dials in.
    if (body.deployment_id || body.private_worker_id) {
      const k8s = getK8s();
      if (k8s) {
        try {
          await ensureDomainCertificate(app.db, k8s, domainId, app.log);
        } catch (err) {
          // Non-blocking — cert-manager may still issue via Ingress annotation fallback,
          // and the error is already logged in the certificates service.
          app.log.warn({ err, domainId }, 'ingress-routes: ensureDomainCertificate failed (non-blocking)');
        }
      }
    }

    reply.status(201).send(success(route));
  });

  // PATCH /api/v1/tenants/:tenantId/domains/:domainId/routes/:routeId
  app.patch('/tenants/:tenantId/domains/:domainId/routes/:routeId', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Routes'],
      summary: 'Update an ingress route (assign workload, change TLS mode)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId, routeId } = request.params as { tenantId: string; routeId: string };
    const parsed = updateIngressRouteSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }

    const updated = await updateRoute(app.db, routeId, {
      deploymentId: parsed.data.deployment_id,
      privateWorkerId: parsed.data.private_worker_id,
      tlsMode: parsed.data.tls_mode,
      nodeHostname: parsed.data.node_hostname,
      servicePort: parsed.data.service_port,
    }, tenantId);
    await triggerReconcile(tenantId);
    return success(updated);
  });

  // DELETE /api/v1/tenants/:tenantId/domains/:domainId/routes/:routeId
  app.delete('/tenants/:tenantId/domains/:domainId/routes/:routeId', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Routes'],
      summary: 'Delete an ingress route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { tenantId, routeId } = request.params as { tenantId: string; routeId: string };
    await deleteRoute(app.db, routeId);
    await triggerReconcile(tenantId);
    reply.status(204).send();
  });

  // ─── Route-level Settings ─────────────────────────────────────────────────

  // GET /api/v1/tenants/:tenantId/routes/:routeId — single route detail
  app.get('/tenants/:tenantId/routes/:routeId', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Routes'],
      summary: 'Get a single ingress route with all settings',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId, routeId } = request.params as { tenantId: string; routeId: string };
    const [route] = await app.db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
    if (!route) throw new ApiError('ROUTE_NOT_FOUND', 'Ingress route not found', 404);
    // Verify ownership via domain → tenant
    const [domain] = await app.db.select().from(domains).where(and(eq(domains.id, route.domainId), eq(domains.tenantId, tenantId)));
    if (!domain) throw new ApiError('ROUTE_NOT_FOUND', 'Ingress route not found', 404);
    return success(mapRouteToResponse(route));
  });

  // PATCH /api/v1/tenants/:tenantId/routes/:routeId/redirects
  app.patch('/tenants/:tenantId/routes/:routeId/redirects', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route Settings'],
      summary: 'Update redirect settings for a route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId, routeId } = request.params as { tenantId: string; routeId: string };
    const parsed = updateRedirectSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }

    const updated = await updateRedirectSettings(app.db, routeId, tenantId, parsed.data);
    await triggerAnnotationSync(routeId, tenantId);
    return success(updated);
  });

  // PATCH /api/v1/tenants/:tenantId/routes/:routeId/security
  app.patch('/tenants/:tenantId/routes/:routeId/security', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route Settings'],
      summary: 'Update security settings for a route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId, routeId } = request.params as { tenantId: string; routeId: string };
    const parsed = updateSecuritySettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }

    const updated = await updateSecuritySettings(app.db, routeId, tenantId, parsed.data);
    await triggerAnnotationSync(routeId, tenantId);
    return success(updated);
  });

  // PATCH /api/v1/tenants/:tenantId/routes/:routeId/advanced
  app.patch('/tenants/:tenantId/routes/:routeId/advanced', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route Settings'],
      summary: 'Update advanced settings for a route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId, routeId } = request.params as { tenantId: string; routeId: string };
    const parsed = updateAdvancedSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }

    const updated = await updateAdvancedSettings(app.db, routeId, tenantId, parsed.data);
    await triggerAnnotationSync(routeId, tenantId);
    return success(updated);
  });

  // ─── Protected Directories ──────────────────────────────────────────────

  // GET /api/v1/tenants/:tenantId/routes/:routeId/protected-dirs
  app.get('/tenants/:tenantId/routes/:routeId/protected-dirs', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route Protected Dirs'],
      summary: 'List protected directories for a route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { routeId } = request.params as { routeId: string };
    const dirs = await listProtectedDirs(app.db, routeId);
    return success(dirs);
  });

  // POST /api/v1/tenants/:tenantId/routes/:routeId/protected-dirs
  app.post('/tenants/:tenantId/routes/:routeId/protected-dirs', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route Protected Dirs'],
      summary: 'Create a protected directory for a route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { tenantId, routeId } = request.params as { tenantId: string; routeId: string };
    const parsed = createRouteProtectedDirSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }

    const dir = await createProtectedDir(app.db, routeId, tenantId, parsed.data);
    await triggerAnnotationSync(routeId, tenantId);
    reply.status(201).send(success(dir));
  });

  // PATCH /api/v1/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId
  app.patch('/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route Protected Dirs'],
      summary: 'Update a protected directory',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId, routeId, dirId } = request.params as { tenantId: string; routeId: string; dirId: string };
    const parsed = updateRouteProtectedDirSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }

    const updated = await updateProtectedDir(app.db, dirId, routeId, tenantId, parsed.data);
    await triggerAnnotationSync(routeId, tenantId);
    return success(updated);
  });

  // DELETE /api/v1/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId
  app.delete('/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route Protected Dirs'],
      summary: 'Delete a protected directory',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { tenantId, routeId, dirId } = request.params as { tenantId: string; routeId: string; dirId: string };
    await deleteProtectedDir(app.db, dirId, routeId, tenantId);

    // Explicitly delete the child Ingress + Secret for this directory
    const k8s = getK8s();
    if (k8s) {
      const [tenant] = await app.db.select().from(tenants).where(eq(tenants.id, tenantId));
      if (tenant?.kubernetesNamespace) {
        try {
          await deleteProtectedDirIngress(k8s, tenant.kubernetesNamespace, dirId);
        } catch { /* Non-blocking */ }
      }
    }

    await triggerAnnotationSync(routeId, tenantId);
    reply.status(204).send();
  });

  // ─── Directory-Scoped Auth Users ──────────────────────────────────────────

  // GET /api/v1/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId/users
  app.get('/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId/users', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route Protected Dirs'],
      summary: 'List auth users for a protected directory',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { dirId } = request.params as { dirId: string };
    const users = await listDirUsers(app.db, dirId);
    return success(users);
  });

  // POST /api/v1/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId/users
  app.post('/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId/users', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route Protected Dirs'],
      summary: 'Create an auth user for a protected directory',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { tenantId, routeId, dirId } = request.params as { tenantId: string; routeId: string; dirId: string };
    const parsed = createAuthUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }

    const user = await createDirUser(app.db, dirId, parsed.data.username, parsed.data.password);
    await triggerAnnotationSync(routeId, tenantId);
    reply.status(201).send(success(user));
  });

  // DELETE /api/v1/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId/users/:userId
  app.delete('/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId/users/:userId', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route Protected Dirs'],
      summary: 'Delete an auth user from a protected directory',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { tenantId, routeId, dirId, userId } = request.params as { tenantId: string; routeId: string; dirId: string; userId: string };
    await deleteDirUser(app.db, dirId, userId);
    await triggerAnnotationSync(routeId, tenantId);
    reply.status(204).send();
  });

  // POST /api/v1/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId/users/:userId/toggle
  app.post('/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId/users/:userId/toggle', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route Protected Dirs'],
      summary: 'Enable/disable an auth user in a protected directory',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId, routeId, dirId, userId } = request.params as { tenantId: string; routeId: string; dirId: string; userId: string };
    const parsed = toggleAuthUserSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }

    await toggleDirUser(app.db, dirId, userId, parsed.data.enabled);
    await triggerAnnotationSync(routeId, tenantId);
    return success({ message: 'User toggled' });
  });

  // POST /api/v1/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId/users/:userId/change-password
  app.post('/tenants/:tenantId/routes/:routeId/protected-dirs/:dirId/users/:userId/change-password', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route Protected Dirs'],
      summary: 'Change password for an auth user in a protected directory',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { tenantId, routeId, dirId, userId } = request.params as { tenantId: string; routeId: string; dirId: string; userId: string };
    const parsed = changeAuthUserPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }

    await changeDirUserPassword(app.db, dirId, userId, parsed.data.password);
    await triggerAnnotationSync(routeId, tenantId);
    return success({ message: 'Password changed' });
  });

  // ─── WAF Logs ─────────────────────────────────────────────────────────────

  // GET /api/v1/tenants/:tenantId/routes/:routeId/waf-logs
  app.get('/tenants/:tenantId/routes/:routeId/waf-logs', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route WAF'],
      summary: 'List WAF logs for a route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { routeId } = request.params as { routeId: string };
    const query = request.query as { limit?: string };
    const limit = query.limit ? Math.min(Number(query.limit), 100) : 50;
    const logs = await listWafLogs(app.db, routeId, limit);
    return success(logs);
  });

  // ─── WAF Exclusions (B2 — tenant-scoped) ──────────────────────────────────
  //
  // Tenants can self-manage CRS rule exclusions for ONE of their routes.
  // The server forces hostnameRegex = `^<route.hostname>$` so a tenant
  // can never whitelist a rule on a domain they don't own. Each mutation
  // triggers an inline reconcile of the shared modsec-crs sidecar's
  // exclusions ConfigMap so the change applies within seconds; the
  // 5-min scheduler covers drift.

  const triggerWafExclusionReconcile = async (): Promise<void> => {
    const k8s = getK8s();
    if (!k8s) return;
    try {
      await reconcileWafExclusions(app.db, { core: k8s.core, apps: k8s.apps }, app.log);
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'tenant-waf-exclusion: inline reconcile failed (scheduler will retry)',
      );
    }
  };

  const wafExclusionErrorToReply = (err: unknown): {
    status: number;
    body: { error: { code: string; message: string } };
  } => {
    if (err instanceof WafRuleExclusionError) {
      // NOT_TENANT_OWNED collapses to 404 so we don't leak the existence
      // of admin-scoped row UUIDs to tenants who happen to guess one.
      // ROUTE_NOT_FOUND already returns 404; this just keeps the two
      // "the resource doesn't exist for you" paths indistinguishable.
      const status =
        err.code === 'ROUTE_NOT_FOUND' || err.code === 'NOT_FOUND' || err.code === 'NOT_TENANT_OWNED' ? 404
        : err.code === 'DUPLICATE' || err.code === 'OVER_CAPACITY' ? 409
        : 400;
      return { status, body: { error: { code: err.code, message: err.message } } };
    }
    throw err;
  };

  // GET /api/v1/tenants/:tenantId/routes/:routeId/waf-exclusions
  app.get('/tenants/:tenantId/routes/:routeId/waf-exclusions', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route WAF'],
      summary: 'List WAF rule exclusions owned by this tenant for this route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { tenantId, routeId } = request.params as { tenantId: string; routeId: string };
    try {
      const exclusions = await listExclusionsForTenantRoute(app.db, tenantId, routeId);
      return success({ exclusions });
    } catch (err) {
      const { status, body } = wafExclusionErrorToReply(err);
      return reply.status(status).send(body);
    }
  });

  // POST /api/v1/tenants/:tenantId/routes/:routeId/waf-exclusions
  app.post('/tenants/:tenantId/routes/:routeId/waf-exclusions', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route WAF'],
      summary: 'Add a tenant-scoped WAF rule exclusion for this route',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { tenantId, routeId } = request.params as { tenantId: string; routeId: string };
    const parsed = createTenantWafRuleExclusionRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_BODY',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
    }
    const actor = actorOf(request as unknown as AuthedRequestForWaf);
    try {
      const created = await createExclusionForTenantRoute(
        app.db,
        tenantId,
        routeId,
        parsed.data,
        actor,
      );
      app.log.warn(
        { actor, tenantId, routeId, exclusion: created },
        'tenant-waf-exclusion: created',
      );
      // Fire-and-forget reconcile — the rendered ConfigMap picks up the
      // new row + the modsec-crs Deployment rolls. We don't await
      // pod-ready; the 5-min scheduler is the safety net.
      await triggerWafExclusionReconcile();
      return success(created);
    } catch (err) {
      const { status, body } = wafExclusionErrorToReply(err);
      return reply.status(status).send(body);
    }
  });

  // DELETE /api/v1/tenants/:tenantId/routes/:routeId/waf-exclusions/:id
  app.delete('/tenants/:tenantId/routes/:routeId/waf-exclusions/:id', {
    onRequest: [authenticate, requireTenantRoleByMethod(), requireTenantAccess()],
    schema: {
      tags: ['Ingress Route WAF'],
      summary: 'Delete a tenant-owned WAF rule exclusion',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { tenantId, routeId, id } = request.params as {
      tenantId: string;
      routeId: string;
      id: string;
    };
    try {
      await deleteExclusionForTenantRoute(app.db, tenantId, routeId, id);
      app.log.warn({ tenantId, routeId, id }, 'tenant-waf-exclusion: deleted');
      await triggerWafExclusionReconcile();
      return success({ deleted: true });
    } catch (err) {
      const { status, body } = wafExclusionErrorToReply(err);
      return reply.status(status).send(body);
    }
  });

  // ─── Client-facing: Ingress Base Domain ──────────────────────────────────
  // Exposes only the public ingress base domain so the tenant panel can display
  // the correct CNAME target label without calling the admin-only settings endpoint.

  app.get('/platform/ingress-base-domain', {
    onRequest: [authenticate],
    schema: {
      tags: ['Ingress Settings'],
      summary: 'Get the public ingress base domain (tenant-accessible)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const settings = await getIngressSettings(app.db);
    return success({ ingressBaseDomain: settings.ingressBaseDomain });
  });

  // ─── Admin: Ingress Settings ──────────────────────────────────────────────

  app.get('/admin/ingress-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Ingress Settings'],
      summary: 'Get platform ingress routing settings',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    return success(await getIngressSettings(app.db));
  });

  app.patch('/admin/ingress-settings', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Ingress Settings'],
      summary: 'Update platform ingress routing settings',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const body = request.body as {
      ingressBaseDomain?: string;
      ingressDefaultIpv4?: string;
      ingressDefaultIpv6?: string | null;
    };
    return success(await updateIngressSettings(app.db, body));
  });
}
