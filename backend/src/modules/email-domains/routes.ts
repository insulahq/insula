import type { FastifyInstance } from 'fastify';
import { authenticate, isPlatformStaff, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { enableEmailDomainSchema, mailDnsRepairRequestSchema, updateEmailDomainSchema } from '@insula/api-contracts';
import * as service from './service.js';
import { getMailDnsCheck, repairMailDns } from './mail-dns-repair.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { platformEncryptionKey } from '../../shared/platform-encryption-key.js';

const encryptionKey = (): string => platformEncryptionKey();

export async function emailDomainRoutes(app: FastifyInstance): Promise<void> {
  // Phase 2c.5: create the k8s tenant once at plugin registration so
  // we can ensure the webmail Ingress on enable/update.
  let k8s: K8sClients | undefined;
  try {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    k8s = createK8sClients(kubeconfigPath);
  } catch (err) {
    app.log.warn({ err }, 'email-domains: k8s tenant unavailable — webmail ingress provisioning disabled');
    k8s = undefined;
  }

  // ── Admin routes ──
  app.get('/admin/email/domains', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async () => {
    const results = await service.listAllEmailDomains(app.db);
    return success(results);
  });

  // ── Client-scoped routes ──

  // POST /api/v1/tenants/:tenantId/email/domains/:domainId/enable
  app.post('/tenants/:tenantId/email/domains/:domainId/enable', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'tenant_admin'), requireTenantAccess()],
  }, async (request, reply) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    // Phase 2 round-3: instrumentation. The tenant-panel was reporting
    // "Unexpected end of JSON input" for this endpoint and we had no
    // server-side trail. Logging entry/exit lets us prove the handler
    // ran to completion and produced a body.
    app.log.info({ tenantId, domainId }, 'email-domains: enable request received');

    const parsed = enableEmailDomainSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const result = await service.enableEmailForDomain(app.db, tenantId, domainId, parsed.data, encryptionKey(), {
      requireDnsControl: !isPlatformStaff(request.user),
    });
    app.log.info(
      { tenantId, domainId, emailDomainId: result.id },
      'email-domains: enableEmailForDomain completed',
    );

    // Phase 2c.5: provision webmail Ingress (webmail_enabled defaults
    // to true on new email domains). Non-blocking on failure — email
    // itself is functional without the Ingress.
    if (k8s && result.id) {
      try {
        await service.ensureWebmailIngress(app.db, k8s, result.id);
        app.log.info({ emailDomainId: result.id }, 'email-domains: ensureWebmailIngress ok');
      } catch (err) {
        app.log.warn({ err, emailDomainId: result.id }, 'email-domains: ensureWebmailIngress failed');
      }
    }

    // R6 PR 1: a new sender domain needs its throttle/quota objects in
    // Stalwart before the first mailbox submits. Non-blocking; the
    // periodic reconcile self-heals on failure.
    try {
      const { reconcileStalwartSendLimits } = await import('../email-outbound/stalwart-throttles.js');
      await reconcileStalwartSendLimits(app.db, app.log);
    } catch (err) {
      app.log.warn({ err }, 'email-domains: send-limit reconcile failed (non-blocking)');
    }

    // IMPORTANT: return the reply so Fastify does not attempt a second
    // implicit send with an undefined payload.
    return reply.status(201).send(success(result));
  });

  // DELETE /api/v1/tenants/:tenantId/email/domains/:domainId/disable
  app.delete('/tenants/:tenantId/email/domains/:domainId/disable', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'tenant_admin'), requireTenantAccess()],
  }, async (request, reply) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };

    // Remove the webmail ingress BEFORE deleting the email_domain row
    // so we can still look up the hostname from the DB.
    if (k8s) {
      try {
        const existing = await service.getEmailDomain(app.db, tenantId, domainId).catch(() => null);
        if (existing?.id) {
          await service.removeWebmailIngress(app.db, k8s, existing.id);
        }
      } catch (err) {
        app.log.warn({ err, domainId }, 'email-domains: removeWebmailIngress failed');
      }
    }

    await service.disableEmailForDomain(app.db, tenantId, domainId);

    // R6 PR 1: drop the domain's throttle/quota objects from Stalwart.
    try {
      const { reconcileStalwartSendLimits } = await import('../email-outbound/stalwart-throttles.js');
      await reconcileStalwartSendLimits(app.db, app.log);
    } catch (err) {
      app.log.warn({ err }, 'email-domains: send-limit reconcile failed (non-blocking)');
    }

    reply.status(204).send();
  });

  // GET /api/v1/tenants/:tenantId/email/domains
  app.get('/tenants/:tenantId/email/domains', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'tenant_admin'), requireTenantAccess()],
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const results = await service.listEmailDomains(app.db, tenantId);
    return success(results);
  });

  // GET /api/v1/tenants/:tenantId/email/domains/:domainId
  app.get('/tenants/:tenantId/email/domains/:domainId', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'tenant_admin'), requireTenantAccess()],
  }, async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const result = await service.getEmailDomain(app.db, tenantId, domainId);
    return success(result);
  });

  // GET /api/v1/tenants/:tenantId/email/domains/:domainId/disable-preview
  //
  // Round-4 Phase 1: enumeration of everything that will be deleted
  // when the tenant calls DELETE .../disable. Used to populate the
  // confirmation modal in the tenant panel's Settings tab.
  app.get('/tenants/:tenantId/email/domains/:domainId/disable-preview', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'tenant_admin'), requireTenantAccess()],
  }, async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const preview = await service.getEmailDomainDisablePreview(app.db, tenantId, domainId);
    return success(preview);
  });

  // GET /api/v1/tenants/:tenantId/email/domains/:domainId/dns-records
  //
  // Returns the canonical list of DNS records the operator should
  // publish for this email domain. Uses the same builder the
  // provisioning path uses, so there's zero drift. In primary mode
  // these are already live in the platform-managed zone; in cname /
  // secondary mode the operator must publish them manually at their
  // own DNS provider. The `manualRequired` flag in the response
  // tells the UI which banner to show.
  app.get('/tenants/:tenantId/email/domains/:domainId/dns-records', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'tenant_admin'), requireTenantAccess()],
  }, async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const result = await service.getEmailDomainDnsRecords(app.db, tenantId, domainId);
    return success(result);
  });

  // GET /api/v1/tenants/:tenantId/email/domains/:domainId/dns-check
  //
  // The domain's live zone against the platform's mail records: which are
  // missing, and which records of the zone get in their way (a second SPF or
  // DMARC record, an MX at another provider). Reads the zone only where the
  // platform hosts it; elsewhere `checked` is false.
  app.get('/tenants/:tenantId/email/domains/:domainId/dns-check', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'tenant_admin'), requireTenantAccess()],
  }, async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    return success(await getMailDnsCheck(app.db, tenantId, domainId));
  });

  // POST /api/v1/tenants/:tenantId/email/domains/:domainId/dns-records/repair
  //
  // "Re-create mail records": publish the missing ones and remove the records
  // the check marks removable, except the optional ones listed in `keep`.
  // Not for `support` — it changes published DNS.
  app.post('/tenants/:tenantId/email/domains/:domainId/dns-records/repair', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'tenant_admin'), requireTenantAccess()],
  }, async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const parsed = mailDnsRepairRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    return success(await repairMailDns(app.db, tenantId, domainId, parsed.data));
  });

  // GET /api/v1/tenants/:tenantId/email/domains/:domainId/connection-info
  //
  // Server hostname + port table + webmail entry points for this domain —
  // what the tenant panel's "How to connect to your email accounts" guide
  // renders. Read-only; the ports come from MAIL_SERVICE_PORTS in
  // api-contracts, the same table the autodiscover XML is built from.
  app.get('/tenants/:tenantId/email/domains/:domainId/connection-info', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'support', 'tenant_admin'), requireTenantAccess()],
  }, async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const result = await service.getEmailConnectionInfo(app.db, tenantId, domainId);
    return success(result);
  });

  // PATCH /api/v1/tenants/:tenantId/email/domains/:domainId
  app.patch('/tenants/:tenantId/email/domains/:domainId', {
    onRequest: [authenticate, requireRole('super_admin', 'admin', 'tenant_admin'), requireTenantAccess()],
  }, async (request) => {
    const { tenantId, domainId } = request.params as { tenantId: string; domainId: string };
    const parsed = updateEmailDomainSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const result = await service.updateEmailDomain(app.db, tenantId, domainId, parsed.data, encryptionKey());

    // Phase 2c.5: if webmail_enabled was toggled, provision or remove
    // the webmail Ingress accordingly.
    if (k8s && parsed.data.webmail_enabled !== undefined && result?.id) {
      try {
        if (parsed.data.webmail_enabled) {
          await service.ensureWebmailIngress(app.db, k8s, result.id);
        } else {
          await service.removeWebmailIngress(app.db, k8s, result.id);
        }
      } catch (err) {
        app.log.warn({ err, emailDomainId: result.id }, 'email-domains: webmail ingress reconcile failed');
      }
    }

    return success(result);
  });
}
