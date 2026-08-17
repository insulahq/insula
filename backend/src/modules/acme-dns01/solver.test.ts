import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DnsProviderAdapter } from '../dns-servers/providers/types.js';

// ─── dns-servers/service.ts mock ──────────────────────────────────────────
vi.mock('../dns-servers/service.js', () => ({
  getActiveServersForDomain: vi.fn().mockResolvedValue([]),
  getProviderForServer: vi.fn(),
}));

let domainRows: Array<{ id: string; domainName: string; dnsMode: string }> = [];

function createMockDb() {
  const whereFn = vi.fn().mockImplementation(() => Promise.resolve(domainRows));
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  return { select: vi.fn().mockReturnValue({ from: fromFn }) } as never;
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeProvider(overrides: Partial<DnsProviderAdapter> = {}): DnsProviderAdapter {
  return {
    providerType: 'powerdns',
    testConnection: vi.fn(),
    listZones: vi.fn(),
    getZone: vi.fn(),
    createZone: vi.fn(),
    deleteZone: vi.fn(),
    listRecords: vi.fn().mockResolvedValue([]),
    createRecord: vi.fn().mockResolvedValue({}),
    updateRecord: vi.fn(),
    deleteRecord: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as DnsProviderAdapter;
}

const dnsServersService = await import('../dns-servers/service.js');
const solver = await import('./solver.js');

const primaryServer = { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' };

function request(overrides: Record<string, unknown> = {}) {
  return {
    uid: 'u1',
    action: 'Present' as const,
    dnsName: 'example.test',
    key: 'challenge-token',
    resolvedFQDN: '_acme-challenge.example.test.',
    resolvedZone: 'example.test.',
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  domainRows = [{ id: 'd1', domainName: 'example.test', dnsMode: 'primary' }];
  vi.mocked(dnsServersService.getActiveServersForDomain).mockResolvedValue([primaryServer] as never);
});

describe('resolveChallengeTarget', () => {
  it('resolves the owning domain and the zone-relative record name', async () => {
    vi.mocked(dnsServersService.getProviderForServer).mockReturnValue(makeProvider());
    const target = await solver.resolveChallengeTarget(
      { db: createMockDb(), encryptionKey: 'k', logger: makeLogger() },
      request(),
    );
    expect(target.domainName).toBe('example.test');
    expect(target.recordName).toBe('_acme-challenge');
    expect(target.providers).toHaveLength(1);
  });

  it('picks the most specific registered domain for a deep challenge', async () => {
    domainRows = [
      { id: 'apex', domainName: 'example.test', dnsMode: 'primary' },
      { id: 'child', domainName: 'a.example.test', dnsMode: 'primary' },
    ];
    vi.mocked(dnsServersService.getProviderForServer).mockReturnValue(makeProvider());

    const target = await solver.resolveChallengeTarget(
      { db: createMockDb(), encryptionKey: 'k', logger: makeLogger() },
      request({ dnsName: '*.a.example.test', resolvedFQDN: '_acme-challenge.a.example.test.' }),
    );
    expect(target.domainId).toBe('child');
    expect(target.recordName).toBe('_acme-challenge');
  });

  it('writes into the parent zone when only the parent is registered', async () => {
    vi.mocked(dnsServersService.getProviderForServer).mockReturnValue(makeProvider());
    const target = await solver.resolveChallengeTarget(
      { db: createMockDb(), encryptionKey: 'k', logger: makeLogger() },
      request({ dnsName: '*.a.example.test', resolvedFQDN: '_acme-challenge.a.example.test.' }),
    );
    expect(target.domainName).toBe('example.test');
    expect(target.recordName).toBe('_acme-challenge.a');
  });

  it('refuses a zone no platform domain owns', async () => {
    domainRows = [];
    await expect(
      solver.resolveChallengeTarget(
        { db: createMockDb(), encryptionKey: 'k', logger: makeLogger() },
        request(),
      ),
    ).rejects.toThrow(/No active platform domain owns/);
  });

  it('refuses a customer-managed zone', async () => {
    // dnsMode=cname means the customer runs the zone — writing a TXT
    // there is neither possible nor ours to attempt.
    domainRows = [{ id: 'd1', domainName: 'example.test', dnsMode: 'cname' }];
    await expect(
      solver.resolveChallengeTarget(
        { db: createMockDb(), encryptionKey: 'k', logger: makeLogger() },
        request(),
      ),
    ).rejects.toThrow(/not authoritative/);
  });

  it('refuses when the group has no enabled primary', async () => {
    vi.mocked(dnsServersService.getActiveServersForDomain).mockResolvedValue([
      { id: 's2', providerType: 'powerdns', enabled: 1, role: 'secondary' },
    ] as never);
    await expect(
      solver.resolveChallengeTarget(
        { db: createMockDb(), encryptionKey: 'k', logger: makeLogger() },
        request(),
      ),
    ).rejects.toThrow(/not authoritative|No enabled primary/);
  });
});

describe('presentChallenge', () => {
  it('publishes the TXT record with a short TTL', async () => {
    const provider = makeProvider();
    vi.mocked(dnsServersService.getProviderForServer).mockReturnValue(provider);

    await solver.presentChallenge(
      { db: createMockDb(), encryptionKey: 'k', logger: makeLogger() },
      request(),
    );

    expect(provider.createRecord).toHaveBeenCalledWith('example.test', {
      type: 'TXT',
      name: '_acme-challenge',
      content: 'challenge-token',
      ttl: solver.CHALLENGE_TTL_SECONDS,
    });
  });

  it('adds rather than replaces, so a wildcard + apex order keeps both keys', async () => {
    // PowerDNS createRecord appends into the RRset; the solver must not
    // do anything that replaces the set, or the second authorization of
    // a `example.test` + `*.example.test` order fails.
    const provider = makeProvider();
    vi.mocked(dnsServersService.getProviderForServer).mockReturnValue(provider);
    const deps = { db: createMockDb(), encryptionKey: 'k', logger: makeLogger() };

    await solver.presentChallenge(deps, request({ key: 'key-one' }));
    await solver.presentChallenge(deps, request({ key: 'key-two', dnsName: '*.example.test' }));

    expect(provider.createRecord).toHaveBeenCalledTimes(2);
    expect(provider.deleteRecord).not.toHaveBeenCalled();
  });

  it('throws when every primary rejects the write', async () => {
    const provider = makeProvider({
      createRecord: vi.fn().mockRejectedValue(new Error('403 forbidden')),
    });
    vi.mocked(dnsServersService.getProviderForServer).mockReturnValue(provider);

    await expect(
      solver.presentChallenge(
        { db: createMockDb(), encryptionKey: 'k', logger: makeLogger() },
        request(),
      ),
    ).rejects.toThrow(/403 forbidden/);
  });

  it('tolerates a partial failure but says so', async () => {
    const ok = makeProvider();
    const bad = makeProvider({ createRecord: vi.fn().mockRejectedValue(new Error('down')) });
    vi.mocked(dnsServersService.getActiveServersForDomain).mockResolvedValue([
      primaryServer,
      { id: 's2', providerType: 'powerdns', enabled: 1, role: 'primary' },
    ] as never);
    vi.mocked(dnsServersService.getProviderForServer)
      .mockReturnValueOnce(ok)
      .mockReturnValueOnce(bad);

    const logger = makeLogger();
    await solver.presentChallenge({ db: createMockDb(), encryptionKey: 'k', logger }, request());
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('cleanupChallenge', () => {
  it('removes only this value when the provider supports it', async () => {
    const deleteRecordValue = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider({ deleteRecordValue });
    vi.mocked(dnsServersService.getProviderForServer).mockReturnValue(provider);

    await solver.cleanupChallenge(
      { db: createMockDb(), encryptionKey: 'k', logger: makeLogger() },
      request({ action: 'CleanUp' }),
    );

    expect(deleteRecordValue).toHaveBeenCalledWith('example.test', {
      type: 'TXT',
      name: '_acme-challenge',
      content: 'challenge-token',
      ttl: solver.CHALLENGE_TTL_SECONDS,
    });
    // Never the whole-RRset delete — that would strip a concurrent
    // challenge for the same name.
    expect(provider.deleteRecord).not.toHaveBeenCalled();
  });

  it('falls back to an id-scoped delete for record-oriented providers', async () => {
    const provider = makeProvider({
      listRecords: vi.fn().mockResolvedValue([
        { id: 'rec-1', type: 'TXT', name: '_acme-challenge.example.test', content: '"challenge-token"', ttl: 60 },
        { id: 'rec-2', type: 'TXT', name: '_acme-challenge.example.test', content: '"other-token"', ttl: 60 },
      ]),
    });
    vi.mocked(dnsServersService.getProviderForServer).mockReturnValue(provider);

    await solver.cleanupChallenge(
      { db: createMockDb(), encryptionKey: 'k', logger: makeLogger() },
      request({ action: 'CleanUp' }),
    );

    expect(provider.deleteRecord).toHaveBeenCalledWith('example.test', 'rec-1');
    expect(provider.deleteRecord).toHaveBeenCalledTimes(1);
  });

  it('never throws — a failed cleanup must not fail the order', async () => {
    const provider = makeProvider({
      deleteRecordValue: vi.fn().mockRejectedValue(new Error('provider down')),
    });
    vi.mocked(dnsServersService.getProviderForServer).mockReturnValue(provider);
    const logger = makeLogger();

    await expect(
      solver.cleanupChallenge({ db: createMockDb(), encryptionKey: 'k', logger }, request({ action: 'CleanUp' })),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('solveChallenge', () => {
  it('dispatches on the action', async () => {
    const deleteRecordValue = vi.fn().mockResolvedValue(undefined);
    const provider = makeProvider({ deleteRecordValue });
    vi.mocked(dnsServersService.getProviderForServer).mockReturnValue(provider);
    const deps = { db: createMockDb(), encryptionKey: 'k', logger: makeLogger() };

    await solver.solveChallenge(deps, request({ action: 'Present' }));
    expect(provider.createRecord).toHaveBeenCalled();

    await solver.solveChallenge(deps, request({ action: 'CleanUp' }));
    expect(deleteRecordValue).toHaveBeenCalled();
  });
});
