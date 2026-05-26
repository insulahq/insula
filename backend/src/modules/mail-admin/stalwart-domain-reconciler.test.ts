import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runStalwartDomainReconcilerTick } from './stalwart-domain-reconciler.js';

// ── Fake DB ──────────────────────────────────────────────────────────

function dbStub(hostname: string | null) {
  return {
    select: () => ({
      from: () => ({
        where: () => (hostname === null ? [] : [{ key: 'mail_server_hostname', value: hostname }]),
      }),
    }),
  };
}

// ── JMAP transport mock ──────────────────────────────────────────────
//
// Returns canned responses keyed by the JMAP method name in the
// request. Records every call so tests can assert what x:* sequence
// the reconciler issued.

interface JmapMockBehavior {
  domains?: ReadonlyArray<{ id: string; name: string }>;
  acmeProviders?: ReadonlyArray<{ id: string; name: string }>;
  listeners?: ReadonlyArray<{ name: string }>;
  /** If set, the next x:Domain/set create returns this id. */
  newDomainId?: string;
  /** If set, the next x:AcmeProvider/set create returns this id. */
  newAcmeProviderId?: string;
  /** Domain currently-stored certificateManagement (for the get-before-update). */
  certManagement?: {
    '@type': string;
    acmeProviderId?: string;
    subjectAlternativeNames?: Record<string, boolean>;
  };
}

function buildJmapMock(behavior: JmapMockBehavior) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];

  const transport = async (_auth: string, body: unknown) => {
    const req = body as { methodCalls: ReadonlyArray<[string, Record<string, unknown>, string]> };
    const [method, args] = req.methodCalls[0];
    calls.push({ method, args });

    const wrap = (payload: Record<string, unknown>) => ({
      methodResponses: [[method, payload, 'c0']] as ReadonlyArray<[string, Record<string, unknown>, string]>,
    });

    // x:Domain/get with ids:null → full list
    if (method === 'x:Domain/get' && args.ids === null) {
      return wrap({ list: behavior.domains ?? [] });
    }
    // x:Domain/get with ids:[id] → certificateManagement read
    if (method === 'x:Domain/get' && Array.isArray(args.ids)) {
      return wrap({
        list: behavior.certManagement
          ? [{ certificateManagement: behavior.certManagement }]
          : [{}],
      });
    }
    if (method === 'x:Domain/set' && args.create) {
      const id = behavior.newDomainId ?? 'newdomain';
      return wrap({ created: { d: { id } }, notCreated: null });
    }
    if (method === 'x:Domain/set' && args.update) {
      return wrap({ updated: {} });
    }
    if (method === 'x:AcmeProvider/get') {
      return wrap({ list: behavior.acmeProviders ?? [] });
    }
    if (method === 'x:AcmeProvider/set' && args.create) {
      const id = behavior.newAcmeProviderId ?? 'newacme';
      return wrap({ created: { letsencrypt: { id } }, notCreated: null });
    }
    if (method === 'x:NetworkListener/get') {
      return wrap({ list: behavior.listeners ?? [] });
    }
    if (method === 'x:NetworkListener/set') {
      const ids = Object.keys((args.create as Record<string, unknown>) ?? {});
      const created: Record<string, unknown> = {};
      ids.forEach((id) => (created[id] = { id: `nl-${id}` }));
      return wrap({ created, notCreated: null });
    }
    if (method === 'x:Task/set') {
      return wrap({ created: { r: { id: 'task1' } }, notCreated: null });
    }
    return wrap({});
  };

  return { transport, calls };
}

const logger = { warn: () => {}, info: () => {} };

// Stub readStalwartCredentials via env so the transport-bypass path
// inside the reconciler succeeds.
beforeEach(() => {
  vi.stubEnv('STALWART_ADMIN_PASSWORD', 'test-pw');
});

