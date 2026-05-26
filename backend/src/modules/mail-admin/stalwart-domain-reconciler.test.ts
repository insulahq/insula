import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runStalwartDomainReconcilerTick } from './stalwart-domain-reconciler.js';

// ── Fake DB ──────────────────────────────────────────────────────────
//
// Reconciler reads platform_settings.mail_server_hostname DIRECTLY
// (no fallback chain — must be explicitly set). The dbStub returns
// a Drizzle-shape result for that lookup.

function dbStub(hostname: string | null) {
  return {
    select: () => ({
      from: () => ({
        where: () => (hostname ? [{ key: 'mail_server_hostname', value: hostname }] : []),
      }),
    }),
  };
}

// ── JMAP transport mock ──────────────────────────────────────────────

interface JmapMockBehavior {
  /** Existing AcmeProvider list — non-empty means already present. */
  acmeProviders?: ReadonlyArray<{ id: string }>;
  /** Existing NetworkListener names. */
  listeners?: ReadonlyArray<{ name: string }>;
  /** Current SystemSettings.defaultHostname. Empty string by default. */
  defaultHostname?: string;
  /** ID Stalwart returns after a new AcmeProvider create. */
  newAcmeProviderId?: string;
}

function buildJmapMock(behavior: JmapMockBehavior) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  // Mutate when the reconciler calls SystemSettings/set so a follow-up
  // SystemSettings/get (e.g. a same-tick re-read in future tests) sees
  // the new value. Today the reconciler only calls /get once per tick.
  let liveDefaultHostname = behavior.defaultHostname ?? '';
  // x:AcmeProvider/get returns whatever the most-recent /set created.
  let currentAcme = behavior.acmeProviders ? [...behavior.acmeProviders] : [];

  const transport = async (_auth: string, body: unknown) => {
    const req = body as { methodCalls: ReadonlyArray<[string, Record<string, unknown>, string]> };
    const [method, args] = req.methodCalls[0];
    calls.push({ method, args });

    const wrap = (payload: Record<string, unknown>) => ({
      methodResponses: [[method, payload, 'c0']] as ReadonlyArray<[string, Record<string, unknown>, string]>,
    });

    if (method === 'x:SystemSettings/get') {
      return wrap({ list: [{ defaultHostname: liveDefaultHostname }] });
    }
    if (method === 'x:SystemSettings/set') {
      const upd = (args.update as Record<string, Record<string, unknown>> | undefined)?.singleton;
      if (upd && typeof upd.defaultHostname === 'string') {
        liveDefaultHostname = upd.defaultHostname;
      }
      return wrap({ updated: {} });
    }
    if (method === 'x:AcmeProvider/get') {
      return wrap({ list: currentAcme });
    }
    if (method === 'x:AcmeProvider/set' && args.create) {
      const id = behavior.newAcmeProviderId ?? 'newacme';
      currentAcme = [{ id }];
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
    return wrap({});
  };

  return { transport, calls };
}

const logger = { warn: () => {}, info: () => {} };

beforeEach(() => {
  vi.stubEnv('STALWART_ADMIN_PASSWORD', 'test-pw');
});

