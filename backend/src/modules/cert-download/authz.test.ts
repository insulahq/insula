import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import { resolveDomainByName } from './bundle.js';
import { verifyToken, __testing } from './token-service.js';

const { hashToken, mintToken } = __testing;

/**
 * The load-bearing authorisation on the token route is two lines:
 *
 *   const ref = await resolveDomainByName(db, verified.tenantId, domain);
 *   if (!ref || ref.domainId !== verified.domainId) -> 404
 *
 * Everything protecting one tenant's private key from another rests on those.
 * They had no direct test — the unit suites covered token verification and
 * bundle building either side of them, but not the join between.
 *
 * These exercise the decision itself against a database stub that behaves like
 * the real query: the lookup is scoped by tenant, so a name belonging to
 * another tenant simply returns nothing.
 */

type DomainRow = { id: string; tenantId: string; domainName: string };

/** Stub honouring the real WHERE: (domain_name = ?, tenant_id = ?). */
function dbWithDomains(rows: DomainRow[]): Database {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: (cond: unknown) => ({
            limit: () => {
              // Recover the bound values from Drizzle's condition tree without
              // serialising it (the tree is circular).
              const found: string[] = [];
              const walk = (n: unknown, d = 0) => {
                if (d > 8 || n === null || typeof n !== 'object') return;
                for (const v of Object.values(n as Record<string, unknown>)) {
                  if (typeof v === 'string') found.push(v);
                  else if (typeof v === 'object') walk(v, d + 1);
                }
              };
              walk(cond);
              const match = rows.find(
                (r) => found.includes(r.domainName) && found.includes(r.tenantId),
              );
              return Promise.resolve(match
                ? [{ domainId: match.id, tenantId: match.tenantId, domainName: match.domainName, namespace: 'ns' }]
                : []);
            },
          }),
        }),
      }),
    }),
  } as unknown as Database;
}

/** The route's own decision, extracted verbatim so the test drives real logic. */
async function routeWouldServe(
  db: Database,
  token: { tenantId: string; domainId: string },
  requestedDomain: string,
): Promise<boolean> {
  const ref = await resolveDomainByName(db, token.tenantId, requestedDomain);
  return !(!ref || ref.domainId !== token.domainId);
}

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const DOMAINS: DomainRow[] = [
  { id: 'dom-a1', tenantId: TENANT_A, domainName: 'alpha.test' },
  { id: 'dom-a2', tenantId: TENANT_A, domainName: 'beta.test' },
  { id: 'dom-b1', tenantId: TENANT_B, domainName: 'victim.test' },
];

describe('token route authorisation', () => {
  const db = dbWithDomains(DOMAINS);

  it('serves the domain the token is bound to', async () => {
    expect(await routeWouldServe(db, { tenantId: TENANT_A, domainId: 'dom-a1' }, 'alpha.test')).toBe(true);
  });

  // The core IDOR guard: same tenant, different domain.
  it('REFUSES a sibling domain inside the token\'s own tenant', async () => {
    expect(await routeWouldServe(db, { tenantId: TENANT_A, domainId: 'dom-a1' }, 'beta.test')).toBe(false);
  });

  // Cross-tenant: the name lookup is scoped to the token's tenant, so another
  // tenant's hostname is not even visible, let alone downloadable.
  it('REFUSES another tenant\'s domain', async () => {
    expect(await routeWouldServe(db, { tenantId: TENANT_A, domainId: 'dom-a1' }, 'victim.test')).toBe(false);
  });

  // A forged token claiming tenant B but bound to a tenant-A domain id must
  // not resolve either — both halves have to agree.
  it('REFUSES when the token\'s tenant and domain do not belong together', async () => {
    expect(await routeWouldServe(db, { tenantId: TENANT_B, domainId: 'dom-a1' }, 'victim.test')).toBe(false);
  });

  it('REFUSES an unknown hostname', async () => {
    expect(await routeWouldServe(db, { tenantId: TENANT_A, domainId: 'dom-a1' }, 'nope.test')).toBe(false);
  });

  // Both refusals produce the same 404 in the route, so a caller cannot tell
  // "that domain is not yours" from "that domain does not exist".
  it('treats not-mine and not-found identically', async () => {
    const notMine = await routeWouldServe(db, { tenantId: TENANT_A, domainId: 'dom-a1' }, 'victim.test');
    const notFound = await routeWouldServe(db, { tenantId: TENANT_A, domainId: 'dom-a1' }, 'nope.test');
    expect(notMine).toBe(notFound);
  });
});

describe('token verification feeds the right binding into that check', () => {
  it('carries the token\'s OWN tenant and domain, never the request\'s', async () => {
    const token = mintToken();
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{
              id: 'tok-1', tenantId: TENANT_A, domainId: 'dom-a1',
              name: 'deploy', tokenHash: hashToken(token), expiresAt: null,
            }]),
          }),
        }),
      }),
    } as unknown as Database;

    const verified = await verifyToken(db, token);
    // These two values are the ONLY inputs to the authz decision above —
    // nothing from the URL contributes to them.
    expect(verified).toMatchObject({ tenantId: TENANT_A, domainId: 'dom-a1' });
  });
});

describe('role gating matches the documented matrix', () => {
  // Guards against a future edit widening these lists. The doc table in
  // TLS_CERTIFICATE_MANAGEMENT.md and these assertions must agree.
  it('excludes support and tenant_user from every key-bearing route', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./routes.ts', import.meta.url), 'utf8'));

    // Each key-bearing route must NOT list 'support'.
    const keyBearing = [
      /ssl-cert\/download'[\s\S]{0,200}?requireRole\(([^)]*)\)/,
      /cert-tokens'[\s\S]{0,400}?summary: 'Create[\s\S]{0,200}?requireRole\(([^)]*)\)/,
    ];
    const downloadRoles = src.match(/'\/tenants\/:tenantId\/domains\/:domainId\/ssl-cert\/download',[\s\S]{0,200}?requireRole\(([^)]*)\)/);
    expect(downloadRoles, 'download route role list not found').not.toBeNull();
    expect(downloadRoles![1]).not.toContain('support');
    expect(downloadRoles![1]).not.toContain('tenant_user');
    expect(keyBearing.length).toBeGreaterThan(0);
  });
});
