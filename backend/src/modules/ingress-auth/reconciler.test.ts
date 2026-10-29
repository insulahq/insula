import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./providers-service.js', () => ({
  decryptProviderSecret: vi.fn(() => 'plaintext-secret'),
}));
vi.mock('./service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./service.js')>()),
  getOrCreateTenantCookieSecret: vi.fn().mockResolvedValue('cookie-secret-32-bytes-long-fake_'),
  listEnabledForTenant: vi.fn(),
}));
vi.mock('../tenant-placement/pod-placement.js', () => ({
  loadTenantPodPlacement: vi.fn().mockResolvedValue({ nodeName: null }),
  platformPodPlacement: vi.fn(() => ({ priorityClassName: 'platform-overhead' })),
}));

import {
  reconcileTenant,
  buildGatePolicy,
  buildGateArgs,
  buildGateSecretData,
  buildGateDeployment,
  gateConfigHash,
  sessionSettings,
  splitGroups,
  explainProxyLog,
  fatalGateProblem,
  partitionServable,
  type GateMaterial,
} from './reconciler.js';
import { listEnabledForTenant, type EnabledIngressAuthRow } from './service.js';
import { DEFAULT_OAUTH2_PROXY_IMAGE } from '../oidc/panel-proxy.js';

const listEnabledMock = listEnabledForTenant as unknown as ReturnType<typeof vi.fn>;
const NAMESPACE = 'tenant-c1';

