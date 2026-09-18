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
import { dmarcDomainSummaries, dmarcSourcesForDomain, DMARC_WINDOW_DAYS } from './dmarc-summary.js';
import { DMARC_LOCAL_PART } from './report-intake-reconciler.js';
import { dmarcSourcesQuerySchema, type DmarcOverview } from '@insula/api-contracts';

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { deriveMailWebhookKey, verifyWebhookSignature } from './hmac.js';
import { ingestMailEvents, type StalwartWebhookEvent } from './ingest.js';
import { getTenantMailUsage } from './usage.js';
import { schedulePollSoon } from './dmarc.js';
import { getMailOverview } from './overview.js';

export async function mailEventsWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Encapsulated: raw-buffer JSON so the HMAC covers exactly the bytes
  // Stalwart signed.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // rateLimit:false — Stalwart POSTs telemetry BATCHES here, unauthenticated
  // by JWT (the HMAC over the raw body is the auth), so the global limiter
  // keyed every batch from the whole mail stack onto one pod IP: 100/min for
  // the entire platform. Past that, events were rejected with a 429 and the
  // telemetry simply went missing — a silent gap in operator-visible data,
  // worst exactly when mail is busiest. verifyWebhookSignature is the control.
  app.post('/internal/mail/events', { config: { rateLimit: false } }, async (request, reply) => {
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

// Window only — the domain list is not filterable here on purpose: an
// operator looking at DMARC wants the whole estate, and a filtered view that
// hides a failing domain is the wrong default.
const dmarcOverviewQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
});

/**
 * Mail overview + DMARC aggregate reports.
 *
 * Was `mailComplaintRoutes`; the two `/admin/mail/complaints*` endpoints went
 * with the FBL retirement and the name would otherwise describe
 * routes that no longer exist.
 */
export async function mailReportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  // Report rows carry PII (reported source IPs, policy domains) —
  // deliberately NOT exposed to billing/read_only roles.
  app.addHook('onRequest', requireRole('super_admin', 'admin', 'support'));

  // GET /api/v1/admin/mail/overview — Monitoring -> Mail tab aggregate
  // (send totals, top senders, live queue, protection mode).
  // ── ROADMAP R5: DMARC aggregate reports ──────────────────────────────
  //
  // Read-only. Nothing here rewrites a published DMARC policy — the
  // recommendation is for an operator to act on, because `p=reject` on a
  // domain with one legitimate unaligned sender stops that sender's mail
  // immediately rather than degrading.
  app.get('/admin/mail/dmarc', async (request) => {
    const q = dmarcOverviewQuerySchema.safeParse(request.query ?? {});
    const windowDays = q.success ? (q.data.windowDays ?? DMARC_WINDOW_DAYS) : DMARC_WINDOW_DAYS;
    const domains = await dmarcDomainSummaries(app.db, { windowDays });
    const overview: DmarcOverview = {
      windowDays,
      domains,
      intakeLocalPart: DMARC_LOCAL_PART,
    };
    return success(overview);
  });

  app.get('/admin/mail/dmarc/sources', async (request) => {
    const parsed = dmarcSourcesQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${first.message} (${first.path.join('.')})`,
        400,
        { field: first.path.join('.') },
      );
    }
    const sources = await dmarcSourcesForDomain(app.db, parsed.data.domain, {
      windowDays: parsed.data.windowDays,
      limit: parsed.data.limit,
    });
    return success(sources);
  });

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

  // ── DMARC results, for the domain owner ──────────────────────────────────
  //
  // The platform has ingested per-tenant DMARC aggregate reports for months
  // and showed them to NOBODY but the operator: the only endpoints were
  // /admin/mail/dmarc and /admin/mail/dmarc/sources. `dmarcDomainSummaries`
  // has accepted a `tenantId` all along and nothing ever passed one. So a
  // domain owner could not see who was sending as their domain, or whether
  // their own mail was passing — which is the entire point of DMARC for them.
  app.get('/tenants/:tenantId/mail/dmarc', {
    onRequest: [
      authenticate,
      requireRole('super_admin', 'admin', 'support', 'tenant_admin', 'tenant_user'),
      requireTenantAccess(),
    ],
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const q = dmarcOverviewQuerySchema.safeParse(request.query ?? {});
    const windowDays = q.success ? (q.data.windowDays ?? DMARC_WINDOW_DAYS) : DMARC_WINDOW_DAYS;
    const domains = await dmarcDomainSummaries(app.db, { windowDays, tenantId });
    const overview: DmarcOverview = {
      windowDays,
      domains,
      intakeLocalPart: DMARC_LOCAL_PART,
    };
    return success(overview);
  });

  app.get('/tenants/:tenantId/mail/dmarc/sources', {
    onRequest: [
      authenticate,
      requireRole('super_admin', 'admin', 'support', 'tenant_admin', 'tenant_user'),
      requireTenantAccess(),
    ],
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const parsed = dmarcSourcesQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${first.message} (${first.path.join('.')})`,
        400,
        { field: first.path.join('.') },
      );
    }
    // `domain` comes from the query string, so it is NOT trusted. Isolation
    // comes from scoping the ROWS to this tenant: naming another tenant's
    // domain returns an empty list, never their data. There is deliberately no
    // separate ownership lookup — it would turn that empty result into a
    // clearer 404, but it is not what makes this safe, and a comment claiming
    // two locks where the code has one is how a reviewer stops looking.
    const sources = await dmarcSourcesForDomain(app.db, parsed.data.domain, {
      windowDays: parsed.data.windowDays,
      limit: parsed.data.limit,
      tenantId,
    });
    return success({
      domain: parsed.data.domain,
      windowDays: parsed.data.windowDays ?? DMARC_WINDOW_DAYS,
      sources,
    });
  });
}
