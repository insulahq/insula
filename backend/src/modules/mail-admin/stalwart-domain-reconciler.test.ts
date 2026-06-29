import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runStalwartDomainReconcilerTick,
  issuerIsSelfSigned,
  __resetStalwartForceStateForTest,
  STALWART_DOMAIN_RECONCILER_TICK_MS,
  type ServedCertResult,
} from './stalwart-domain-reconciler.js';

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
  /** Pre-existing Stalwart task queue (x:Task/query + x:Task/get). */
  tasks?: ReadonlyArray<Record<string, unknown>>;
  /** Stored x:Certificate objects (issued certs). */
  certificates?: ReadonlyArray<Record<string, unknown>>;
  /**
   * MtaStageAuth singleton's `require.else` expression. Defaults to the
   * CANONICAL post-fix value so fully-configured fixtures stay no-op on
   * step 7a (the reconciler only issues x:MtaStageAuth/set when this
   * differs). Set to Stalwart's default `local_port != 25` to exercise the
   * exemption being applied.
   */
  mtaAuthRequireElse?: string;
}

function buildJmapMock(behavior: JmapMockBehavior) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let liveDefaultHostname = behavior.defaultHostname ?? '';
  let liveDefaultDomainId = behavior.defaultDomainId ?? '';
  let currentAcme = behavior.acmeProviders ? [...behavior.acmeProviders] : [];
  const liveDomains: Array<{ id: string; name: string; certificateManagement?: Record<string, unknown> }>
    = behavior.domains ? [...behavior.domains] : [];
  let nextDomainSerial = 1;
  // Live task queue — x:Task/set APPENDS here so a created AcmeRenewal
  // is visible to subsequent x:Task/query within the same tick, exactly
  // like real Stalwart (this is what the storm-fix dedup gate reads).
  const liveTasks: Array<Record<string, unknown>> = behavior.tasks ? [...behavior.tasks] : [];
  let nextTaskSerial = 1;
  // MtaStageAuth singleton's require.else — x:MtaStageAuth/set mutates it
  // so a follow-up get within the same tick reflects the change, mirroring
  // the real singleton. Defaults to the canonical post-fix expr (idempotent).
  let liveMtaAuthRequireElse = behavior.mtaAuthRequireElse ?? 'local_port != 25 && local_port != 12025';

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
      const create = args.create as Record<string, Record<string, unknown>> | undefined;
      const id = `task${nextTaskSerial++}`;
      if (create?.r) {
        liveTasks.push({ ...create.r, id, status: { '@type': 'Pending' } });
      }
      return wrap({ created: { r: { id } }, notCreated: null });
    }
    if (method === 'x:Task/query') {
      return wrap({ ids: liveTasks.map((t) => t.id as string) });
    }
    if (method === 'x:Task/get') {
      const ids = args.ids as string[] | null;
      return wrap({ list: liveTasks.filter((t) => ids === null || ids.includes(t.id as string)) });
    }
    if (method === 'x:Certificate/get') {
      return wrap({ list: behavior.certificates ? [...behavior.certificates] : [] });
    }
    if (method === 'x:MtaStageAuth/get') {
      // The singleton always exists in a real store; `match` is an OBJECT,
      // `else` an expression STRING. Other fields (saslMechanisms, …) are
      // present so a test could assert the update preserves them by sending
      // ONLY `require`.
      return wrap({
        list: [{
          id: 'singleton',
          require: { match: {}, else: liveMtaAuthRequireElse },
          saslMechanisms: ['PLAIN', 'LOGIN'],
          mustMatchSender: true,
        }],
      });
    }
    if (method === 'x:MtaStageAuth/set') {
      const upd = (args.update as Record<string, Record<string, unknown>> | undefined)?.singleton;
      const req = upd?.require as { else?: unknown } | undefined;
      if (typeof req?.else === 'string') liveMtaAuthRequireElse = req.else;
      return wrap({ updated: { singleton: null } });
    }
    return wrap({});
  };

  return { transport, calls };
}

const logger = { warn: () => {}, info: () => {} };

// All NetworkListeners the reconciler requires present: 3 base
// (http-acme/submission/imap) + 6 dedicated PROXY-protocol listeners added
// 2026-06-29. A "fully configured" fixture must list all of them, otherwise
// ensureRequiredListeners creates the missing `-proxy` ones and flips noOp.
const ALL_REQUIRED_LISTENERS = [
  { name: 'http-acme' }, { name: 'submission' }, { name: 'imap' },
  { name: 'smtp-proxy' }, { name: 'submissions-proxy' }, { name: 'submission-proxy' },
  { name: 'imap-proxy' }, { name: 'imaps-proxy' }, { name: 'sieve-proxy' },
];

