/**
 * Unit tests for stalwart-jmap/principals-sync.ts
 *
 * All JMAP HTTP calls are mocked; the DB is a vi.fn() stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock drizzle-orm and db/schema BEFORE importing principals-sync so the
// module can be loaded without a real database.
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ _type: 'eq' })),
  isNull: vi.fn((_col: unknown) => ({ _type: 'isNull' })),
}));

vi.mock('../../db/schema.js', () => ({
  mailboxes: {
    id: 'id', fullAddress: 'full_address', stalwartPrincipalId: 'stalwart_principal_id',
    clientId: 'client_id',
  },
  emailDomains: {
    id: 'id', domainId: 'domain_id', stalwartDomainId: 'stalwart_domain_id',
    clientId: 'client_id',
  },
  domains: { id: 'id', domainName: 'domain_name' },
}));

// ── JMAP client mock ──────────────────────────────────────────────────────────

const mockGetJmapSession = vi.fn();
const mockPrincipalGet = vi.fn();

vi.mock('./client.js', () => ({
  getJmapSession: (...args: unknown[]) => mockGetJmapSession(...args),
  principalGet: (...args: unknown[]) => mockPrincipalGet(...args),
}));

const ACCOUNT_ID = 'account-123';

function makeSession() {
  return {
    primaryAccounts: { 'urn:ietf:params:jmap:principals': ACCOUNT_ID },
    state: 'state-001',
  };
}

function makePrincipalGetResponse(list: unknown[]) {
  return { accountId: ACCOUNT_ID, state: 'state-001', list, notFound: [] };
}

// Import after mocks
const { createPrincipalsSyncScheduler } = await import('./principals-sync.js');

// ── Mock DB ───────────────────────────────────────────────────────────────────

/**
 * The reconciler issues two distinct query shapes:
 *
 *   1. Mailboxes:     db.select({...}).from(mailboxes)
 *      — awaited directly from `.from()`, no further chain.
 *
 *   2. Email domains: db.select({...}).from(emailDomains).innerJoin(domains, ...)
 *      — awaited from `.innerJoin()`, no `.where()` call.
 *
 * We track how many times `from()` has been called to return the right data.
 */
function createMockDb(
  mailboxRows: Array<{ id: string; fullAddress: string; stalwartPrincipalId: string | null }> = [],
  emailDomainRows: Array<{ id: string; domainId: string; stalwartDomainId: string | null; domainName: string }> = [],
) {
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  let fromCallIndex = 0;

  const fromFn = vi.fn().mockImplementation(() => {
    const callIndex = fromCallIndex++;
    if (callIndex === 0) {
      // Mailboxes query: db.select().from(mailboxes)
      // The reconciler awaits this directly — wrap in a resolved Promise.
      const p = Promise.resolve(mailboxRows) as unknown as Promise<typeof mailboxRows> & {
        innerJoin: ReturnType<typeof vi.fn>;
      };
      p.innerJoin = vi.fn(); // never called for mailboxes
      return p;
    }
    // Email-domains query: db.select().from(emailDomains).innerJoin(...)
    return {
      innerJoin: vi.fn().mockResolvedValue(emailDomainRows),
    };
  });

  return {
    select: vi.fn().mockReturnValue({ from: fromFn }),
    update: updateFn,
    _updateFn: updateFn,
    _updateSet: updateSet,
    _updateWhere: updateWhere,
  } as unknown as Parameters<typeof createPrincipalsSyncScheduler>[0];
}

