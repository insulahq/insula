import type { FastifyInstance } from 'fastify';
import { searchQuerySchema } from '@insula/api-contracts';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { runSearch, panelMatchesRole } from './service.js';
import type { SearchContext } from './providers.js';

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  // Populates req.user from the Bearer token. The handler below reads
  // panel/role/tenantId off req.user to decide which providers run and
  // how they are scoped, so without this hook the route would either
  // 401 on every call or — far worse — run with an undefined context.
  // See scripts/ci-route-auth-check.sh for why this is guarded in CI.
  app.addHook('onRequest', authenticate);

  /**
   * GET /api/v1/search?q=…
   *
   * Deliberately NOT gated by requireRole: every authenticated user may
   * search. Authorization is per result group, enforced by each
   * provider's `roles` list, so a read_only admin and a tenant_user hit
   * the same URL and get different data.
   *
   * Its own rate limit rather than the global 100/min bucket: this is a
   * type-ahead endpoint and a user working the box hard should not spend
   * the budget their normal page loads need. Still bounded, so the
   * endpoint cannot be used to hammer the database for free.
   */
  app.get('/search', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      tags: ['Search'],
      summary: 'Global search across records the caller may see',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new ApiError(
        'VALIDATION_ERROR',
        parsed.error.issues[0]?.message ?? 'invalid search query',
        400,
        { field: 'q' },
      );
    }

    const user = request.user;
    if (!user) throw new ApiError('INVALID_TOKEN', 'Authentication required', 401);

    // A tenant-panel token with no tenantId claim cannot be scoped, and an
    // unscoped tenant query returns every tenant's rows. Fail closed here
    // rather than letting a provider decide — the same reasoning as
    // requireTenantAccess() in middleware/auth.ts.
    const panel = user.panel === 'tenant' ? 'tenant' : 'admin';
    if (panel === 'tenant' && !user.tenantId) {
      throw new ApiError(
        'CLIENT_ACCESS_DENIED',
        'Client-panel tokens must carry a tenantId claim',
        403,
      );
    }

    // A token whose role and panel disagree (`panel: 'admin'` carrying
    // `tenant_user`) is malformed, and treating it as an admin token would
    // run the tenant-capable providers with NO tenant predicate. Refuse it
    // outright rather than quietly returning an empty result — a silent
    // empty set reads as "you have nothing", which hides the broken token.
    if (!panelMatchesRole(panel, user.role)) {
      throw new ApiError(
        'PANEL_ACCESS_DENIED',
        'Token role and panel claims disagree',
        403,
      );
    }

    const ctx: SearchContext = {
      panel,
      role: user.role,
      ...(panel === 'tenant' ? { tenantId: user.tenantId } : {}),
    };

    const term = parsed.data.q.trim();
    const { groups } = await runSearch(app.db, ctx, term, app.log);
    return success({ groups });
  });
}