beforeEach(() => {
  vi.stubEnv('STALWART_ADMIN_PASSWORD', 'test-pw');
});

describe('mail-admin stalwart-domain-reconciler', () => {
  it('no-ops when BOTH mail_server_hostname AND ingress_base_domain are unset', async () => {
    // Pre-2026-05-27: this test only checked mail_server_hostname.
    // The fix made the reconciler use the same resolution chain as the
    // admin UI (mail.<ingress_base_domain> fallback) — so the no-op
    // path now only fires when neither source is available.
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
    expect(result.notes[0]).toMatch(/Mail hostname could not be resolved/);
  });

  it('uses mail.<ingress_base_domain> when mail_server_hostname row is unset (matches admin UI fallback)', async () => {
    // Bootstrap.sh wires Stalwart's STALWART_HOSTNAME via the configure
    // pod's Secret but does NOT write platform_settings.mail_server_hostname.
    // Pre-fix the reconciler refused to act in this state — the operator
    // saw "mail hostname not set" while the admin UI happily showed
    // mail.<apex>. Post-fix the reconciler resolves the same value.
    const { transport, calls } = buildJmapMock({
      domains: [{
        id: 'd-host',
        name: 'mail.example.net',
        certificateManagement: {
          '@type': 'Automatic',
          acmeProviderId: 'ap1',
          subjectAlternativeNames: { 'mail.example.net': true },
        },
      }],
      acmeProviders: [{ id: 'ap1' }],
      listeners: ALL_REQUIRED_LISTENERS,
      defaultHostname: 'mail.example.net',
      defaultDomainId: 'd-host',
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub({ mailHostname: null, ingressBaseDomain: 'example.net' }) as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.mailHostname).toBe('mail.example.net');
    expect(result.matchedDomain?.id).toBe('d-host');
    expect(result.noOp).toBe(true); // fully configured → only AcmeRenewal fires
    expect(calls.length).toBeGreaterThan(0);
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
      listeners: ALL_REQUIRED_LISTENERS,
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
    // 3 base listeners + 6 dedicated PROXY-protocol listeners.
    expect(result.listenersCreated.slice().sort()).toEqual([
      'http-acme', 'imap', 'imap-proxy', 'imaps-proxy', 'sieve-proxy',
      'smtp-proxy', 'submission', 'submission-proxy', 'submissions-proxy',
    ]);
    expect(result.acmeRenewalFired).toBe(true);
    expect(result.noOp).toBe(false);

    // Dedicated `-proxy` listeners are created CARRYING the pod-CIDR trust so
    // haproxy's send-proxy-v2 is honored from first bind; standard listeners
    // are created WITHOUT a proxy-trust override.
    const nlSet = calls.find((c) => c.method === 'x:NetworkListener/set')!;
    const nlCreate = nlSet.args.create as Record<string, Record<string, unknown>>;
    expect(nlCreate['smtp-proxy'].overrideProxyTrustedNetworks).toEqual({ '10.42.0.0/16': true });
    expect(nlCreate['imaps-proxy'].overrideProxyTrustedNetworks).toEqual({ '10.42.0.0/16': true });
    expect(nlCreate['sieve-proxy'].protocol).toBe('manageSieve');
    expect(nlCreate['submission'].overrideProxyTrustedNetworks).toBeUndefined();

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
      listeners: ALL_REQUIRED_LISTENERS,
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
      listeners: ALL_REQUIRED_LISTENERS,
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
      listeners: ALL_REQUIRED_LISTENERS,
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
    // http-acme already exists; everything else (incl. the 6 PROXY listeners)
    // is created.
    expect(Object.keys(create).sort()).toEqual([
      'imap', 'imap-proxy', 'imaps-proxy', 'sieve-proxy',
      'smtp-proxy', 'submission', 'submission-proxy', 'submissions-proxy',
    ]);
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

// ── Post-deadlock TLS-cert self-heal ─────────────────────────────────

describe('issuerIsSelfSigned predicate', () => {
  it('flags Stalwart bootstrap rcgen cert as self-signed', () => {
    expect(issuerIsSelfSigned('CN=rcgen self signed cert')).toBe(true);
    expect(issuerIsSelfSigned('CN = rcgen self signed cert')).toBe(true);
  });
  it('flags generic self-signed wording', () => {
    expect(issuerIsSelfSigned('CN=self-signed')).toBe(true);
    expect(issuerIsSelfSigned('O=Self Signed')).toBe(true);
  });
  it('does NOT flag a real Let\'s Encrypt issuer', () => {
    expect(issuerIsSelfSigned("C=US, O=Let's Encrypt, CN=E8")).toBe(false);
  });
  it('does NOT flag a null/empty issuer', () => {
    expect(issuerIsSelfSigned(null)).toBe(false);
    expect(issuerIsSelfSigned('')).toBe(false);
  });
});

describe('mail-admin stalwart-domain-reconciler — served-cert self-heal', () => {
  // A fully-wired, fully-configured cluster (Domain + AcmeProvider +
  // Automatic certMgmt + all listeners) WITH a stored x:Certificate.
  // Steps 3-7 are all no-ops and step-8 skips (stored cert ⇒ renewals
  // are Stalwart-scheduled), so the ONLY thing that can flip
  // noOp/acmeOrderForced is the step-9 served-cert self-heal —
  // isolating it cleanly. The stored-cert-but-served-self-signed shape
  // is also the REAL wedge the self-heal exists for (post-restore /
  // post-Pending-recovery: store has a cert, the listener never loaded
  // it / Stalwart's order state died).
  const fullyConfigured = (extra: { tasks?: ReadonlyArray<Record<string, unknown>> } = {}) => buildJmapMock({
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
    listeners: ALL_REQUIRED_LISTENERS,
    defaultHostname: 'mail.example.net',
    defaultDomainId: 'd1',
    certificates: [{ id: 'cert1', subjectAlternativeNames: { 'mail.example.net': true } }],
    tasks: extra.tasks,
  });

  const selfSignedProbe = (): ServedCertResult => ({
    selfSigned: true,
    issuer: 'CN=rcgen self signed cert',
    error: null,
  });
  const leProbe = (): ServedCertResult => ({
    selfSigned: false,
    issuer: "C=US, O=Let's Encrypt, CN=E8",
    error: null,
  });

  beforeEach(() => {
    // Module-local backoff persists across calls by design — reset per case.
    __resetStalwartForceStateForTest();
  });

  it('(a) self-signed + Ready + cfg-wired ⇒ forces order (unconditional Domain/set + Task/set AcmeRenewal)', async () => {
    const { transport, calls } = fullyConfigured();
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      servedCertProbe: async () => selfSignedProbe(),
      logger,
    });
    expect(result.acmeOrderForced).toBe(true);
    expect(result.noOp).toBe(false); // forced order counts as "acted"

    // The UNCONDITIONAL certificateManagement re-assert must fire even
    // though step-6 ensureDomainCertManagement no-op'd (cfg already
    // correct). That is the whole point — it's a Domain/set update on d1.
    const domainUpdates = calls.filter(
      (c) => c.method === 'x:Domain/set' && c.args.update !== undefined,
    );
    expect(domainUpdates.length).toBe(1); // ONLY the force re-assert (step-6 no-op'd)
    const cm = ((domainUpdates[0].args.update as Record<string, Record<string, unknown>>).d1
      .certificateManagement as Record<string, unknown>);
    expect(cm['@type']).toBe('Automatic');
    expect(cm.acmeProviderId).toBe('ap1');
    expect(cm.subjectAlternativeNames).toEqual({ 'mail.example.net': true });

    // The force's second half fires AcmeRenewal via the PROVEN x:Task/set
    // primitive (fireAcmeRenewal). Exactly ONCE: step-8 skipped (stored
    // cert ⇒ Stalwart-scheduled renewals), so the force is the only fire.
    // (Pre-2026-06-11 this fired TWICE per tick — the unconditional
    // step-8 + the force — which, multiplied by replicas and ticks,
    // tripped LE's duplicate-certificate limit. See step-8 comment.)
    const renew = calls.filter((c) => c.method === 'x:Task/set');
    expect(renew.length).toBe(1);

    const note = result.notes.find((n) => /forced a fresh ACME order/.test(n));
    expect(note).toBeDefined();
  });

  it('(b) LE-issued cert ⇒ no force, noOp honoured, NO force JMAP calls', async () => {
    const { transport, calls } = fullyConfigured();
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      servedCertProbe: async () => leProbe(),
      logger,
    });
    expect(result.acmeOrderForced).toBe(false);
    expect(result.noOp).toBe(true); // steady state — zero LE traffic
    // No Domain/set update (step-6 no-op'd AND no force re-assert).
    expect(calls.filter((c) => c.method === 'x:Domain/set' && c.args.update !== undefined)).toEqual([]);
    // ZERO AcmeRenewal fires: step-8 skips on the stored cert and there
    // is no force — true steady state issues no LE orders at all.
    expect(calls.filter((c) => c.method === 'x:Task/set')).toHaveLength(0);
  });

  it('(c) self-signed but backoff not elapsed ⇒ no second force', async () => {
    // First tick forces (sets lastForcedAt = now). Second tick — same
    // module-local state, < MIN_FORCE_INTERVAL_MS later — must defer.
    const first = fullyConfigured();
    const r1 = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: first.transport,
      servedCertProbe: async () => selfSignedProbe(),
      logger,
    });
    expect(r1.acmeOrderForced).toBe(true);

    const second = fullyConfigured();
    const r2 = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: second.transport,
      servedCertProbe: async () => selfSignedProbe(),
      logger,
    });
    expect(r2.acmeOrderForced).toBe(false);
    expect(second.calls.filter((c) => c.method === 'x:Task/set')).toHaveLength(0);
    expect(r2.notes.find((n) => /backoff not elapsed/.test(n))).toBeDefined();
  });

  it('(d) self-signed past max-attempts ⇒ no force + operator note present', async () => {
    // Drive 5 forces with the backoff window elapsed between each
    // (advance the clock via Date.now mock), then a 6th tick must STOP.
    const realNow = Date.now;
    let clock = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      for (let i = 0; i < 5; i += 1) {
        const m = fullyConfigured();
        const r = await runStalwartDomainReconcilerTick({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          core: {} as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          db: dbStub('mail.example.net') as any,
          jmapTransport: m.transport,
          servedCertProbe: async () => selfSignedProbe(),
          logger,
        });
        expect(r.acmeOrderForced).toBe(true);
        clock += STALWART_DOMAIN_RECONCILER_TICK_MS + 1; // elapse backoff
      }
      // 6th tick: attempts cap reached → no force, operator note.
      const capped = fullyConfigured();
      const rCap = await runStalwartDomainReconcilerTick({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        core: {} as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db: dbStub('mail.example.net') as any,
        jmapTransport: capped.transport,
        servedCertProbe: async () => selfSignedProbe(),
        logger,
      });
      expect(rCap.acmeOrderForced).toBe(false);
      expect(capped.calls.filter((c) => c.method === 'x:Task/set')).toHaveLength(0);
      expect(rCap.notes.find((n) => /still self-signed after 5 forced ACME orders/.test(n))).toBeDefined();
    } finally {
      (Date.now as unknown as { mockRestore?: () => void }).mockRestore?.();
      Date.now = realNow;
    }
  });

  it('(d2) backoff counter RESETS once the served cert is observed non-self-signed', async () => {
    // Force once (attempts=1), then observe an LE cert (resets), then a
    // self-signed observation forces AGAIN immediately (attempts back to 1,
    // backoff cleared) rather than being deferred.
    const r1 = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: fullyConfigured().transport,
      servedCertProbe: async () => selfSignedProbe(),
      logger,
    });
    expect(r1.acmeOrderForced).toBe(true);

    // LE cert observed → resets lastForcedAt + forceAttempts.
    const r2 = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: fullyConfigured().transport,
      servedCertProbe: async () => leProbe(),
      logger,
    });
    expect(r2.acmeOrderForced).toBe(false);

    // Self-signed again — backoff was reset, so it forces immediately.
    const r3 = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: fullyConfigured().transport,
      servedCertProbe: async () => selfSignedProbe(),
      logger,
    });
    expect(r3.acmeOrderForced).toBe(true);
  });

  it('(e) probe error ⇒ no force, no throw, inconclusive note', async () => {
    const { transport, calls } = fullyConfigured();
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      servedCertProbe: async () => ({ selfSigned: false, issuer: null, error: 'openssl not found' }),
      logger,
    });
    expect(result.acmeOrderForced).toBe(false);
    expect(result.noOp).toBe(true);
    expect(calls.filter((c) => c.method === 'x:Task/set')).toHaveLength(0);
    expect(result.notes.find((n) => /served-cert probe inconclusive/.test(n))).toBeDefined();
  });

  it('(f) self-signed but an AcmeRenewal task already pending ⇒ defer, no duplicate order', async () => {
    // The 2026-06-11 storm shape: Stalwart already has a queued/retrying
    // AcmeRenewal (e.g. rate-limited, due later). Forcing another order
    // only stacks duplicate LE orders — the self-heal must defer.
    const { transport, calls } = fullyConfigured({
      tasks: [{
        id: 'queued1',
        '@type': 'AcmeRenewal',
        domainId: 'd1',
        status: { '@type': 'Retry', failureReason: 'Rate limited. Retry after 12903 seconds' },
      }],
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      servedCertProbe: async () => selfSignedProbe(),
      logger,
    });
    expect(result.acmeOrderForced).toBe(false);
    expect(calls.filter((c) => c.method === 'x:Task/set')).toHaveLength(0);
    // No force re-assert either — the WHOLE force defers.
    expect(calls.filter((c) => c.method === 'x:Domain/set' && c.args.update !== undefined)).toEqual([]);
    expect(result.notes.find((n) => /AcmeRenewal task is already pending\/retrying/.test(n))).toBeDefined();
  });
});

