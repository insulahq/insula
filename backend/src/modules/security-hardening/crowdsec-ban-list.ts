/**
 * The Banned IPs list, as the rest of the platform consumes it.
 *
 * Two things live here because both need something the LAPI fetch in
 * crowdsec.ts does not have:
 *
 *   attachOperatorNames     — the DATABASE, to turn the user id an operator ban
 *                             carries in its scenario into a person's name.
 *   countActivePlatformBans — the list's own definition of "banned", for the
 *                             dashboard tile, so the tile and the list it
 *                             links to cannot disagree again.
 */
import { inArray } from 'drizzle-orm';
import { crowdsecDecisionAddressKey } from '@insula/api-contracts';
import type { CrowdsecDecision } from '@insula/api-contracts';
import { users } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { listDecisions, parseOperatorScenario } from './crowdsec.js';

/** "Full Name (email)", or whichever half exists. Same shape as the panel's UserLabel. */
export function formatOperatorName(u: { fullName: string | null; email: string | null }): string | null {
  const name = u.fullName?.trim() ?? '';
  const email = u.email?.trim() ?? '';
  if (name && email) return `${name} (${email})`;
  return name || email || null;
}

/**
 * Fill `addedByName` on every operator and permanent ban.
 *
 * One query for all distinct actors on the page, and none at all when the
 * list holds no operator bans — the common case, since most rows come from the
 * two automatic engines. An actor that resolves to nobody (a deleted account)
 * keeps `addedByName: null`; the raw id is never substituted, because the
 * panel would then print it.
 */
export async function attachOperatorNames(
  db: Pick<Database, 'select'>,
  decisions: readonly CrowdsecDecision[],
): Promise<CrowdsecDecision[]> {
  const actorOf = new Map<number, string>();
  for (const d of decisions) {
    const actor = parseOperatorScenario(d.origin, d.scenario)?.actor;
    if (actor) actorOf.set(d.id, actor);
  }
  if (actorOf.size === 0) return decisions.map((d) => ({ ...d }));

  const ids = [...new Set(actorOf.values())];
  const rows = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  const nameOf = new Map(rows.map((r) => [r.id, formatOperatorName(r)]));

  return decisions.map((d) => {
    const actor = actorOf.get(d.id);
    return { ...d, addedByName: actor ? nameOf.get(actor) ?? null : d.addedByName };
  });
}

/** Distinct addresses — one per row of the Banned IPs list. */
export function countBannedAddresses(decisions: readonly CrowdsecDecision[]): number {
  return new Set(decisions.map(crowdsecDecisionAddressKey)).size;
}

/**
 * How many addresses the Banned IPs list shows by default.
 *
 * The list's own query (`source: 'platform'`): WAF auto-bans, traffic
 * detection, operator bans and permanent bans. The community feed is excluded
 * there and therefore here — the tile is a summary of the list it links to.
 * Throws when the LAPI cannot be read; the caller decides how to say
 * "unknown", because zero would be a claim.
 */
export async function countActivePlatformBans(kubeconfigPath: string | undefined): Promise<number> {
  const { decisions } = await listDecisions(kubeconfigPath, { source: 'platform' });
  return countBannedAddresses(decisions);
}