describe('createPrincipalsSyncScheduler — runOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early with error when JMAP session fails', async () => {
    mockGetJmapSession.mockRejectedValueOnce(new Error('connection refused'));

    const db = createMockDb();
    const scheduler = createPrincipalsSyncScheduler(db, { env: {} as NodeJS.ProcessEnv });
    const result = await scheduler.runOnce();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('connection refused');
    expect(result.mailboxesBackfilled).toBe(0);
    expect(result.domainsBackfilled).toBe(0);
  });

  it('backfills stalwartPrincipalId for a matching mailbox', async () => {
    mockGetJmapSession.mockResolvedValueOnce(makeSession());
    mockPrincipalGet.mockResolvedValueOnce(makePrincipalGetResponse([
      { id: 'sp-001', type: 'individual', name: 'alice', emails: ['alice@example.com'] },
    ]));

    const db = createMockDb(
      [{ id: 'mb-1', fullAddress: 'alice@example.com', stalwartPrincipalId: null }],
      [],
    );

    const scheduler = createPrincipalsSyncScheduler(db, { env: {} as NodeJS.ProcessEnv });
    const result = await scheduler.runOnce();

    expect(result.mailboxesBackfilled).toBe(1);
    expect(result.domainsBackfilled).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect((db as unknown as { _updateFn: ReturnType<typeof vi.fn> })._updateFn).toHaveBeenCalled();
  });

  it('backfills stalwartDomainId for a matching email domain', async () => {
    mockGetJmapSession.mockResolvedValueOnce(makeSession());
    mockPrincipalGet.mockResolvedValueOnce(makePrincipalGetResponse([
      { id: 'dp-001', type: 'domain', name: 'example.com' },
    ]));

    const db = createMockDb(
      [],
      [{ id: 'ed-1', domainId: 'd-1', stalwartDomainId: null, domainName: 'example.com' }],
    );

    const scheduler = createPrincipalsSyncScheduler(db, { env: {} as NodeJS.ProcessEnv });
    const result = await scheduler.runOnce();

    expect(result.domainsBackfilled).toBe(1);
    expect(result.mailboxesBackfilled).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('does not backfill when stalwartPrincipalId already set', async () => {
    mockGetJmapSession.mockResolvedValueOnce(makeSession());
    mockPrincipalGet.mockResolvedValueOnce(makePrincipalGetResponse([
      { id: 'sp-002', type: 'individual', name: 'bob', emails: ['bob@example.com'] },
    ]));

    const db = createMockDb(
      [{ id: 'mb-2', fullAddress: 'bob@example.com', stalwartPrincipalId: 'sp-002' }],
      [],
    );

    const scheduler = createPrincipalsSyncScheduler(db, { env: {} as NodeJS.ProcessEnv });
    const result = await scheduler.runOnce();

    expect(result.mailboxesBackfilled).toBe(0);
    expect((db as unknown as { _updateFn: ReturnType<typeof vi.fn> })._updateFn).not.toHaveBeenCalled();
  });

  it('logs orphan when platform mailbox is missing from Stalwart (has prior stalwartPrincipalId)', async () => {
    mockGetJmapSession.mockResolvedValueOnce(makeSession());
    mockPrincipalGet.mockResolvedValueOnce(makePrincipalGetResponse([])); // Stalwart has nothing

    const db = createMockDb(
      [{ id: 'mb-3', fullAddress: 'ghost@example.com', stalwartPrincipalId: 'sp-old' }],
      [],
    );

    const scheduler = createPrincipalsSyncScheduler(db, { env: {} as NodeJS.ProcessEnv });
    const result = await scheduler.runOnce();

    expect(result.mailboxOrphansMarked).toBe(1);
    // Should NOT have called update (we only log, not auto-fix)
    expect((db as unknown as { _updateFn: ReturnType<typeof vi.fn> })._updateFn).not.toHaveBeenCalled();
  });

  it('skips platform mailbox with null stalwartPrincipalId not found in Stalwart (no mail stack)', async () => {
    mockGetJmapSession.mockResolvedValueOnce(makeSession());
    mockPrincipalGet.mockResolvedValueOnce(makePrincipalGetResponse([]));

    const db = createMockDb(
      [{ id: 'mb-4', fullAddress: 'dev@local', stalwartPrincipalId: null }],
      [],
    );

    const scheduler = createPrincipalsSyncScheduler(db, { env: {} as NodeJS.ProcessEnv });
    const result = await scheduler.runOnce();

    expect(result.mailboxesBackfilled).toBe(0);
    expect(result.mailboxOrphansMarked).toBe(0);
    expect((db as unknown as { _updateFn: ReturnType<typeof vi.fn> })._updateFn).not.toHaveBeenCalled();
  });
});
