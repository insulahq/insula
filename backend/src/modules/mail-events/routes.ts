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

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { deriveMailWebhookKey, verifyWebhookSignature } from './hmac.js';
import { ingestMailEvents, type StalwartWebhookEvent } from './ingest.js';
import { getTenantMailUsage } from './usage.js';
import { schedulePollSoon } from './fbl.js';
import { listComplaints, complaintSummary } from './complaints.js';
import { getMailOverview } from './overview.js';

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

    // R4 PR 3: an incoming-report.* event means Stalwart just parsed
    // and stored a report — pull it within seconds instead of waiting
    // for the 5-min tick.
    if (events.some((e) => typeof e.type === 'string' && e.type.startsWith('incoming-report.'))) {
      schedulePollSoon(app.db, request.log);
    }
    // Always 200 — a non-2xx makes non-lossy Stalwart retry the batch
    // until discardAfter, which can only duplicate work.
    return reply.status(200).send({ data: summary });
  });
}

const complaintQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  domain: z.string().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(2048).optional(),
});

export async function mailComplaintRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  // Complaint rows carry PII (original sender/recipient addresses,
  // source IPs) — deliberately NOT exposed to billing/read_only roles.
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support'));

  // GET /api/v1/admin/mail/complaints?tenantId=&domain=&limit=&cursor=
  app.get('/admin/mail/complaints', async (request) => {
    const parsed = complaintQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError('INVALID_FIELD_VALUE', `Validation error: ${first.message} (${first.path.join('.')})`, 400, { field: first.path.join('.') });
    }
    return listComplaints(app.db, parsed.data);
  });

  // GET /api/v1/admin/mail/complaints/summary — per-domain 7d/30d
  // complaint counts + send denominators + rates.
  app.get('/admin/mail/complaints/summary', async () => {
    return success(await complaintSummary(app.db));
  });

  // GET /api/v1/admin/mail/overview — Monitoring -> Mail tab aggregate
  // (send totals, top senders, live queue, protection mode).
  app.get('/admin/mail/overview', async () => {
    return success(await getMailOverview(app.db));
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
