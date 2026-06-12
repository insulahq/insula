/**
 * Mail-events routes (R6 PR 2).
 *
 *   POST /api/v1/internal/mail/events
 *     Stalwart webhook receiver. Auth = HMAC X-Signature over the RAW
 *     body (key derived from PLATFORM_INTERNAL_SECRET — see hmac.ts);
 *     the L3/L4 boundary is the dedicated NetworkPolicy admitting only
 *     the stalwart pod from the mail namespace. No bearer token: the
 *     caller is a mail server, not a user.
 *
 *   GET /api/v1/tenants/:tenantId/mail/usage
 *     Current-hour/day usage vs effective limits, for the tenant panel
 *     and admin views.
 *
 * The webhook plugin registers its own application/json content-type
 * parser (parseAs: 'buffer') — Fastify parsers are encapsulated per
 * plugin, so the rest of the app keeps the default JSON parser. The
 * raw buffer is required for signature verification.
 */

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { deriveMailWebhookKey, verifyWebhookSignature } from './hmac.js';
import { ingestMailEvents, type StalwartWebhookEvent } from './ingest.js';
import { getTenantMailUsage } from './usage.js';

export async function mailEventsWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Encapsulated: raw-buffer JSON so the HMAC covers exactly the bytes
  // Stalwart signed.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/internal/mail/events', async (request, reply) => {
    const master = process.env.PLATFORM_INTERNAL_SECRET;
    if (!master) {
      // Misconfiguration — fail closed, loudly.
      request.log.error('mail-events: PLATFORM_INTERNAL_SECRET unset; rejecting webhook');
      return reply.status(503).send({ error: 'webhook receiver not configured' });
    }

    const rawBody = request.body as Buffer;
    const signature = request.headers['x-signature'];
    const key = deriveMailWebhookKey(master);
    if (!Buffer.isBuffer(rawBody) || !verifyWebhookSignature(rawBody, typeof signature === 'string' ? signature : undefined, key)) {
      request.log.warn({ hasSignature: Boolean(signature) }, 'mail-events: webhook signature rejected');
      return reply.status(401).send({ error: 'invalid signature' });
    }

    let events: StalwartWebhookEvent[];
    try {
      const parsed = JSON.parse(rawBody.toString('utf8')) as { events?: unknown };
      events = Array.isArray(parsed.events) ? (parsed.events as StalwartWebhookEvent[]) : [];
    } catch {
      return reply.status(400).send({ error: 'invalid JSON' });
    }

    const summary = await ingestMailEvents(app.db, events);
    if (summary.counted > 0) {
      request.log.debug(summary, 'mail-events: ingested webhook batch');
    }
    // Always 200 — a non-2xx makes non-lossy Stalwart retry the batch
    // until discardAfter, which can only duplicate work.
    return reply.status(200).send({ data: summary });
  });
}

export async function mailUsageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tenants/:tenantId/mail/usage', {
    onRequest: [
      authenticate,
      requireRole('super_admin', 'admin', 'support', 'tenant_admin'),
      requireTenantAccess(),
    ],
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    return success(await getTenantMailUsage(app.db, tenantId));
  });
}
