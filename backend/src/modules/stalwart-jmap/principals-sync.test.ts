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
    tenantId: 'tenant_id',
  },
  emailDomains: {
    id: 'id', domainId: 'domain_id', stalwartDomainId: 'stalwart_domain_id',
    tenantId: 'tenant_id',
  },
  domains: { id: 'id', domainName: 'domain_name' },
  // 2026-05-27: drift-persistence + admin notification fan-out added to
  // the reconciler. Stub the new schema exports just enough for the
  // chained query builders to run; the mock DB (createMockDb) returns
  // empty arrays for the new query shapes, so no field is dereferenced.
  mailDriftItems: {
    id: 'id', kind: 'kind', expectedName: 'expected_name',
    expectedStalwartId: 'expected_stalwart_id', platformRowId: 'platform_row_id',
    firstDetectedAt: 'first_detected_at', lastSeenAt: 'last_seen_at',
    resolvedAt: 'resolved_at', resolvedVia: 'resolved_via', notes: 'notes',
  },
  users: { id: 'id', roleName: 'role_name' },
  notifications: {
    id: 'id', userId: 'user_id', type: 'type', title: 'title',
    message: 'message', resourceType: 'resource_type',
  },
}));

// ── JMAP client mock ──────────────────────────────────────────────────────────

const mockGetJmapSession = vi.fn();
const mockPrincipalGet = vi.fn();

vi.mock('./client.js', () => ({
  getJmapSession: (...args: unknown[]) => mockGetJmapSession(...args),
  principalGet: (...args: unknown[]) => mockPrincipalGet(...args),
}));

