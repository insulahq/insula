/**
 * Whether a new domain overlaps a domain that belongs to another account.
 *
 * A tenant may not add a domain inside, or around, another account's domain,
 * nor one under the platform's own apex. The reasons are DNS and mail, not
 * naming:
 *
 * - Every primary-mode zone lives on the same nameservers, and they answer
 *   from the most specific zone they hold. A zone for `shop.example.test`
 *   takes that name over from another tenant's `example.test` zone the moment
 *   `createDomain` provisions it, before anything is verified, and the NS
 *   verification then passes because it asks those same nameservers.
 * - Under relaxed DMARC alignment (the default, and what our records publish)
 *   a DKIM signature or SPF pass for `shop.example.test` aligns with a From
 *   address at `example.test`.
 * - The parent direction is refused as well. Otherwise a tenant who adds
 *   `www.example.test` first keeps that name when the real owner of
 *   `example.test` arrives and delegates it here.
 *
 * Staff are not checked (see `createDomain`'s `allowCrossAccountOverlap`):
 * an operator may give one customer a subdomain of another's domain, or of
 * the platform's apex, on purpose.
 */
import { and, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { domains, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';
import { likeSuffixPattern } from '../../shared/like-pattern.js';

/** DNS names are case-insensitive: compare and store them lowercased, without a trailing dot. */
export function normalizeDomainName(name: string): string {
  return name.trim().replace(/\.+$/, '').toLowerCase();
}

/**
 * Every enclosing name of at least two labels, nearest first:
 * `a.b.example.test` → `b.example.test`, `example.test`. A bare TLD is never
 * a domain anyone owns here, so it is left out.
 */
export function parentDomainNames(name: string): string[] {
  const labels = normalizeDomainName(name).split('.');
  const parents: string[] = [];
  for (let i = 1; i <= labels.length - 2; i += 1) {
    parents.push(labels.slice(i).join('.'));
  }
  return parents;
}

export interface DomainOverlap {
  /** `inside`: the new name is under the other domain. `contains`: the other domain is under it. */
  readonly relation: 'inside' | 'contains';
  /** The other domain is the platform's own (its apex, or a SYSTEM-tenant domain). */
  readonly platform: boolean;
}

/**
 * The first domain of ANOTHER tenant that encloses `name` or sits under it,
 * or null. `apex` is the platform apex: names under it are the platform's even
 * where no domain row records them.
 */
export async function findCrossAccountOverlap(
  db: Database,
  tenantId: string,
  name: string,
  apex: string,
): Promise<DomainOverlap | null> {
  const host = normalizeDomainName(name);
  const platformApex = normalizeDomainName(apex);
  if (platformApex && host !== platformApex) {
    if (host.endsWith(`.${platformApex}`)) return { relation: 'inside', platform: true };
    if (platformApex.endsWith(`.${host}`)) return { relation: 'contains', platform: true };
  }

  const parents = parentDomainNames(host);
  const [row] = await db
    .select({ domainName: domains.domainName, isSystem: tenants.isSystem })
    .from(domains)
    .innerJoin(tenants, eq(tenants.id, domains.tenantId))
    .where(and(
      ne(domains.tenantId, tenantId),
      or(
        ...(parents.length > 0 ? [inArray(sql`lower(${domains.domainName})`, parents)] : []),
        ilike(domains.domainName, likeSuffixPattern(`.${host}`)),
      ),
    ))
    .limit(1);
  if (!row) return null;
  return {
    relation: parents.includes(normalizeDomainName(row.domainName)) ? 'inside' : 'contains',
    platform: row.isSystem,
  };
}

/**
 * Throws 409 DOMAIN_OVERLAPS_ANOTHER_ACCOUNT when {@link findCrossAccountOverlap}
 * finds one. One message for every case: it never names the other domain or
 * its account, nor says whether the clash is a parent, a subdomain or the
 * platform's own domain, so a refusal tells the caller no more than that the
 * name overlaps something here.
 */
export async function assertNoCrossAccountOverlap(
  db: Database,
  tenantId: string,
  name: string,
  apex: string,
): Promise<void> {
  const overlap = await findCrossAccountOverlap(db, tenantId, name, apex);
  if (!overlap) return;
  const host = normalizeDomainName(name);
  const detail = `'${host}' is inside, or contains, a domain already in use on this platform.`;
  throw new ApiError(
    'DOMAIN_OVERLAPS_ANOTHER_ACCOUNT',
    `${detail} It cannot be added to this account.`,
    409,
    {
      domain: host,
      operatorError: {
        code: 'DOMAIN_OVERLAPS_ANOTHER_ACCOUNT',
        title: 'Domain belongs to another account',
        detail: `${detail} A domain inside or around another account's domain would take over part of its DNS and mail.`,
        remediation: [
          'Check the domain name for typos.',
          'If this domain is yours, ask your hosting provider to add it to your account.',
        ],
        retryable: false,
      },
    },
  );
}
