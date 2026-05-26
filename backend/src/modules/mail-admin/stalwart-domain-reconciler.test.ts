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
  /** Domain rows on the cluster. */
  domains?: ReadonlyArray<{ id: string; name: string; certificateManagement?: Record<string, unknown> }>;
  /** Existing AcmeProvider list. Hash ID matters; the reconciler reads it back. */
  acmeProviders?: ReadonlyArray<{ id: string }>;
  /** Existing NetworkListener names. */
  listeners?: ReadonlyArray<{ name: string }>;
  /** Current SystemSettings.defaultHostname / defaultDomainId. */
  defaultHostname?: string;
  defaultDomainId?: string;
  /** ID Stalwart returns when a new AcmeProvider is created (read back via /get). */
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

  it('no-ops when no Stalwart Domain matches the hostname (no apex)', async () => {
    const { transport, calls } = buildJmapMock({ domains: [] });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    // Only Domain/query (which returned empty ids).
    expect(calls.map((c) => c.method)).toEqual(['x:Domain/query']);
    expect(result.matchedDomain).toBeNull();
    expect(result.noOp).toBe(true);
    expect(result.notes[0]).toMatch(/No Stalwart Domain matches/);
  });

  it('matches Domain via longest-suffix; SAN key = hostname prefix relative to Domain', async () => {
    const { transport, calls } = buildJmapMock({
      domains: [{ id: 'd1', name: 'example.net' }],
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
    expect(result.matchedDomain).toEqual({ id: 'd1', name: 'example.net' });
    expect(result.sanKey).toBe('mail');
    expect(result.defaultHostnameUpdated).toBe(true);
    expect(result.acmeProviderCreated).toBe(true);
    expect(result.certManagementUpdated).toBe(true);
    expect(result.listenersCreated.sort()).toEqual(['http-acme', 'imap', 'submission']);
    expect(result.acmeRenewalFired).toBe(true);
    expect(result.noOp).toBe(false);

    // SystemSettings/set must include BOTH defaultHostname AND defaultDomainId.
    const ssSet = calls.find((c) => c.method === 'x:SystemSettings/set')!;
    const upd = (ssSet.args.update as Record<string, Record<string, unknown>>).singleton;
    expect(upd.defaultHostname).toBe('mail.example.net');
    expect(upd.defaultDomainId).toBe('d1');

    // AcmeProvider/set body shape matches bootstrap: directory + contact + no name.
    const acmeCreate = (calls.find((c) => c.method === 'x:AcmeProvider/set')!.args.create as Record<string, Record<string, unknown>>).letsencrypt;
    expect(acmeCreate).toHaveProperty('directory');
    expect(acmeCreate).not.toHaveProperty('name');
    expect(acmeCreate.contact).toEqual({ 'hostmaster@example.net': true });
  });

  it('hostname IS Domain.name (no prefix): SAN key = "@"', async () => {
    const { transport } = buildJmapMock({
      domains: [{ id: 'd1', name: 'example.net' }],
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('example.net') as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.sanKey).toBe('@');
  });

  it('longest-suffix wins over shorter suffix (E2E temp-hostname case)', async () => {
    const { transport } = buildJmapMock({
      domains: [
        { id: 'd-short', name: 'example.net' },
        { id: 'd-long', name: 'staging.example.net' },
      ],
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail-e2e-1234.staging.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.matchedDomain?.id).toBe('d-long');
    expect(result.sanKey).toBe('mail-e2e-1234');
  });

  it('fully-configured: reads only, no patches; AcmeRenewal still fires (idempotent)', async () => {
    const { transport, calls } = buildJmapMock({
      domains: [{
        id: 'd1',
        name: 'example.net',
        certificateManagement: {
          '@type': 'Automatic',
          acmeProviderId: 'ap1',
          subjectAlternativeNames: { mail: true },
        },
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
    expect(result.acmeRenewalFired).toBe(true); // task fire is always issued (Stalwart noops it)
    expect(result.noOp).toBe(true);

    // No /set calls except Task/set.
    const setCalls = calls.filter((c) => c.method.endsWith('/set'));
    expect(setCalls.map((c) => c.method)).toEqual(['x:Task/set']);
  });

  it('partial: existing Automatic + acmeProviderId but missing our SAN → patches in', async () => {
    const { transport, calls } = buildJmapMock({
      domains: [{
        id: 'd1',
        name: 'example.net',
        certificateManagement: {
          '@type': 'Automatic',
          acmeProviderId: 'ap1',
          subjectAlternativeNames: { 'old-host': true }, // existing SANs from another hostname
        },
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

    // Verify MERGE — both old-host AND mail SAN keys present.
    const domainSet = calls.find((c) => c.method === 'x:Domain/set')!;
    const cm = ((domainSet.args.update as Record<string, Record<string, unknown>>).d1
      .certificateManagement as Record<string, unknown>);
    const sans = cm.subjectAlternativeNames as Record<string, boolean>;
    expect(sans['old-host']).toBe(true);
    expect(sans.mail).toBe(true);
  });
});