describe('mail-admin stalwart-domain-reconciler', () => {
  it('no-ops when mail_server_hostname is unset', async () => {
    const { transport, calls } = buildJmapMock({});
    await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub(null) as any,
      jmapTransport: transport,
      logger,
    });
    expect(calls).toEqual([]);
  });

  it('on empty Stalwart: creates Domain + AcmeProvider + 3 listeners + fires AcmeRenewal', async () => {
    const { transport, calls } = buildJmapMock({
      domains: [],
      acmeProviders: [],
      listeners: [],
      newDomainId: 'd-new',
      newAcmeProviderId: 'ap-new',
    });
    await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.com') as any,
      jmapTransport: transport,
      logger,
    });
    const methods = calls.map((c) => c.method);
    // Domain get → Domain set create → AcmeProvider get → AcmeProvider set
    // create → Domain get (for certMgmt) → Domain set update → NetworkListener
    // get → NetworkListener set create → Task set AcmeRenewal
    expect(methods).toEqual([
      'x:Domain/get', 'x:Domain/set',
      'x:AcmeProvider/get', 'x:AcmeProvider/set',
      'x:Domain/get', 'x:Domain/set',
      'x:NetworkListener/get', 'x:NetworkListener/set',
      'x:Task/set',
    ]);

    const listenerCreate = calls[7].args.create as Record<string, unknown>;
    expect(Object.keys(listenerCreate).sort()).toEqual(['http-acme', 'imap', 'submission']);
  });

  it('on fully-configured Stalwart: 4 GET calls + fire AcmeRenewal (idempotent)', async () => {
    const { transport, calls } = buildJmapMock({
      domains: [{ id: 'd1', name: 'example.com' }],
      acmeProviders: [{ id: 'ap1', name: 'letsencrypt' }],
      listeners: [
        { name: 'smtp' }, { name: 'submissions' }, { name: 'imaps' },
        { name: 'http-acme' }, { name: 'submission' }, { name: 'imap' },
      ],
      certManagement: {
        '@type': 'Automatic',
        acmeProviderId: 'ap1',
        subjectAlternativeNames: { mail: true },
      },
    });
    await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.com') as any,
      jmapTransport: transport,
      logger,
    });
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual([
      'x:Domain/get', 'x:AcmeProvider/get',
      'x:Domain/get', 'x:NetworkListener/get',
      'x:Task/set',
    ]);
  });

  it('on partial state: creates only the missing listener(s)', async () => {
    const { transport, calls } = buildJmapMock({
      domains: [{ id: 'd1', name: 'example.com' }],
      acmeProviders: [{ id: 'ap1', name: 'letsencrypt' }],
      // http-acme is present, submission + imap missing
      listeners: [{ name: 'smtp' }, { name: 'submissions' }, { name: 'http-acme' }],
      certManagement: {
        '@type': 'Automatic',
        acmeProviderId: 'ap1',
        subjectAlternativeNames: { mail: true },
      },
    });
    await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.com') as any,
      jmapTransport: transport,
      logger,
    });
    const setCall = calls.find((c) => c.method === 'x:NetworkListener/set');
    expect(setCall).toBeDefined();
    const create = setCall!.args.create as Record<string, unknown>;
    expect(Object.keys(create).sort()).toEqual(['imap', 'submission']);
  });

  it('apex derivation: strips mail. prefix and picks correct SAN', async () => {
    const { transport, calls } = buildJmapMock({
      domains: [],
      acmeProviders: [],
      listeners: [],
    });
    await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.staging.example.test') as any,
      jmapTransport: transport,
      logger,
    });
    const domainSet = calls.find((c) => c.method === 'x:Domain/set' && c.args.create);
    const create = domainSet!.args.create as Record<string, { name: string }>;
    expect(create.d.name).toBe('staging.example.test');
  });

  it('apex derivation: no mail. prefix → uses hostname as-is', async () => {
    const { transport, calls } = buildJmapMock({ domains: [], acmeProviders: [], listeners: [] });
    await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mx1.example.com') as any,
      jmapTransport: transport,
      logger,
    });
    const domainSet = calls.find((c) => c.method === 'x:Domain/set' && c.args.create);
    const create = domainSet!.args.create as Record<string, { name: string }>;
    expect(create.d.name).toBe('mx1.example.com');
  });

  it('result shape: noOp=false + correct booleans on fresh install', async () => {
    const { transport } = buildJmapMock({ domains: [], acmeProviders: [], listeners: [] });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.com') as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.apex).toBe('example.com');
    expect(result.sanKey).toBe('mail');
    expect(result.domainCreated).toBe(true);
    expect(result.acmeProviderCreated).toBe(true);
    expect(result.certManagementUpdated).toBe(true);
    expect(result.listenersCreated.sort()).toEqual(['http-acme', 'imap', 'submission']);
    expect(result.acmeRenewalFired).toBe(true);
    expect(result.noOp).toBe(false);
  });

  it('result shape: noOp=true + all booleans false on fully-configured cluster', async () => {
    const { transport } = buildJmapMock({
      domains: [{ id: 'd1', name: 'example.com' }],
      acmeProviders: [{ id: 'ap1', name: 'letsencrypt' }],
      listeners: [{ name: 'http-acme' }, { name: 'submission' }, { name: 'imap' }],
      certManagement: {
        '@type': 'Automatic',
        acmeProviderId: 'ap1',
        subjectAlternativeNames: { mail: true },
      },
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.com') as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.domainCreated).toBe(false);
    expect(result.acmeProviderCreated).toBe(false);
    expect(result.certManagementUpdated).toBe(false);
    expect(result.listenersCreated).toEqual([]);
    // AcmeRenewal still fires (Stalwart-side idempotent), but noOp
    // gates on whether anything CHANGED on our side.
    expect(result.noOp).toBe(true);
  });

  it('result shape: empty hostname yields noOp with explanatory note', async () => {
    const { transport } = buildJmapMock({});
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub(null) as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.apex).toBeNull();
    expect(result.noOp).toBe(true);
    expect(result.notes[0]).toMatch(/mail_server_hostname/);
  });
});