describe('mail-admin stalwart-domain-reconciler — AcmeRenewal fire gates (step 8)', () => {
  const base = {
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
    listeners: ALL_REQUIRED_LISTENERS,
    defaultHostname: 'mail.example.net',
    defaultDomainId: 'd1',
  } as const;

  it('skips the fire when a stored certificate already covers the hostname', async () => {
    const { transport, calls } = buildJmapMock({
      ...base,
      certificates: [{ id: 'cert1', subjectAlternativeNames: { 'mail.example.net': true } }],
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.acmeRenewalFired).toBe(false);
    expect(calls.filter((c) => c.method === 'x:Task/set')).toHaveLength(0);
    expect(result.notes.find((n) => /stored certificate already covers/.test(n))).toBeDefined();
  });

  it('does NOT skip on a stored certificate for a DIFFERENT hostname', async () => {
    const { transport, calls } = buildJmapMock({
      ...base,
      certificates: [{ id: 'cert1', subjectAlternativeNames: { 'mail.other.net': true } }],
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.acmeRenewalFired).toBe(true);
    expect(calls.filter((c) => c.method === 'x:Task/set')).toHaveLength(1);
  });

  it('skips the fire when an AcmeRenewal task is already pending/retrying for the domain', async () => {
    const { transport, calls } = buildJmapMock({
      ...base,
      tasks: [{
        id: 'queued1',
        '@type': 'AcmeRenewal',
        domainId: 'd1',
        status: { '@type': 'Retry', failureReason: 'Rate limited. Retry after 12903 seconds' },
      }],
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.acmeRenewalFired).toBe(false);
    expect(calls.filter((c) => c.method === 'x:Task/set')).toHaveLength(0);
    expect(result.notes.find((n) => /already pending\/retrying/.test(n))).toBeDefined();
  });

  it('ignores pending AcmeRenewal tasks for OTHER domains and unrelated task types', async () => {
    const { transport, calls } = buildJmapMock({
      ...base,
      tasks: [
        { id: 't1', '@type': 'AcmeRenewal', domainId: 'd-other', status: { '@type': 'Retry' } },
        { id: 't2', '@type': 'DnsVerify', domainId: 'd1', status: { '@type': 'Pending' } },
      ],
    });
    const result = await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    expect(result.acmeRenewalFired).toBe(true);
    expect(calls.filter((c) => c.method === 'x:Task/set')).toHaveLength(1);
  });
});

describe('mail-admin stalwart-domain-reconciler — MtaStageAuth inbound-MX auth exemption (step 7a)', () => {
  // Fully-configured otherwise, so step 7a is the only thing that can issue
  // an x:MtaStageAuth/set. podName is null (injected transport), so the
  // 7b recycle never runs in tests — we assert the SET (or its absence).
  const base = {
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
    listeners: ALL_REQUIRED_LISTENERS,
    defaultHostname: 'mail.example.net',
    defaultDomainId: 'd1',
    certificates: [{ id: 'cert1', subjectAlternativeNames: { 'mail.example.net': true } }],
  } as const;

  it('widens require.else to exempt port 12025 when the singleton still has the default (local_port != 25)', async () => {
    const { transport, calls } = buildJmapMock({ ...base, mtaAuthRequireElse: 'local_port != 25' });
    await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    const mtaSet = calls.find((c) => c.method === 'x:MtaStageAuth/set');
    expect(mtaSet).toBeDefined();
    // The update sends ONLY `require` (preserving other singleton fields),
    // with the exact canonical exemption body.
    const upd = (mtaSet!.args.update as Record<string, Record<string, unknown>>).singleton;
    expect(upd).toEqual({
      require: { match: {}, else: 'local_port != 25 && local_port != 12025' },
    });
  });

  it('is idempotent — no x:MtaStageAuth/set when require.else already exempts port 12025', async () => {
    // The mock defaults require.else to the canonical post-fix expr.
    const { transport, calls } = buildJmapMock({ ...base });
    await runStalwartDomainReconcilerTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      core: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: dbStub('mail.example.net') as any,
      jmapTransport: transport,
      logger,
    });
    expect(calls.filter((c) => c.method === 'x:MtaStageAuth/set')).toHaveLength(0);
  });
});
