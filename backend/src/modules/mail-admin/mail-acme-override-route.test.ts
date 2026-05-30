import { describe, it, expect, vi } from 'vitest';
import {
  ensureMailAcmeOverrideRoute,
  buildOverrideRouteBody,
  isValidMailHostname,
  MAIL_ACME_OVERRIDE_NAME,
  MAIL_ACME_OVERRIDE_NAMESPACE,
} from './mail-acme-override-route.js';

// ── CustomObjectsApi stub ────────────────────────────────────────────
//
// Mirrors the stub style in ingress-routes/service.test.ts. By default
// getNamespacedCustomObject throws 404 so applyIngressRoute takes the
// create path; pass `exists: true` to exercise the replace path.

function makeCustomStub(opts: { exists?: boolean } = {}) {
  const calls: Record<string, unknown[]> = {
    get: [],
    create: [],
    replace: [],
    delete: [],
  };
  let getCount = 0;
  const stub = {
    getNamespacedCustomObject: vi.fn(async (args: unknown) => {
      calls.get.push(args);
      getCount += 1;
      if (opts.exists) {
        // First get = existence probe, subsequent = read-for-replace.
        return { metadata: { name: MAIL_ACME_OVERRIDE_NAME, resourceVersion: '42' } };
      }
      const err = new Error('not found') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    }),
    createNamespacedCustomObject: vi.fn(async (args: unknown) => {
      calls.create.push(args);
      return {};
    }),
    replaceNamespacedCustomObject: vi.fn(async (args: unknown) => {
      calls.replace.push(args);
      return {};
    }),
    deleteNamespacedCustomObject: vi.fn(async (args: unknown) => {
      calls.delete.push(args);
      return {};
    }),
  };
  return { stub, calls, getCount: () => getCount };
}

const logger = { warn: () => {}, info: () => {} };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asCustom = (s: unknown) => s as any;