function row(over: Partial<EnabledIngressAuthRow['cfg']> = {}, host = 'app.example.test'): EnabledIngressAuthRow {
  return {
    cfg: {
      id: `cfg-${host}`,
      ingressRouteId: `route-${host}`,
      enabled: true,
      providerId: 'p-1',
      postLoginRedirectUrl: null,
      allowedEmails: null,
      allowedEmailDomains: null,
      allowedGroups: null,
      claimRules: null,
      passAuthorizationHeader: false,
      passAccessToken: false,
      passIdToken: false,
      passUserHeaders: true,
      setXauthrequest: true,
      cookieDomain: null,
      cookieRefreshSeconds: 0,
      cookieExpireSeconds: 86400,
      lastError: null,
      lastReconciledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    },
    provider: {
      id: 'p-1',
      tenantId: 't-1',
      name: 'Google',
      issuerUrl: 'https://accounts.example.test',
      oauthClientId: 'client-1',
      oauthClientSecretEncrypted: 'enc',
      usePkce: true,
      defaultScopes: 'openid profile email',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    hostname: host,
    host,
  } as EnabledIngressAuthRow;
}

describe('the gate policy', () => {
  it('★ is keyed by the ingress ROUTE id — what the Middleware sends as ?route=', () => {
    const policy = JSON.parse(buildGatePolicy([row({ id: 'config-uuid', ingressRouteId: 'the-route-id' })]));
    expect(Object.keys(policy)).toEqual(['the-route-id']);
  });

  it('carries the allow lists, claim rules, post-login URL and header choices', () => {
    const p = JSON.parse(buildGatePolicy([row({
      allowedEmails: 'a@example.test, b@example.test',
      allowedEmailDomains: 'example.test',
      allowedGroups: 'Domain Admins, staff',
      claimRules: [{ claim: 'plan', operator: 'equals', value: 'gold' }],
      postLoginRedirectUrl: 'https://app.example.test/home',
      passAuthorizationHeader: true,
    })]))['route-app.example.test'];
    expect(p.emails).toEqual(['a@example.test', 'b@example.test']);
    expect(p.emailDomains).toEqual(['example.test']);
    // A group name may contain a space.
    expect(p.groups).toEqual(['Domain Admins', 'staff']);
    expect(p.claimRules).toHaveLength(1);
    expect(p.redirect).toBe('https://app.example.test/home');
    expect(p.headers).toEqual({ user: true, groups: true, accessToken: false, idToken: false, authorization: true });
  });

  it('splitGroups splits on commas, semicolons and newlines only', () => {
    expect(splitGroups('a b, c;d\ne')).toEqual(['a b', 'c', 'd', 'e']);
  });
});

describe('oauth2-proxy arguments', () => {
  const args = (rows: EnabledIngressAuthRow[], ca = false) => buildGateArgs(rows, { withExtraCa: ca });

  it('★ answers 202 at / for a signed-in visitor and goes straight to the IdP otherwise', () => {
    const a = args([row()]);
    expect(a).toContain('--upstream=static://202');
    expect(a).toContain('--skip-provider-button=true');
    expect(a).toContain('--reverse-proxy=true');
    expect(a).toContain('--set-authorization-header=true');
    expect(a).toContain('--approval-prompt=auto');
  });

  it('whitelists every protected host and every post-login host', () => {
    const a = args([row({}, 'a.example.test'), row({ postLoginRedirectUrl: 'https://landing.example.test/x' }, 'b.example.test')]);
    expect(a.filter((x) => x.startsWith('--whitelist-domain='))).toEqual([
      '--whitelist-domain=a.example.test',
      '--whitelist-domain=b.example.test',
      '--whitelist-domain=landing.example.test',
    ]);
  });

  it('names a cookie domain for every host once any route sets one', () => {
    const a = args([row({ cookieDomain: '.example.test' }, 'a.example.test'), row({}, 'other.test')]);
    expect(a.filter((x) => x.startsWith('--cookie-domain='))).toEqual(['--cookie-domain=example.test', '--cookie-domain=other.test']);
    expect(args([row()]).some((x) => x.startsWith('--cookie-domain='))).toBe(false);
  });

  it('applies the strictest session settings and keeps refresh below expiry', () => {
    expect(sessionSettings([row({ cookieExpireSeconds: 3600 }), row({ cookieExpireSeconds: 600, cookieRefreshSeconds: 300 })]))
      .toEqual({ expire: 600, refresh: 300 });
    expect(sessionSettings([row({ cookieExpireSeconds: 600 }), row({ cookieRefreshSeconds: 3600 })])).toEqual({ expire: 600, refresh: 0 });
    expect(args([row()])).toContain('--cookie-refresh=0s');
  });

  it('PKCE and the platform CA are flags only when set', () => {
    expect(args([row()])).toContain('--code-challenge-method=S256');
    const noPkce = row(); (noPkce.provider as { usePkce: boolean }).usePkce = false;
    expect(args([noPkce]).some((x) => x.startsWith('--code-challenge-method'))).toBe(false);
    expect(args([row()], true)).toEqual(expect.arrayContaining(['--use-system-trust-store=true', expect.stringMatching(/^--provider-ca-file=/)]));
  });

  it('the issuer, client and secrets are environment variables, never arguments', () => {
    const a = args([row()]).join(' ');
    expect(a).not.toMatch(/client-1|plaintext-secret|accounts\.example\.test/);
    expect(buildGateSecretData([row()], 'plaintext-secret', 'cookie')).toEqual({
      OAUTH2_PROXY_OIDC_ISSUER_URL: 'https://accounts.example.test',
      OAUTH2_PROXY_CLIENT_ID: 'client-1',
      OAUTH2_PROXY_CLIENT_SECRET: 'plaintext-secret',
      OAUTH2_PROXY_COOKIE_SECRET: 'cookie',
    });
  });
});

describe('the gate Deployment', () => {
  const material = (over: Partial<GateMaterial> = {}): GateMaterial => ({
    secretData: buildGateSecretData([row()], 's', 'c'),
    configMapData: { 'policy.json': buildGatePolicy([row()]) },
    args: buildGateArgs([row()], { withExtraCa: false }),
    ...over,
  });

  it('runs oauth2-proxy and the route gate, the gate reading the policy from a directory mount', () => {
    const d = buildGateDeployment(NAMESPACE, material(), { nodeName: null } as never);
    const [proxy, gate] = d.spec!.template.spec!.containers;
    expect(proxy!.image).toBe(DEFAULT_OAUTH2_PROXY_IMAGE);
    expect(proxy!.envFrom).toEqual([{ secretRef: { name: 'oauth2-proxy-secrets' } }]);
    expect(gate!.name).toBe('route-gate');
    // No subPath — a subPath mount never sees an update.
    expect(gate!.volumeMounts).toEqual([{ name: 'policy', mountPath: '/etc/route-gate', readOnly: true }]);
    expect(d.spec!.template.spec!.automountServiceAccountToken).toBe(false);
    expect(proxy!.securityContext?.readOnlyRootFilesystem).toBe(true);
  });

  it('mounts the platform CA only when there is one', () => {
    const plain = buildGateDeployment(NAMESPACE, material(), {} as never);
    expect(plain.spec!.template.spec!.volumes!.map((v) => v.name)).toEqual(['policy']);
    const withCa = buildGateDeployment(NAMESPACE, material({ configMapData: { 'policy.json': '{}', 'ca-bundle.crt': 'PEM' } }), {} as never);
    expect(withCa.spec!.template.spec!.volumes!.map((v) => v.name)).toEqual(['policy', 'ca']);
  });

  it('★ a changed secret, policy or argument changes the pod template hash (and so restarts the pod)', () => {
    const base = gateConfigHash(material());
    expect(gateConfigHash(material({ secretData: { ...material().secretData, OAUTH2_PROXY_CLIENT_SECRET: 'rotated' } }))).not.toBe(base);
    expect(gateConfigHash(material({ configMapData: { 'policy.json': '{"x":{}}' } }))).not.toBe(base);
    expect(gateConfigHash(material({ args: [...material().args, '--whitelist-domain=new.example.test'] }))).not.toBe(base);
    expect(gateConfigHash(material())).toBe(base);
    const d = buildGateDeployment(NAMESPACE, material(), {} as never);
    expect(d.spec!.template.metadata!.annotations!['insula.host/config-hash']).toBe(base);
  });
});

describe('start failures in words', () => {
  it('names the usual causes', () => {
    expect(explainProxyLog('oidc: issuer did not match the issuer returned by provider')).toMatch(/trailing slash/);
    expect(explainProxyLog('x509: certificate signed by unknown authority')).toMatch(/not trusted/);
    expect(explainProxyLog('dial tcp: lookup idp.example.test: no such host')).toMatch(/could not be reached/);
  });

  it('a restarted or crash-looping container is fatal; a starting one is not', () => {
    expect(fatalGateProblem([{ metadata: { name: 'p' }, status: { containerStatuses: [{ name: 'oauth2-proxy', restartCount: 1 }] } } as never]))
      .toMatchObject({ container: 'oauth2-proxy' });
    expect(fatalGateProblem([{ metadata: { name: 'p' }, status: { containerStatuses: [{ name: 'oauth2-proxy', restartCount: 0, state: { waiting: { reason: 'ContainerCreating' } } }] } } as never]))
      .toBeNull();
  });
});

// ─── reconcileTenant against mocked clusters ──────────────────────────────────

function notFound(): Error {
  const e = new Error('HTTP-Code: 404 Message: Not Found');
  (e as { statusCode?: number }).statusCode = 404;
  return e;
}

function cluster(opts: { stateRow?: boolean; ready?: boolean; extraCa?: string } = {}) {
  const calls: Array<{ op: string; kind: string; body?: unknown }> = [];
  const dbWrites: Array<{ op: string; values?: unknown }> = [];
  let deploymentHash: string | null = null;
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(async () => {
          const name = (table as Record<symbol, string>)[Symbol.for('drizzle:Name')];
          if (name === 'tenants') return [{ ns: NAMESPACE }];
          if (name === 'tenant_oauth2_proxy_state') return opts.stateRow ? [{ tenantId: 't-1' }] : [];
          return [];
        }),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn((values: unknown) => ({ where: vi.fn(async () => { dbWrites.push({ op: 'update', values }); }) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => { dbWrites.push({ op: 'delete' }); }) })),
  };
  const recordK = (op: string, kind: string) => async (args: { body?: unknown } = {}) => { calls.push({ op, kind, body: args.body }); };
  const core = {
    readNamespacedSecret: vi.fn(async () => {
      if (!opts.extraCa) throw notFound();
      return { data: { 'ca-bundle.crt': Buffer.from(opts.extraCa).toString('base64') } };
    }),
    replaceNamespacedSecret: vi.fn(async () => { throw notFound(); }),
    createNamespacedSecret: vi.fn(recordK('create', 'secret')),
    replaceNamespacedConfigMap: vi.fn(async () => { throw notFound(); }),
    createNamespacedConfigMap: vi.fn(recordK('create', 'configmap')),
    readNamespacedService: vi.fn(async () => { throw notFound(); }),
    createNamespacedService: vi.fn(recordK('create', 'service')),
    deleteNamespacedService: vi.fn(recordK('delete', 'service')),
    deleteNamespacedConfigMap: vi.fn(recordK('delete', 'configmap')),
    deleteNamespacedSecret: vi.fn(recordK('delete', 'secret')),
    listNamespacedPod: vi.fn(async () => ({
      items: opts.ready ? [{
        metadata: { name: 'gate-1', annotations: { 'insula.host/config-hash': deploymentHash } },
        status: { conditions: [{ type: 'Ready', status: 'True' }], containerStatuses: [] },
      }] : [],
    })),
    readNamespacedPodLog: vi.fn(async () => ''),
  };
  const apps = {
    readNamespacedDeployment: vi.fn(async () => { throw notFound(); }),
    createNamespacedDeployment: vi.fn(async (args: { body: { spec: { template: { metadata: { annotations: Record<string, string> } } } } }) => {
      deploymentHash = args.body.spec.template.metadata.annotations['insula.host/config-hash']!;
      calls.push({ op: 'create', kind: 'deployment', body: args.body });
    }),
    deleteNamespacedDeployment: vi.fn(recordK('delete', 'deployment')),
  };
  const custom = {
    deleteNamespacedCustomObject: vi.fn(async (args: { name: string }) => { calls.push({ op: 'delete', kind: `ingressroute:${args.name}` }); }),
  };
  const lock = <T>(_id: string, fn: () => Promise<T>) => fn();
  return { deps: { db: db as never, k8s: { core, apps, custom, networking: {} } as never, encryptionKey: 'k', lock }, calls, dbWrites };
}

