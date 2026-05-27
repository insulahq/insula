import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runStalwartDomainReconcilerTick } from './stalwart-domain-reconciler.js';

// ── Fake DB ──────────────────────────────────────────────────────────

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
  domains?: ReadonlyArray<{ id: string; name: string; certificateManagement?: Record<string, unknown> }>;
  acmeProviders?: ReadonlyArray<{ id: string }>;
  listeners?: ReadonlyArray<{ name: string }>;
  defaultHostname?: string;
  defaultDomainId?: string;
  newAcmeProviderId?: string;
}

function buildJmapMock(behavior: JmapMockBehavior) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let liveDefaultHostname = behavior.defaultHostname ?? '';
  let liveDefaultDomainId = behavior.defaultDomainId ?? '';
  let currentAcme = behavior.acmeProviders ? [...behavior.acmeProviders] : [];

  const transport = async (_auth: string, body: unknown) => {
    const req = body as { methodCalls: ReadonlyArray<[string, Record<string, unknown>, string]> };
    const [method, args] = req.methodCalls[0];
    calls.push({ method, args });

    const wrap = (payload: Record<string, unknown>) => ({
      methodResponses: [[method, payload, 'c0']] as ReadonlyArray<[string, Record<string, unknown>, string]>,
    });

    if (method === 'x:Domain/query') {
      return wrap({ ids: (behavior.domains ?? []).map((d) => d.id) });
    }
    if (method === 'x:Domain/get') {
      const ids = args.ids as string[] | null;
      const list = (behavior.domains ?? []).filter((d) => ids === null || ids.includes(d.id));
      return wrap({ list });
    }
    if (method === 'x:Domain/set') {
      return wrap({ updated: {} });
    }
    if (method === 'x:SystemSettings/get') {
      return wrap({ list: [{ defaultHostname: liveDefaultHostname, defaultDomainId: liveDefaultDomainId }] });
    }
    if (method === 'x:SystemSettings/set') {
      const upd = (args.update as Record<string, Record<string, unknown>> | undefined)?.singleton;
      if (upd) {
        if (typeof upd.defaultHostname === 'string') liveDefaultHostname = upd.defaultHostname;
        if (typeof upd.defaultDomainId === 'string') liveDefaultDomainId = upd.defaultDomainId;
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
    if (method === 'x:Task/set') {
      return wrap({ created: { r: { id: 'task1' } }, notCreated: null });
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
  it('no-ops when mail_server_hostname is unset', async () => {
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
    expect(result.noOp).toBe(true);
    expect(result.notes[0]).toMatch(/mail_server_hostname is not set/);
  });

  it('no-ops with note when no Stalwart Domain matches the hostname exactly', async () => {
    const { transport } = buildJmapMock({
      // Apex Domain exists but NOT the mail hostname.
      domains: [{ id: 'd1', name: 'example.net' }],
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.matchedDomain).toBeNull();
    expect(result.noOp).toBe(true);
    expect(result.notes[0]).toMatch(/add it via Admin UI → Email → Domains & Relays/);
  });

  it('matches via EXACT Domain.name = hostname (apex Domain ignored)', async () => {
    const { transport } = buildJmapMock({
      domains: [
        { id: 'd-apex', name: 'example.net' },
        { id: 'd-host', name: 'mail.example.net' },
      ],
      acmeProviders: [{ id: 'ap1' }],
      defaultHostname: 'mail.example.net',
      defaultDomainId: 'd-host',
      listeners: [{ name: 'http-acme' }, { name: 'submission' }, { name: 'imap' }],
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.matchedDomain).toEqual({ id: 'd-host', name: 'mail.example.net' });
    expect(result.sanKey).toBeNull(); // no SAN map in new architecture
  });

  it('fresh cluster (Domain exists, nothing else): syncs everything + listeners + AcmeRenewal', async () => {
    const { transport, calls } = buildJmapMock({
      domains: [{ id: 'd1', name: 'mail.example.net' }],
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
    expect(result.mailHostname).toBe('mail.example.net');
    expect(result.matchedDomain?.id).toBe('d1');
    expect(result.defaultHostnameUpdated).toBe(true);
    expect(result.acmeProviderCreated).toBe(true);
    expect(result.certManagementUpdated).toBe(true);
    expect(result.listenersCreated.sort()).toEqual(['http-acme', 'imap', 'submission']);
    expect(result.acmeRenewalFired).toBe(true);
    expect(result.noOp).toBe(false);

    // SystemSettings/set must include BOTH fields.
    const ssSet = calls.find((c) => c.method === 'x:SystemSettings/set')!;
    const upd = (ssSet.args.update as Record<string, Record<string, unknown>>).singleton;
    expect(upd.defaultHostname).toBe('mail.example.net');
    expect(upd.defaultDomainId).toBe('d1');

    // Domain/set body MUST NOT include subjectAlternativeNames.
    const dSet = calls.find((c) => c.method === 'x:Domain/set')!;
    const cm = ((dSet.args.update as Record<string, Record<string, unknown>>).d1
      .certificateManagement as Record<string, unknown>);
    expect(cm['@type']).toBe('Automatic');
    expect(cm.acmeProviderId).toBe('ap-new');
    expect(cm).not.toHaveProperty('subjectAlternativeNames');
  });

  it('fully-configured: reads only + AcmeRenewal fire', async () => {
    const { transport, calls } = buildJmapMock({
      domains: [{
        id: 'd1',
        name: 'mail.example.net',
        certificateManagement: { '@type': 'Automatic', acmeProviderId: 'ap1' },
      }],
      acmeProviders: [{ id: 'ap1' }],
      listeners: [{ name: 'http-acme' }, { name: 'submission' }, { name: 'imap' }],
      defaultHostname: 'mail.example.net',
      defaultDomainId: 'd1',
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.defaultHostnameUpdated).toBe(false);
    expect(result.acmeProviderCreated).toBe(false);
    expect(result.certManagementUpdated).toBe(false);
    expect(result.listenersCreated).toEqual([]);
    expect(result.acmeRenewalFired).toBe(true);
    expect(result.noOp).toBe(true);
    const setCalls = calls.filter((c) => c.method.endsWith('/set'));
    expect(setCalls.map((c) => c.method)).toEqual(['x:Task/set']);
  });

  it('partial: Manual certMgmt → patches to Automatic without SAN map', async () => {
    const { transport, calls } = buildJmapMock({
      domains: [{
        id: 'd1',
        name: 'mail.example.net',
        certificateManagement: { '@type': 'Manual' },
      }],
      acmeProviders: [{ id: 'ap1' }],
      listeners: [{ name: 'http-acme' }, { name: 'submission' }, { name: 'imap' }],
      defaultHostname: 'mail.example.net',
      defaultDomainId: 'd1',
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.certManagementUpdated).toBe(true);
    const dSet = calls.find((c) => c.method === 'x:Domain/set')!;
    const cm = ((dSet.args.update as Record<string, Record<string, unknown>>).d1
      .certificateManagement as Record<string, unknown>);
    expect(cm).not.toHaveProperty('subjectAlternativeNames');
  });

  it('partial: only missing listeners → creates only those', async () => {
    const { transport, calls } = buildJmapMock({
      domains: [{
        id: 'd1',
        name: 'mail.example.net',
        certificateManagement: { '@type': 'Automatic', acmeProviderId: 'ap1' },
      }],
      acmeProviders: [{ id: 'ap1' }],
      listeners: [{ name: 'http-acme' }],
      defaultHostname: 'mail.example.net',
      defaultDomainId: 'd1',
    });
    await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    const setCall = calls.find((c) => c.method === 'x:NetworkListener/set')!;
    const create = setCall.args.create as Record<string, unknown>;
    expect(Object.keys(create).sort()).toEqual(['imap', 'submission']);
  });

  it('hostname case-normalised on the way to Stalwart', async () => {
    const { transport, calls } = buildJmapMock({
      domains: [{ id: 'd1', name: 'mail.example.net' }],
    });
    await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('MAIL.Example.NET') as any,
      jmapTransport: transport,
      logger,
    });
    const ssSet = calls.find((c) => c.method === 'x:SystemSettings/set');
    const upd = (ssSet!.args.update as Record<string, Record<string, unknown>>).singleton;
    expect(upd.defaultHostname).toBe('mail.example.net');
  });
});
