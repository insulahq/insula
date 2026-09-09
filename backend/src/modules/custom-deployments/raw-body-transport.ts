import type { FastifyInstance } from 'fastify';
import { ApiError } from '../../shared/errors.js';

/**
 * Accept the same JSON body under `application/octet-stream`.
 *
 * A compose document and its env files are, by definition, shell commands and
 * `KEY=value` configuration. Sent as `application/json` the WAF parses them
 * into ARGS and the CRS families match on content the tenant is entitled to
 * submit — measured on DEV 2026-09-09, a realistic compose file plus a `.env`
 * is refused at the edge with a bare 403 the API never sees (933120 on the
 * `.env` lines, 942190 on a `mysql -e` command, aggregated by 949110).
 *
 * `9000108` already removed the 932xxx/934xxx families for this path after an
 * earlier round of the same problem. Excluding 933/941/942 next would just
 * move the treadmill along again — the content is arbitrary, so no finite rule
 * list ever finishes (ADR-060).
 *
 * `application/octet-stream` is never parsed into ARGS, so the payload is
 * structurally invisible to the body rules while URL, method, header and
 * query-string rules keep working. Paired with `9000115`, which allows the
 * content type here (920420 rejects it by default).
 *
 * `application/json` is STILL accepted, deliberately. The panels and the API
 * are separate Deployments, so a rollout has a window where an old panel talks
 * to a new API; dropping JSON would break the editor for the length of that
 * window. Remove it only once no shipped panel sends it.
 *
 * Lives in its own module so the tests can exercise THIS function rather than
 * a hand-copied lookalike — `routes.ts` needs Kubernetes clients to import.
 */
export function registerRawBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'string' },
    (_req, body, done) => {
      const raw = typeof body === 'string' ? body : String(body);
      if (raw.trim() === '') { done(null, {}); return; }
      try {
        done(null, JSON.parse(raw) as unknown);
      } catch {
        // Mirror Fastify's own malformed-JSON shape so the panel's error
        // handling is identical whichever content type it used.
        const err = new ApiError('INVALID_FIELD_VALUE', 'Body is not valid JSON', 400);
        done(err, undefined);
      }
    },
  );
}
