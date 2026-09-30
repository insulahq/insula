/**
 * Does this tenant own the mail domain of every address we are about to touch?
 *
 * Nothing asked this before. `validateRestoreItemForTenant` gates the item TYPE
 * and `config-tables` table names; `isSafeAddress` is a FORMAT check
 * (`/^[A-Za-z0-9._+\-]+@[A-Za-z0-9.\-]+$/`), not an ownership one. So a
 * `mailboxes-by-address` selector could name any address that parses.
 *
 * ★ The ordering made it worse than a missing check. `mailboxes-by-address`
 * called `ensureStalwartPrincipals()` BEFORE the snapshot-membership check that
 * would have rejected an unknown address — so the side effect landed first and
 * the validation that would have stopped it ran second. And
 * `ensureStalwartPrincipals` will CREATE a Stalwart domain principal when one is
 * missing, then load mailbox rows with
 * `inArray(mailboxes.fullAddress, addresses)` — globally scoped, no tenant
 * filter — so it could recreate another tenant's mailbox principal from that
 * tenant's own DB metadata.
 *
 * Capture kept the blast radius small by accident: bundle contents come from the
 * tenant's own mailboxes, so the addresses that survive to a successful restore
 * are theirs. **Bundle IMPORT removes that bound** — an uploaded archive's
 * addresses and component rows are supplied by whoever uploaded it (ADR-063).
 * This module is the check that has to exist before import does.
 *
 * Fails CLOSED in every ambiguous case: a malformed address, a domain with no
 * `email_domains` row, or an `email_domains` row whose tenant disagrees with its
 * parent `domains` row. Divergence between those two is not something to
 * arbitrate at restore time.
 */
import { eq, inArray } from 'drizzle-orm';

import { domains as domainsTable, emailDomains as emailDomainsTable } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';

export type RejectionReason =
  /** No `@`, empty local part, or empty domain. */
  | 'malformed'
  /** Parses, but no `email_domains` row for that name belongs to this tenant. */
  | 'not-owned';

export interface RejectedAddress {
  readonly address: string;
  readonly domain: string;
  readonly reason: RejectionReason;
}

export interface DomainOwnershipResult {
  readonly ok: boolean;
  /** Lower-cased domain names this tenant owns, out of the ones asked about. */
  readonly ownedDomains: ReadonlySet<string>;
  readonly rejected: ReadonlyArray<RejectedAddress>;
}

/**
 * Split an address into its domain, lower-cased.
 *
 * Deliberately strict and deliberately NOT a re-implementation of
 * `isSafeAddress`: that one guards shell/argv safety, this one answers "which
 * domain is this?". An address with more than one `@` has no single answer, so
 * it is malformed here even though a lenient parser could pick the last one.
 */
export function domainOf(address: string): string | null {
  const parts = String(address).split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || !domain) return null;
  const d = domain.trim().toLowerCase();
  // A trailing dot is a legal FQDN but would not match the stored name, and a
  // leading dot is never legal. Treat both as malformed rather than silently
  // failing the ownership lookup and reporting "not-owned".
  if (!d || d.startsWith('.') || d.endsWith('.') || d.includes('..')) return null;
  return d;
}

/**
 * Which of these addresses may this tenant act on?
 *
 * One query regardless of address count. Returns the full picture rather than
 * throwing so callers can decide between refusing the whole operation and
 * reporting a per-address breakdown.
 */
export async function checkMailboxDomainOwnership(
  db: Database,
  tenantId: string,
  addresses: ReadonlyArray<string>,
): Promise<DomainOwnershipResult> {
  const rejected: RejectedAddress[] = [];
  const wanted = new Map<string, string[]>(); // domain -> addresses asking for it

  for (const address of addresses) {
    const d = domainOf(address);
    if (!d) {
      rejected.push({ address, domain: '', reason: 'malformed' });
      continue;
    }
    const list = wanted.get(d);
    if (list) list.push(address);
    else wanted.set(d, [address]);
  }

  if (wanted.size === 0) {
    return { ok: rejected.length === 0, ownedDomains: new Set(), rejected };
  }

  // Join through the parent `domains` row for the NAME (email_domains has no
  // name column) and require BOTH rows to name this tenant. They should always
  // agree — email_domains.tenant_id and domains.tenant_id both cascade from
  // tenants — but if they ever diverge, denying is the only safe reading.
  const rows = await db
    .select({
      domainName: domainsTable.domainName,
      domainTenantId: domainsTable.tenantId,
      emailTenantId: emailDomainsTable.tenantId,
    })
    .from(emailDomainsTable)
    .innerJoin(domainsTable, eq(emailDomainsTable.domainId, domainsTable.id))
    .where(inArray(domainsTable.domainName, [...wanted.keys()]));

  const owned = new Set<string>();
  for (const r of rows) {
    if (r.domainTenantId !== tenantId) continue;
    if (r.emailTenantId !== tenantId) continue;
    owned.add(String(r.domainName).toLowerCase());
  }

  for (const [domain, addrs] of wanted) {
    if (owned.has(domain)) continue;
    for (const address of addrs) rejected.push({ address, domain, reason: 'not-owned' });
  }

  return { ok: rejected.length === 0, ownedDomains: owned, rejected };
}

/**
 * Throw unless every address's domain belongs to this tenant.
 *
 * MUST be called before anything with a side effect — principal creation,
 * snapshot selection, Job dispatch. The error names the offending addresses so
 * an operator can see which ones, but reports only the domain for a
 * `not-owned` case: whether some other tenant holds it is not this caller's
 * business to learn.
 */
export async function assertMailboxDomainsOwnedByTenant(
  db: Database,
  tenantId: string,
  addresses: ReadonlyArray<string>,
): Promise<void> {
  const result = await checkMailboxDomainOwnership(db, tenantId, addresses);
  if (result.ok) return;
  const shown = result.rejected.slice(0, 5)
    .map((r) => (r.reason === 'malformed' ? `'${r.address}' (malformed)` : `'${r.address}' (domain ${r.domain} is not yours)`))
    .join(', ');
  const more = result.rejected.length > 5 ? ` and ${result.rejected.length - 5} more` : '';
  throw new ApiError(
    'MAILBOX_DOMAIN_NOT_OWNED',
    `refusing to act on mailbox addresses whose mail domain this tenant does not own: ${shown}${more}`,
    403,
  );
}
