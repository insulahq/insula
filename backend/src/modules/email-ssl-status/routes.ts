import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { getMailServerHostname } from '../webmail-settings/service.js';
import { probeAllListeners } from './service.js';

/**
 * GET /api/v1/admin/email-settings/ssl-status
 *
 * Returns per-port TLS handshake results for the platform mail server.
 * Cached 30s in-process. Lazy-loaded by the admin Email Settings card —
 * not fired automatically on page load (would slow the admin panel by
 * 6 × ~150ms even when the operator isn't looking at the card).
 *
 * Auth: super_admin or admin (visibility into mail server cert state
 * isn't sensitive in the same way credentials are, but it's still an
 * operator concern, not a tenant concern).
 *
 * Query params:
 *   ?refresh=1 — bypass the cache (forces a fresh handshake)
 */
export async function emailSslStatusRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  app.get<{ Querystring: { refresh?: string } }>(
    '/admin/email-settings/ssl-status',
    async (request) => {
      const hostname = await getMailServerHostname(app.db);
      const bypassCache = request.query.refresh === '1' || request.query.refresh === 'true';
      const statuses = await probeAllListeners(hostname, { bypassCache });
      return success({
        host: hostname,
        listeners: statuses,
        cachedTtlMs: bypassCache ? 0 : 30_000,
      });
    },
  );
}
