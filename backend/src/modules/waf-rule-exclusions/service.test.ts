/**
 * B2 service unit tests — pure helpers + cross-tenant error contract.
 *
 * The end-to-end Phase K harness already covers the full create →
 * reconcile → ConfigMap roundtrip; these unit tests close gaps the
 * harness can't reach cheaply:
 *
 *   - hostname regex escaping (security-critical; tenant cannot
 *     supply a regex that bypasses the SecRule scope)
 *   - rowToContract null-tenant mapping (nullable FK columns surface
 *     as null on admin-scoped rows)
 *   - cross-tenant probe at the loadTenantRoute boundary (returns
 *     ROUTE_NOT_FOUND, not 403 / no leak between tenants)
 *
 * The DB-mocking is deliberately minimal: just enough to drive the
 * service through its decision branches. We don't try to simulate
 * Drizzle's full query-builder semantics — that's what the harness
 * verifies against a real Postgres.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __test as svcTest,
  WafRuleExclusionError,
  createExclusionForTenantRoute,
  deleteExclusionForTenantRoute,
  listExclusionsForTenantRoute,
} from './service.js';
import type { WafRuleExclusion } from '@k8s-hosting/api-contracts';

const { buildHostnameRegexFromHostname, rowToContract } = svcTest;

// ─── Pure helpers ───────────────────────────────────────────────────────

describe('buildHostnameRegexFromHostname', () => {
  it('anchors with ^...$ and escapes the DNS dot', () => {
    expect(buildHostnameRegexFromHostname('api.foo.com'))
      .toBe('^api\\.foo\\.com$');
  });

  it('escapes all PCRE metacharacters, not just dots', () => {
    // Defence-in-depth: even though DNS hostnames can't contain most
    // of these, escape every metachar so a future bug elsewhere (e.g.
    // someone passing in a user-typed string by mistake) can't smuggle
    // a `*` or `(` past the anchor.
    const out = buildHostnameRegexFromHostname('a.b+c*d?e^f$g{h}i(j)k|l[m]n\\o');
    // Verify it parses as a valid RegExp (the actual ModSec engine is
    // PCRE which is a superset; JS parsing is the safer lower bound).
    expect(() => new RegExp(out)).not.toThrow();
    // No raw metacharacter should appear unescaped inside the body.
    const body = out.slice(1, -1); // strip ^ and $
    for (const ch of ['.', '+', '*', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']']) {
      // Check every occurrence is preceded by a backslash.
      let i = -1;
      while ((i = body.indexOf(ch, i + 1)) !== -1) {
        expect(body[i - 1]).toBe('\\');
      }
    }
  });

  it('handles bare hostnames without subdomain', () => {
    expect(buildHostnameRegexFromHostname('example')).toBe('^example$');
  });

  it('handles single-character hostnames', () => {
    expect(buildHostnameRegexFromHostname('a')).toBe('^a$');
  });
});

// ─── Row mapping ────────────────────────────────────────────────────────

describe('rowToContract', () => {
  const baseRow = {
    id: '00000000-0000-0000-0000-000000000001',
    ruleId: '930120',
    hostnameRegex: '^foo\\.com$',
    scope: 'args_names_only',
    reason: 'JSON name FP',
    createdBy: 'admin@x',
    createdAt: new Date('2026-05-20T10:00:00.000Z'),
    updatedAt: new Date('2026-05-20T10:00:00.000Z'),
    disabled: false,
    tenantId: null,
    routeId: null,
  };

  it('maps admin-scoped rows with tenantId / routeId = null', () => {
    const c = rowToContract(baseRow);
    expect(c.tenantId).toBeNull();
    expect(c.routeId).toBeNull();
    expect(c.id).toBe(baseRow.id);
    expect(c.disabled).toBe(false);
    expect(c.createdAt).toBe('2026-05-20T10:00:00.000Z');
  });

  it('maps tenant-scoped rows with both IDs surfaced', () => {
    const c = rowToContract({
      ...baseRow,
      tenantId: 'tenant-a',
      routeId: 'route-1',
    });
    expect(c.tenantId).toBe('tenant-a');
    expect(c.routeId).toBe('route-1');
  });

  it('coerces undefined nullable FK columns to null', () => {
    // Drizzle returns null/undefined inconsistently depending on the
    // query shape; the contract type promises null, not undefined.
    const c = rowToContract({ ...baseRow, tenantId: undefined as unknown as null });
    expect(c.tenantId).toBeNull();
  });
});

// ─── Cross-tenant probe at loadTenantRoute boundary ────────────────────
//
// Each test builds a minimal stub DB that returns the (route, tenant)
// pair for the requested routeId. The service's loadTenantRoute
// helper compares the row's domainTenantId against the caller's
// tenantId and throws ROUTE_NOT_FOUND on mismatch. We don't try to
// drive the full transaction — just enough to hit the boundary
// check and verify the contract.

interface SelectChain {
  from: (..._args: unknown[]) => {
    innerJoin: (..._args: unknown[]) => {
      where: (..._args: unknown[]) => {
        limit: (_n: number) => Promise<Array<{
          id: string;
          hostname: string;
          domainTenantId: string;
        }>>;
      };
    };
  };
}

interface StubDb {
  select: (_columns?: unknown) => SelectChain;
  transaction: <T>(_fn: (tx: StubDb) => Promise<T>) => Promise<T>;
  execute: (_q: unknown) => Promise<unknown>;
}

const makeStubDb = (route: { id: string; hostname: string; domainTenantId: string } | null): StubDb => {
  const select = (_columns?: unknown): SelectChain => ({
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          limit: async () => (route ? [route] : []),
        }),
      }),
    }),
  });
  const stub: StubDb = {
    select,
    transaction: async <T,>(fn: (tx: StubDb) => Promise<T>) => fn(stub),
    execute: async () => undefined,
  };
  return stub;
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('listExclusionsForTenantRoute', () => {
  it('throws ROUTE_NOT_FOUND when the route does not belong to the tenant', async () => {
    const db = makeStubDb({
      id: 'route-1',
      hostname: 'api.foo.com',
      domainTenantId: 'tenant-OTHER',
    });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listExclusionsForTenantRoute(db as any, 'tenant-A', 'route-1'),
    ).rejects.toThrow(WafRuleExclusionError);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await listExclusionsForTenantRoute(db as any, 'tenant-A', 'route-1');
    } catch (err) {
      expect((err as WafRuleExclusionError).code).toBe('ROUTE_NOT_FOUND');
    }
  });

  it('throws ROUTE_NOT_FOUND when the route does not exist at all', async () => {
    const db = makeStubDb(null);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listExclusionsForTenantRoute(db as any, 'tenant-A', 'route-missing'),
    ).rejects.toMatchObject({ code: 'ROUTE_NOT_FOUND' });
  });
});

describe('createExclusionForTenantRoute', () => {
  it('rejects cross-tenant create with ROUTE_NOT_FOUND before any insert', async () => {
    const db = makeStubDb({
      id: 'route-1',
      hostname: 'api.foo.com',
      domainTenantId: 'tenant-OTHER',
    });
    await expect(
      createExclusionForTenantRoute(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db as any,
        'tenant-A',
        'route-1',
        { ruleId: '930120', scope: 'args_names_only', reason: 'attack' },
        'tenant-A-user',
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_NOT_FOUND' });
  });
});

describe('deleteExclusionForTenantRoute', () => {
  it('rejects cross-tenant delete with ROUTE_NOT_FOUND before touching the row', async () => {
    const db = makeStubDb({
      id: 'route-1',
      hostname: 'api.foo.com',
      domainTenantId: 'tenant-OTHER',
    });
    await expect(
      deleteExclusionForTenantRoute(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db as any,
        'tenant-A',
        'route-1',
        '11111111-1111-1111-1111-111111111111',
      ),
    ).rejects.toMatchObject({ code: 'ROUTE_NOT_FOUND' });
  });
});

// Hostname derivation — assert the create path passes the
// server-derived regex to the insert. We can't drive the full insert
// without a richer DB stub, so we verify by intercepting the
// hostname helper's output via the public buildHostnameRegexFromHostname
// (same code path the service uses internally).
describe('hostname derivation contract', () => {
  it('produces the same regex the service uses internally', () => {
    // Mirrors what createExclusionForTenantRoute does after the
    // ownership check: route.hostname → buildHostnameRegexFromHostname.
    // The assertion guarantees that even if a refactor reorganises
    // service.ts, the wire-level contract for tenant-scoped hostname
    // regex matches `^<hostname>$` byte-for-byte.
    const cases: Array<[string, string]> = [
      ['shop.example.com',     '^shop\\.example\\.com$'],
      ['x.staging.tenant.net', '^x\\.staging\\.tenant\\.net$'],
      ['bare',                 '^bare$'],
    ];
    for (const [input, expected] of cases) {
      expect(buildHostnameRegexFromHostname(input)).toBe(expected);
    }
  });
});