describe('mail-admin stalwart-domain-reconciler', () => {
  it('no-ops with explanatory note when mail_server_hostname is unset', async () => {
    const { transport, calls } = buildJmapMock({});
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub(null) as any,
      jmapTransport: transport,
      logger,
    });
    expect(calls).toEqual([]);
    expect(result.mailHostname).toBeNull();
    expect(result.noOp).toBe(true);
    expect(result.notes[0]).toMatch(/mail_server_hostname is not set/);
  });

  it('fresh Stalwart: syncs hostname + creates AcmeProvider + creates 3 listeners (no Domain or AcmeRenewal)', async () => {
    const { transport, calls } = buildJmapMock({
      acmeProviders: [],
      listeners: [],
      defaultHostname: '',
      newAcmeProviderId: 'ap-new',
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    const methods = calls.map((c) => c.method);
    // Note the second x:AcmeProvider/get: that's the defensive
    // read-back after create to capture the hash ID Stalwart
    // assigns (see ensureAcmeProvider comment for rationale).
    expect(methods).toEqual([
      'x:SystemSettings/get', 'x:SystemSettings/set',
      'x:AcmeProvider/get', 'x:AcmeProvider/set', 'x:AcmeProvider/get',
      'x:NetworkListener/get', 'x:NetworkListener/set',
    ]);
    // x:Domain/* and x:Task/* should NEVER be invoked — those are
    // tenant-flow concerns.
    expect(methods.some((m) => m.startsWith('x:Domain'))).toBe(false);
    expect(methods.some((m) => m.startsWith('x:Task'))).toBe(false);

    expect(result.mailHostname).toBe('mail.example.net');
    expect(result.defaultHostnameUpdated).toBe(true);
    expect(result.acmeProviderCreated).toBe(true);
    expect(result.listenersCreated.sort()).toEqual(['http-acme', 'imap', 'submission']);
    expect(result.noOp).toBe(false);

    // AcmeProvider create body uses bootstrap-compatible shape:
    // `directory` (not directoryUrl), contact map keyed by
    // hostmaster@<apex>, no `name` field.
    const acmeCreate = (calls.find((c) => c.method === 'x:AcmeProvider/set')!.args.create as Record<string, Record<string, unknown>>).letsencrypt;
    expect(acmeCreate).toHaveProperty('directory');
    expect(acmeCreate).not.toHaveProperty('directoryUrl');
    expect(acmeCreate).not.toHaveProperty('name');
    expect(acmeCreate).toHaveProperty('contact');
  });

  it('fully-configured: 3 GETs only (no writes), noOp=true', async () => {
    const { transport, calls } = buildJmapMock({
      acmeProviders: [{ id: 'ap1' }],
      listeners: [{ name: 'http-acme' }, { name: 'submission' }, { name: 'imap' }],
      defaultHostname: 'mail.example.net',
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    const methods = calls.map((c) => c.method);
    expect(methods).toEqual(['x:SystemSettings/get', 'x:AcmeProvider/get', 'x:NetworkListener/get']);
    expect(result.defaultHostnameUpdated).toBe(false);
    expect(result.acmeProviderCreated).toBe(false);
    expect(result.listenersCreated).toEqual([]);
    expect(result.noOp).toBe(true);
  });

  it('partial state: creates only the missing listeners', async () => {
    const { transport, calls } = buildJmapMock({
      acmeProviders: [{ id: 'ap1' }],
      listeners: [{ name: 'http-acme' }],
      defaultHostname: 'mail.example.net',
    });
    await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    const setCall = calls.find((c) => c.method === 'x:NetworkListener/set');
    expect(setCall).toBeDefined();
    const create = setCall!.args.create as Record<string, unknown>;
    expect(Object.keys(create).sort()).toEqual(['imap', 'submission']);
  });

  it('hostname is case-normalised on the way to Stalwart', async () => {
    const { transport, calls } = buildJmapMock({ defaultHostname: '' });
    await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('MAIL.Example.NET') as any,
      jmapTransport: transport,
      logger,
    });
    const setCall = calls.find((c) => c.method === 'x:SystemSettings/set');
    const upd = (setCall!.args.update as Record<string, Record<string, unknown>>).singleton;
    expect(upd.defaultHostname).toBe('mail.example.net');
  });

  it('hostname already in sync: skips SystemSettings/set patch (only the GET)', async () => {
    const { transport, calls } = buildJmapMock({
      defaultHostname: 'mail.example.net',
      listeners: [{ name: 'http-acme' }, { name: 'submission' }, { name: 'imap' }],
      acmeProviders: [{ id: 'ap1' }],
    });
    await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    expect(calls.filter((c) => c.method === 'x:SystemSettings/set')).toHaveLength(0);
  });
});
