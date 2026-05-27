import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runStalwartDomainReconcilerTick } from './stalwart-domain-reconciler.js';

// ── Fake DB ──────────────────────────────────────────────────────────

interface DbStubOpts {
  readonly mailHostname?: string | null;
  readonly ingressBaseDomain?: string | null;
}

/**
 * Stub the platform_settings table — looks up per-call to support
 * multiple keys (mail_server_hostname, ingress_base_domain). Pass a
 * plain string for back-compat: dbStub('mail.example.net') is treated
 * as { mailHostname: 'mail.example.net' }.
 *
 * Drizzle's eq(col, value) returns an SQL expression with a
 * `queryChunks` array; the second chunk's `.value` holds the
 * compared literal. Extract that to dispatch the lookup.
 */
function dbStub(arg: string | DbStubOpts | null) {
  const opts: DbStubOpts = arg == null
    ? {}
    : typeof arg === 'string'
      ? { mailHostname: arg }
      : arg;
  const table: Record<string, string> = {};
  if (opts.mailHostname) table['mail_server_hostname'] = opts.mailHostname;
  if (opts.ingressBaseDomain) table['ingress_base_domain'] = opts.ingressBaseDomain;
  const extractKey = (whereExpr: unknown): string | null => {
    const chunks = (whereExpr as { queryChunks?: ReadonlyArray<{ value?: unknown; constructor?: { name?: string } }> })?.queryChunks;
    if (!chunks) return null;
    // Drizzle's eq(col, lit) renders as [StringChunk, Column, StringChunk(' = '),
    // Param(lit), StringChunk]. Pick the Param chunk's value.
    for (const chunk of chunks) {
      if (chunk?.constructor?.name === 'Param' && typeof chunk.value === 'string') {
        return chunk.value;
      }
    }
    return null;
  };
  return {
    select: () => ({
      from: () => ({
        where: (whereExpr: unknown) => {
          const key = extractKey(whereExpr);
          if (key && table[key]) return [{ key, value: table[key] }];
          return [];
        },
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
  const liveDomains: Array<{ id: string; name: string; certificateManagement?: Record<string, unknown> }>
    = behavior.domains ? [...behavior.domains] : [];
  let nextDomainSerial = 1;

  const transport = async (_auth: string, body: unknown) => {
    const req = body as { methodCalls: ReadonlyArray<[string, Record<string, unknown>, string]> };
    const [method, args] = req.methodCalls[0];
    calls.push({ method, args });

    const wrap = (payload: Record<string, unknown>) => ({
      methodResponses: [[method, payload, 'c0']] as ReadonlyArray<[string, Record<string, unknown>, string]>,
    });

    if (method === 'x:Domain/query') {
      return wrap({ ids: liveDomains.map((d) => d.id) });
    }
    if (method === 'x:Domain/get') {
      const ids = args.ids as string[] | null;
      const list = liveDomains.filter((d) => ids === null || ids.includes(d.id));
      return wrap({ list });
    }
    if (method === 'x:Domain/set') {
      const create = args.create as Record<string, { name: string }> | undefined;
      const created: Record<string, { id: string }> = {};
      if (create) {
        for (const [key, value] of Object.entries(create)) {
          const newId = `auto-${nextDomainSerial++}`;
          liveDomains.push({ id: newId, name: value.name });
          created[key] = { id: newId };
        }
      }
      return wrap({ updated: {}, created });
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

  it('AUTO-CREATES the cert-anchor Domain when missing (self-heals lost mail-hostname Domain)', async () => {
    const { transport, calls } = buildJmapMock({
      // Apex tenant Domain exists but NOT the mail-hostname cert anchor.
      // This is exactly the state we caught on staging.example.test
      // on 2026-05-27 — the reconciler had been a no-op for weeks.
      domains: [{ id: 'd1', name: 'example.net' }],
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub({ mailHostname: 'mail.example.net', ingressBaseDomain: 'example.net' }) as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.certAnchorDomainCreated).toBe(true);
    expect(result.matchedDomain).not.toBeNull();
    expect(result.matchedDomain?.name).toBe('mail.example.net');
    expect(result.noOp).toBe(false);
    // The create call MUST have happened before the certManagement patch.
    const createIdx = calls.findIndex(
      (c) => c.method === 'x:Domain/set' && c.args.create !== undefined,
    );
    const updateIdx = calls.findIndex(
      (c) => c.method === 'x:Domain/set' && c.args.update !== undefined,
    );
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(createIdx);
    // AcmeProvider contact MUST use the platform apex (ingress_base_domain),
    // NOT the mail hostname — caught as a related bug during the same
    // session. LE accepts either format but apex matches bootstrap.sh.
    const acmeCreate = calls.find(
      (c) => c.method === 'x:AcmeProvider/set' && c.args.create !== undefined,
    );
    const provider = (acmeCreate!.args.create as Record<string, { contact: Record<string, boolean> }>).letsencrypt;
    expect(Object.keys(provider.contact)).toEqual(['hostmaster@example.net']);
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

    // Domain/set body MUST include explicit subjectAlternativeNames
    // with exactly {matched-domain-name: true} — see reconciler header
    // for why (autoconfig SAN auto-derivation is operationally toxic).
    const dSet = calls.find((c) => c.method === 'x:Domain/set')!;
    const cm = ((dSet.args.update as Record<string, Record<string, unknown>>).d1
      .certificateManagement as Record<string, unknown>);
    expect(cm['@type']).toBe('Automatic');
    expect(cm.acmeProviderId).toBe('ap-new');
    expect(cm.subjectAlternativeNames).toEqual({ 'mail.example.net': true });
  });

  it('fully-configured: reads only + AcmeRenewal fire', async () => {
    const { transport, calls } = buildJmapMock({
      domains: [{
        id: 'd1',
        name: 'mail.example.net',
        certificateManagement: {
          '@type': 'Automatic',
          acmeProviderId: 'ap1',
          subjectAlternativeNames: { 'mail.example.net': true },
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
    expect(result.acmeRenewalFired).toBe(true);
    expect(result.noOp).toBe(true);
    const setCalls = calls.filter((c) => c.method.endsWith('/set'));
    expect(setCalls.map((c) => c.method)).toEqual(['x:Task/set']);
  });

  it('partial: Manual certMgmt → patches to Automatic with explicit SAN map', async () => {
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
    expect(cm.subjectAlternativeNames).toEqual({ 'mail.example.net': true });
  });

  it('drift: Automatic + correct acmeProvider but EMPTY SAN map → re-patches with explicit SAN', async () => {
    // Catches the legacy bootstrap output (subjectAlternativeNames:{})
    // which silently enrols autoconfig./autodiscover./mta-sts. SANs in
    // the next ACME order. The reconciler now treats empty SAN as drift.
    const { transport, calls } = buildJmapMock({
      domains: [{
        id: 'd1',
        name: 'mail.example.net',
        certificateManagement: {
          '@type': 'Automatic',
          acmeProviderId: 'ap1',
          subjectAlternativeNames: {},
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
    const dSet = calls.find((c) => c.method === 'x:Domain/set')!;
    const cm = ((dSet.args.update as Record<string, Record<string, unknown>>).d1
      .certificateManagement as Record<string, unknown>);
    expect(cm.subjectAlternativeNames).toEqual({ 'mail.example.net': true });
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