describe('mail-admin mail-acme-override-route', () => {
  it('hostname == default → ensures override route ABSENT (deletes, no create)', async () => {
    const { stub, calls } = makeCustomStub();
    await ensureMailAcmeOverrideRoute(
      asCustom(stub),
      'mail.example.net',
      'mail.example.net',
      logger,
    );
    expect(calls.delete.length).toBe(1);
    expect(calls.create.length).toBe(0);
    expect(calls.replace.length).toBe(0);
    const delArgs = calls.delete[0] as { name: string; namespace: string };
    expect(delArgs.name).toBe(MAIL_ACME_OVERRIDE_NAME);
    expect(delArgs.namespace).toBe(MAIL_ACME_OVERRIDE_NAMESPACE);
  });

  it('hostname == default but different case → still treated as default (deletes)', async () => {
    const { stub, calls } = makeCustomStub();
    await ensureMailAcmeOverrideRoute(
      asCustom(stub),
      'MAIL.Example.NET',
      'mail.example.net',
      logger,
    );
    expect(calls.delete.length).toBe(1);
    expect(calls.create.length).toBe(0);
  });

  it('empty hostname → ensures override route ABSENT (deletes, no create)', async () => {
    const { stub, calls } = makeCustomStub();
    await ensureMailAcmeOverrideRoute(asCustom(stub), '', 'mail.example.net', logger);
    expect(calls.delete.length).toBe(1);
    expect(calls.create.length).toBe(0);
  });

  it('null hostname → ensures override route ABSENT (deletes, no create)', async () => {
    const { stub, calls } = makeCustomStub();
    await ensureMailAcmeOverrideRoute(asCustom(stub), null, 'mail.example.net', logger);
    expect(calls.delete.length).toBe(1);
    expect(calls.create.length).toBe(0);
  });

  it('hostname != default → APPLIES override route with correct match + service', async () => {
    const { stub, calls } = makeCustomStub();
    await ensureMailAcmeOverrideRoute(
      asCustom(stub),
      'mx.custom-domain.com',
      'mail.example.net',
      logger,
    );
    expect(calls.delete.length).toBe(0);
    expect(calls.create.length).toBe(1);

    const createArgs = calls.create[0] as { body: Record<string, unknown> };
    const body = createArgs.body;
    expect((body.metadata as { name: string }).name).toBe(MAIL_ACME_OVERRIDE_NAME);
    expect((body.metadata as { namespace: string }).namespace).toBe(MAIL_ACME_OVERRIDE_NAMESPACE);

    const spec = body.spec as {
      entryPoints: string[];
      routes: Array<{
        match: string;
        kind: string;
        priority: number;
        services: Array<{ name: string; port: number }>;
      }>;
    };
    expect(spec.entryPoints).toEqual(['web']);
    expect(spec.routes).toHaveLength(1);
    const route = spec.routes[0];
    // Match MUST contain the override host AND the acme-challenge prefix.
    expect(route.match).toContain('mx.custom-domain.com');
    expect(route.match).toContain('/.well-known/acme-challenge/');
    expect(route.match).toBe(
      'Host(`mx.custom-domain.com`) && PathPrefix(`/.well-known/acme-challenge/`)',
    );
    expect(route.kind).toBe('Rule');
    expect(route.priority).toBe(100);
    // Backend MUST be stalwart-mail-acme:80.
    expect(route.services).toEqual([{ name: 'stalwart-mail-acme', port: 80 }]);
  });

  it('hostname != default + route already exists → REPLACES (idempotent)', async () => {
    const { stub, calls } = makeCustomStub({ exists: true });
    await ensureMailAcmeOverrideRoute(
      asCustom(stub),
      'mx.custom-domain.com',
      'mail.example.net',
      logger,
    );
    expect(calls.create.length).toBe(0);
    expect(calls.replace.length).toBe(1);
    expect(calls.delete.length).toBe(0);
    const replaceArgs = calls.replace[0] as { body: { metadata: { resourceVersion?: string } } };
    // resourceVersion carried through for optimistic concurrency.
    expect(replaceArgs.body.metadata.resourceVersion).toBe('42');
  });

  it('non-default hostname is case-normalised in the match', async () => {
    const { stub, calls } = makeCustomStub();
    await ensureMailAcmeOverrideRoute(
      asCustom(stub),
      'MX.Custom-Domain.COM',
      'mail.example.net',
      logger,
    );
    const createArgs = calls.create[0] as { body: { spec: { routes: Array<{ match: string }> } } };
    expect(createArgs.body.spec.routes[0].match).toBe(
      'Host(`mx.custom-domain.com`) && PathPrefix(`/.well-known/acme-challenge/`)',
    );
  });

  it('defaultMailHost null + valid non-default host → APPLIES (M2: default only needed for delete-when-equal)', async () => {
    const { stub, calls } = makeCustomStub();
    await ensureMailAcmeOverrideRoute(asCustom(stub), 'mx.custom-domain.com', null, logger);
    // No default to compare against, but the host is valid + non-empty,
    // so we still apply the override route rather than losing it.
    expect(calls.delete.length).toBe(0);
    expect(calls.create.length).toBe(1);
    const createArgs = calls.create[0] as { body: { spec: { routes: Array<{ match: string }> } } };
    expect(createArgs.body.spec.routes[0].match).toBe(
      'Host(`mx.custom-domain.com`) && PathPrefix(`/.well-known/acme-challenge/`)',
    );
  });

  it('defaultMailHost null + empty host → still ensures ABSENT (deletes)', async () => {
    const { stub, calls } = makeCustomStub();
    await ensureMailAcmeOverrideRoute(asCustom(stub), '', null, logger);
    expect(calls.delete.length).toBe(1);
    expect(calls.create.length).toBe(0);
  });

  it('never throws when the k8s client errors (best-effort)', async () => {
    const stub = {
      getNamespacedCustomObject: vi.fn(async () => {
        throw new Error('apiserver down');
      }),
      createNamespacedCustomObject: vi.fn(),
      replaceNamespacedCustomObject: vi.fn(),
      deleteNamespacedCustomObject: vi.fn(async () => {
        throw new Error('apiserver down');
      }),
    };
    // Both branches (apply + delete) must swallow the error.
    await expect(
      ensureMailAcmeOverrideRoute(asCustom(stub), 'mx.custom.com', 'mail.example.net', logger),
    ).resolves.toBeUndefined();
    await expect(
      ensureMailAcmeOverrideRoute(asCustom(stub), 'mail.example.net', 'mail.example.net', logger),
    ).resolves.toBeUndefined();
  });

  it('buildOverrideRouteBody stamps the managed-by + identity labels', () => {
    const body = buildOverrideRouteBody('mx.custom.com');
    const labels = (body.metadata as { labels: Record<string, string> }).labels;
    expect(labels['app.kubernetes.io/managed-by']).toBe('platform-api');
    expect(labels['app.kubernetes.io/name']).toBe('stalwart-mail');
    expect(labels['app.kubernetes.io/component']).toBe('acme-http01');
    expect(body.apiVersion).toBe('traefik.io/v1alpha1');
    expect(body.kind).toBe('IngressRoute');
  });

  // ── H1: Traefik match-rule injection guard ──────────────────────────

  it('injection host (backtick/paren payload) → does NOT apply, logs warn', async () => {
    const { stub, calls } = makeCustomStub();
    const warn = vi.fn();
    // Crafted value that, if interpolated raw into the Traefik match
    // `Host(`<host>`) && …`, would inject/widen the route.
    const injection = 'x`)||Host(`evil.com';

    await ensureMailAcmeOverrideRoute(asCustom(stub), injection, 'mail.example.net', {
      warn,
      info: () => {},
    });

    expect(calls.create.length).toBe(0);
    expect(calls.replace.length).toBe(0);
    // Delete is NOT attempted either — the host is non-empty + non-default,
    // so it takes the apply branch, which is then refused by the guard.
    expect(calls.delete.length).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('injection host with null default → still refuses to apply, logs warn', async () => {
    const { stub, calls } = makeCustomStub();
    const warn = vi.fn();
    const injection = 'mail.foo.com`)||Host(`x';

    await ensureMailAcmeOverrideRoute(asCustom(stub), injection, null, { warn, info: () => {} });

    expect(calls.create.length).toBe(0);
    expect(calls.replace.length).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('isValidMailHostname accepts FQDNs and rejects injection / bare labels', () => {
    expect(isValidMailHostname('mail.example.com')).toBe(true);
    expect(isValidMailHostname('mx.override.example.org')).toBe(true);
    expect(isValidMailHostname('x`)||Host(`evil.com')).toBe(false);
    expect(isValidMailHostname('mail.foo.com`)||Host(`x')).toBe(false);
    // Bare single-label hosts are rejected (mail host is always an FQDN).
    expect(isValidMailHostname('localhost')).toBe(false);
    expect(isValidMailHostname('')).toBe(false);
  });
});