describe('reconcileTenant', () => {
  beforeEach(() => { listEnabledMock.mockReset(); });

  it('★ creates the Secret, ConfigMap, Service (proxy + gate ports) and Deployment, and removes the old passthrough route', async () => {
    listEnabledMock.mockResolvedValue([row()]);
    const c = cluster({ ready: true });
    const out = await reconcileTenant(c.deps, 't-1', { wait: true, waitTimeoutMs: 10 });
    expect(out).toMatchObject({ action: 'provisioned', error: null, enabledIngresses: 1 });
    expect(c.calls.filter((x) => x.op === 'create').map((x) => x.kind)).toEqual(['secret', 'configmap', 'service', 'deployment']);
    const svc = c.calls.find((x) => x.kind === 'service')!.body as { spec: { ports: Array<{ port: number }> } };
    expect(svc.spec.ports.map((p) => p.port)).toEqual([4180, 4181]);
    expect(c.calls).toContainEqual(expect.objectContaining({ op: 'delete', kind: 'ingressroute:oauth2-proxy-passthrough' }));
    // Success is recorded on the route configs so each form shows it.
    expect(c.dbWrites).toContainEqual({ op: 'update', values: expect.objectContaining({ lastError: null, lastReconciledAt: expect.any(Date) }) });
  });

  it('trusts the platform\'s extra CA when bootstrap installed one', async () => {
    listEnabledMock.mockResolvedValue([row()]);
    const c = cluster({ ready: true, extraCa: '-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----' });
    await reconcileTenant(c.deps, 't-1');
    const cm = c.calls.find((x) => x.kind === 'configmap')!.body as { data: Record<string, string> };
    expect(cm.data['ca-bundle.crt']).toMatch(/BEGIN CERTIFICATE/);
  });

  it('★ a gate that does not become ready is reported — never recorded as a success', async () => {
    listEnabledMock.mockResolvedValue([row()]);
    const c = cluster({ ready: false });
    const out = await reconcileTenant(c.deps, 't-1', { wait: true, waitTimeoutMs: 10 });
    expect(out.error).toMatch(/did not become ready/);
    expect(c.dbWrites).toContainEqual({ op: 'update', values: { lastError: out.error } });
    // Without waiting, a pod still starting leaves the recorded state alone.
    const quick = cluster({ ready: false });
    const q = await reconcileTenant(quick.deps, 't-1');
    expect(q.error).toBeNull();
    expect(quick.dbWrites.some((w) => (w.values as { lastError?: unknown } | undefined)?.lastError === null)).toBe(false);
  });

  it('★ tears everything down when no protected route is left, a half-finished setup included', async () => {
    listEnabledMock.mockResolvedValue([]);
    const c = cluster({ stateRow: true });
    const out = await reconcileTenant(c.deps, 't-1');
    expect(out.action).toBe('torn_down');
    expect(c.calls.filter((x) => x.op === 'delete').map((x) => x.kind).sort())
      .toEqual(['configmap', 'deployment', 'ingressroute:oauth2-proxy-passthrough', 'secret', 'service']);
    expect(c.dbWrites).toContainEqual({ op: 'delete' });
  });

  it('is a noop for a tenant that never had a gate', async () => {
    listEnabledMock.mockResolvedValue([]);
    const c = cluster({ stateRow: false });
    expect((await reconcileTenant(c.deps, 't-1')).action).toBe('noop');
    expect(c.calls).toHaveLength(0);
  });
});

describe('which routes the gate serves', () => {
  it('★ a route on another provider is refused with a reason — never signed in against the first one', () => {
    const first = row({}, 'a.example.test');
    const other = row({}, 'b.example.test');
    (other.provider as { id: string; name: string }).id = 'p-2';
    (other.provider as { id: string; name: string }).name = 'Other';
    const { serve, refused } = partitionServable([first, other]);
    expect(serve.map((r) => r.host)).toEqual(['a.example.test']);
    expect(refused[0]!.reason).toMatch(/"Other".*"Google"/);
  });

  it('a wildcard route is refused with a reason', () => {
    const wild = { ...row({}, '*.example.test'), hostname: '*.example.test' };
    expect(partitionServable([wild]).refused[0]!.reason).toMatch(/wildcard/);
  });

  it('an unparseable legacy post-login URL does not take the gate down', () => {
    expect(() => buildGateArgs([row({ postLoginRedirectUrl: 'not a url' })], { withExtraCa: false })).not.toThrow();
    expect(buildGateArgs([row({ postLoginRedirectUrl: 'https://app.example.test:8443/x' })], { withExtraCa: false }))
      .toContain('--whitelist-domain=app.example.test:8443');
  });
});
