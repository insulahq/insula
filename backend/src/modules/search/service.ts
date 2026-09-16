import type { Database } from '../../db/index.js';
import type { AnyRole } from '../../middleware/auth.js';
import type { SearchGroup } from '@insula/api-contracts';
import { SEARCH_GROUP_LIMIT } from '@insula/api-contracts';
import { SEARCH_PROVIDERS, type SearchContext, type SearchProvider } from './providers.js';

const TENANT_ROLES: ReadonlySet<AnyRole> = new Set<AnyRole>(['tenant_admin', 'tenant_user']);

/**
 * Does this token's `panel` claim agree with its `role` claim?
 *
 * Every other module answers this implicitly, by being mounted behind
 * `requirePanel('admin')` or `requireTenantAccess()`. This endpoint
 * deliberately serves BOTH panels from one URL, so it has to check for
 * itself — and the mismatch is not theoretical:
 *
 *   panel: 'admin' + role: 'tenant_user'
 *
 * selects every provider that lists both panels and any tenant role —
 * domains, deployments, mailboxes, cron jobs, SFTP users, SSH keys. And
 * because `tenantScope()` keys off `panel`, not off `role`, an 'admin'
 * panel claim means NO tenant predicate is applied. That single
 * inconsistent token would read the whole estate's records.
 *
 * Caught by service.test.ts rather than in production. Fail closed.
 */
export function panelMatchesRole(panel: SearchContext['panel'], role: AnyRole): boolean {
  return TENANT_ROLES.has(role) ? panel === 'tenant' : panel === 'admin';
}

/**
 * Which providers this caller is allowed to run.
 *
 * Three conditions, all required: the token is internally consistent,
 * the provider serves this panel, and it lists this role. Panel alone is
 * not enough — a `read_only` admin and a `super_admin` are both on the
 * admin panel and must not see the same groups.
 */
export function providersFor(ctx: SearchContext): readonly SearchProvider[] {
  if (!panelMatchesRole(ctx.panel, ctx.role)) return [];
  return SEARCH_PROVIDERS.filter(
    (p) => p.panels.includes(ctx.panel) && p.roles.includes(ctx.role),
  );
}

/**
 * Run every permitted provider concurrently and collect the non-empty
 * groups.
 *
 * Each provider is asked for `limit + 1` rows so "there are more than we
 * showed" is a fact about the data rather than a guess, then trimmed to
 * `limit`.
 *
 * One provider failing must not blank the whole dropdown — a broken
 * query against one table is not a reason to hide the other twelve
 * groups. A failure is logged and that group is dropped. It is NOT
 * silently rendered as "no results": the caller distinguishes the two by
 * the group being absent rather than present-and-empty, and the UI keeps
 * showing static (page/tab) hits regardless.
 */
export async function runSearch(
  db: Database,
  ctx: SearchContext,
  term: string,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<{ groups: SearchGroup[]; failed: string[] }> {
  const permitted = providersFor(ctx);

  const settled = await Promise.allSettled(
    permitted.map(async (p) => ({
      provider: p,
      items: await p.run(db, ctx, term, SEARCH_GROUP_LIMIT + 1),
    })),
  );

  const groups: SearchGroup[] = [];
  const failed: string[] = [];

  settled.forEach((outcome, i) => {
    const provider = permitted[i];
    if (!provider) return;
    if (outcome.status === 'rejected') {
      failed.push(provider.type);
      // Bound the reason: a driver error can carry the whole failing
      // statement, and the statement contains the user's search term.
      log?.warn(
        { provider: provider.type, reason: String(outcome.reason).slice(0, 200) },
        'search: provider failed',
      );
      return;
    }
    const { items } = outcome.value;
    if (items.length === 0) return;
    groups.push({
      type: provider.type,
      label: provider.label,
      items: items.slice(0, SEARCH_GROUP_LIMIT),
      truncated: items.length > SEARCH_GROUP_LIMIT,
    });
  });

  return { groups, failed };
}