// master-user detector dependency. Default → the compiled-in fallback so the
// detector SKIPS in tests that don't exercise it (no false alarm, no throw).
const mockReadMaster = vi.fn(async () => 'master@master.local');
vi.mock('../mail-admin/stalwart-master-user.js', () => ({
  readStalwartMasterUser: (...args: unknown[]) => mockReadMaster(...args),
  MASTER_USER_FALLBACK: 'master@master.local',
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
 * The reconciler issues two main query shapes for the platform tables:
 *
 *   Call 0: Mailboxes —      db.select({...}).from(mailboxes)
 *                            — awaited directly from `.from()`, no further chain.
 *   Call 1: Email domains —  db.select({...}).from(emailDomains).innerJoin(domains, ...)
 *                            — awaited from `.innerJoin()`.
 *   Call 2: Active drift —   db.select({...}).from(mailDriftItems).where(isNull(resolvedAt))
 *                            — awaited from `.where()`, returns active drift rows.
 *   Call 3: Admin users —    db.select({id}).from(users).where(inArray(roleName, [...]))
 *                            — only invoked when NEW drift items appear; returns admin ids
 *                            for notification fan-out.
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

  // Generic insert mock — values() returns a resolved promise so the
  // drift-item + notification inserts await cleanly without further setup.
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  let fromCallIndex = 0;

  const fromFn = vi.fn().mockImplementation(() => {
    const callIndex = fromCallIndex++;
    if (callIndex === 0) {
      // Call 0: db.select().from(mailboxes) — awaited directly
      const p = Promise.resolve(mailboxRows) as unknown as Promise<typeof mailboxRows> & {
        innerJoin: ReturnType<typeof vi.fn>;
        where: ReturnType<typeof vi.fn>;
      };
      p.innerJoin = vi.fn();
      p.where = vi.fn();
      return p;
    }
    if (callIndex === 1) {
      // Call 1: db.select().from(emailDomains).innerJoin(domains, ...)
      return {
        innerJoin: vi.fn().mockResolvedValue(emailDomainRows),
      };
    }
    // Calls 2+: drift-persistence (active rows) and admin-user fan-out.
    // Default to empty results so the sync pipeline completes cleanly.
    // Tests that exercise drift state can override the mock.
    return {
      where: vi.fn().mockResolvedValue([]),
      innerJoin: vi.fn().mockResolvedValue([]),
    };
  });

  return {
    select: vi.fn().mockReturnValue({ from: fromFn }),
    update: updateFn,
    insert: insertFn,
    _updateFn: updateFn,
    _updateSet: updateSet,
    _updateWhere: updateWhere,
    _insertFn: insertFn,
    _insertValues: insertValues,
  } as unknown as Parameters<typeof createPrincipalsSyncScheduler>[0];
}

describe('createPrincipalsSyncScheduler — runOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadMaster.mockResolvedValue('master@master.local'); // default: detector skips
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

  // ── fix A: match individuals by their full email address ────────────────────
  //   Stalwart's x:Account `name` is only the LOCAL part ("kjh"); the full
  //   address comes from x:Account `emailAddress`, which client.ts now surfaces
  //   into `emails`. The reconciler keys the map on `emails`, never `name`.
  it('does NOT flag a synced mailbox as drift when matched by full email (name is only the local part)', () => {
    return (async () => {
      mockGetJmapSession.mockResolvedValueOnce(makeSession());
      // Real (post-fix) client shape: name = local part, emails = [full address].
      mockPrincipalGet.mockResolvedValueOnce(makePrincipalGetResponse([
        { id: 'sp-d', type: 'individual', name: 'kjh', emails: ['kjh@staging.example.net'] },
      ]));
      const db = createMockDb(
        [{ id: 'mb-kjh', fullAddress: 'kjh@staging.example.net', stalwartPrincipalId: 'sp-d' }],
        [],
      );
      const result = await createPrincipalsSyncScheduler(db, { env: {} as NodeJS.ProcessEnv }).runOnce();

      expect(result.mailboxOrphansMarked).toBe(0); // pre-fix this was 1 (false drift)
      const inserts = (db as unknown as { _insertValues: ReturnType<typeof vi.fn> })._insertValues.mock.calls;
      expect(inserts.some((c) => (c[0] as { kind?: string })?.kind === 'mailbox')).toBe(false);

      // Regression guard: the sync MUST project `emailAddress` or Stalwart
      // strips it and the full-address match silently fails (false drift).
      expect(mockPrincipalGet).toHaveBeenCalledWith(
        expect.objectContaining({ properties: expect.arrayContaining(['emailAddress']) }),
      );
    })();
  });

  // ── C: webmail master-user detector ────────────────────────────────────────
  it('records an ACTIONABLE master-user drift item when the master is missing from Stalwart', async () => {
    mockReadMaster.mockResolvedValue('master@mail.staging.example.net');
    mockGetJmapSession.mockResolvedValueOnce(makeSession());
    mockPrincipalGet.mockResolvedValueOnce(makePrincipalGetResponse([
      { id: 'sp-d', type: 'individual', name: 'kjh', emails: ['kjh@staging.example.net'] }, // a tenant mailbox, NOT the master
    ]));
    const db = createMockDb([], []);
    await createPrincipalsSyncScheduler(db, { env: {} as NodeJS.ProcessEnv }).runOnce();

    const inserts = (db as unknown as { _insertValues: ReturnType<typeof vi.fn> })._insertValues.mock.calls;
    const masterInsert = inserts.find((c) => (c[0] as { kind?: string })?.kind === 'master-user');
    expect(masterInsert).toBeDefined();
    const row = masterInsert![0] as { expectedName: string; notes: string };
    expect(row.expectedName).toBe('master@mail.staging.example.net');
    expect(row.notes).toContain('rotate-webmail-master'); // the actionable remediation
  });

  it('does NOT record master drift when the master principal is present in Stalwart', async () => {
    mockReadMaster.mockResolvedValue('master@mail.staging.example.net');
    mockGetJmapSession.mockResolvedValueOnce(makeSession());
    mockPrincipalGet.mockResolvedValueOnce(makePrincipalGetResponse([
      { id: 'b', type: 'individual', name: 'master', emails: ['master@mail.staging.example.net'] },
    ]));
    const db = createMockDb([], []);
    await createPrincipalsSyncScheduler(db, { env: {} as NodeJS.ProcessEnv }).runOnce();

    const inserts = (db as unknown as { _insertValues: ReturnType<typeof vi.fn> })._insertValues.mock.calls;
    expect(inserts.some((c) => (c[0] as { kind?: string })?.kind === 'master-user')).toBe(false);
  });

  it('skips the master-user check when only the compiled-in fallback FQDN is known', async () => {
    // default mockReadMaster → 'master@master.local' (fallback) → skip, no false alarm
    mockGetJmapSession.mockResolvedValueOnce(makeSession());
    mockPrincipalGet.mockResolvedValueOnce(makePrincipalGetResponse([]));
    const db = createMockDb([], []);
    const result = await createPrincipalsSyncScheduler(db, { env: {} as NodeJS.ProcessEnv }).runOnce();

    const inserts = (db as unknown as { _insertValues: ReturnType<typeof vi.fn> })._insertValues.mock.calls;
    expect(inserts.some((c) => (c[0] as { kind?: string })?.kind === 'master-user')).toBe(false);
    expect(result.errors).toHaveLength(0);
  });
});
