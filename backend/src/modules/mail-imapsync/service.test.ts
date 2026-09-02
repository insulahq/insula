import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock encryption — passwords are encrypted at rest via oidc/crypto.
vi.mock('../oidc/crypto.js', () => ({
  encrypt: vi.fn((plain: string) => `encrypted:${plain}`),
  decrypt: vi.fn((cipher: string) => cipher.replace(/^encrypted:/, '')),
}));

// ─── Mock DB ────────────────────────────────────────────────────────────────

let selectResults: unknown[][];
let selectCallIndex: number;
let insertImpl: () => Promise<void>;
let insertReturning: unknown[];
let updateImpl: () => Promise<void>;
let deleteImpl: () => Promise<void>;

function createMockDb() {
  selectCallIndex = 0;

  // The result of .where(...) is awaitable AND chainable into
  // .orderBy(...).limit(...) for the listImapSyncJobs query. Both
  // paths consume the same selectResults slot exactly once.
  const makeWhereResult = () => {
    let consumed = false;
    const consume = (): unknown[] => {
      if (consumed) return [];
      consumed = true;
      const result = selectResults[selectCallIndex] ?? [];
      selectCallIndex += 1;
      return result;
    };
    const obj: {
      then: (onFulfilled: (v: unknown[]) => unknown) => Promise<unknown>;
      orderBy: (expr: unknown) => typeof obj;
      limit: (n: number) => Promise<unknown[]>;
    } = {
      then: (onFulfilled) => Promise.resolve(consume()).then(onFulfilled),
      orderBy: () => obj,
      limit: () => Promise.resolve(consume()),
    };
    return obj;
  };

  const whereFn = vi.fn().mockImplementation(() => makeWhereResult());
  const innerJoinFn = vi.fn().mockReturnValue({ where: whereFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn, innerJoin: innerJoinFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertReturningFn = vi.fn().mockImplementation(async () => {
    await insertImpl();
    return insertReturning;
  });
  const insertValuesFn = vi.fn().mockReturnValue({ returning: insertReturningFn });
  const insertFn = vi.fn().mockReturnValue({ values: insertValuesFn });

  let updateReturning: unknown[] = [];
  const updateReturningFn = vi.fn().mockImplementation(async () => {
    await updateImpl();
    return updateReturning;
  });
  const updateWhereFn = vi.fn().mockImplementation(() => {
    // Support both `.where()` (no returning) and `.where().returning()` chains
    const result = { returning: updateReturningFn };
    // Also make it thenable for the plain .where() case (no returning)
    Object.assign(result, {
      then: (onFulfilled: (v: unknown) => unknown) =>
        updateImpl().then(() => onFulfilled(undefined)),
    });
    return result;
  });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhereFn });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockImplementation(() => deleteImpl());
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
    _insertValuesFn: insertValuesFn,
    _updateSet: updateSet,
    _setUpdateReturning: (val: unknown[]) => { updateReturning = val; },
  } as unknown as ReturnType<typeof createMockDb>;
}

const service = await import('./service.js');

beforeEach(() => {
  selectResults = [];
  selectCallIndex = 0;
  insertImpl = () => Promise.resolve();
  insertReturning = [];
  updateImpl = () => Promise.resolve();
  deleteImpl = () => Promise.resolve();
});

// ═══════════════════════════════════════════════════════════════════════════
// buildJobManifest (pure function)
// ═══════════════════════════════════════════════════════════════════════════

describe('buildJobManifest', () => {
  const baseInput = {
    jobId: 'job-123',
    secretName: 'imapsync-job-123',
    namespace: 'mail',
    mailboxAddress: 'alice@acme.com',
    sourceHost: 'imap.gmail.com',
    sourcePort: 993,
    sourceUsername: 'alice@gmail.com',
    sourceSsl: true,
    destHost: 'stalwart-mail.mail.svc.cluster.local',
    destPort: 143,
    options: {},
    image: 'gilleslamiral/imapsync:latest',
  };

  it('produces a Job manifest with metadata, ownerless secretRef, and arg-free password handling', () => {
    const job = service.buildJobManifest(baseInput);

    expect(job.metadata?.name).toBe('imapsync-job-123');
    expect(job.metadata?.namespace).toBe('mail');
    expect(job.spec?.template.spec?.restartPolicy).toBe('Never');
    expect(job.spec?.backoffLimit).toBe(0);
    // IMAP Phase 4: wall-clock timeout so stuck pods don't sit
    // forever. 2 hours is the default.
    expect(job.spec?.activeDeadlineSeconds).toBe(7200);
    expect(job.spec?.ttlSecondsAfterFinished).toBe(3600);

    const container = job.spec?.template.spec?.containers?.[0];
    expect(container).toBeDefined();
    expect(container?.image).toBe('gilleslamiral/imapsync:latest');

    // CRITICAL: passwords MUST come from Secret references, never via args.
    // SOURCE_PASSWORD via the per-job Secret…
    expect(container?.envFrom).toEqual([{ secretRef: { name: 'imapsync-job-123' } }]);
    // …DEST_PASSWORD straight from the mail namespace's own Secret, so
    // platform-api never handles Stalwart's master password. `optional`
    // MUST be false: a missing Secret has to fail the pod loudly rather
    // than run imapsync with an empty destination password.
    expect(container?.env).toEqual([
      {
        name: 'DEST_PASSWORD',
        valueFrom: {
          secretKeyRef: {
            name: 'mail-secrets',
            key: 'STALWART_MASTER_PASSWORD',
            optional: false,
          },
        },
      },
      {
        name: 'DEST_MASTER_USER',
        valueFrom: {
          secretKeyRef: {
            name: 'mail-secrets',
            key: 'STALWART_MASTER_USER',
            optional: false,
          },
        },
      },
      { name: 'DEST_MAILBOX', value: 'alice@acme.com' },
    ]);
    const args = container?.args ?? [];
    const argsText = args.join(' ');
    expect(argsText).not.toContain('SOURCE_PASSWORD');
    expect(argsText).not.toContain('DEST_PASSWORD');
    // Password must NEVER be in args literally either
    for (const a of args) {
      expect(a).not.toMatch(/--password1=/);
      expect(a).not.toMatch(/--password2=/);
    }
  });

  it('passes source host/port/user via args (passfile1 reads from env-set file)', () => {
    const job = service.buildJobManifest(baseInput);
    const args = job.spec?.template.spec?.containers?.[0]?.args ?? [];
    const argsText = args.join(' ');

    expect(argsText).toContain('--host1 imap.gmail.com');
    expect(argsText).toContain('--port1 993');
    expect(argsText).toContain('--user1 alice@gmail.com');
    expect(argsText).toContain('--ssl1');
  });

  it('composes the destination master-SSO user at RUNTIME, not with a literal "master"', () => {
    const job = service.buildJobManifest(baseInput);
    const container = job.spec?.template.spec?.containers?.[0];
    const argsText = (container?.args ?? []).join(' ');

    expect(argsText).toContain('--host2 stalwart-mail.mail.svc.cluster.local');
    expect(argsText).toContain('--port2 143');

    // REGRESSION (2026-09-01): this used to be a hardcoded
    // `--user2 alice@acme.com%master`. Stalwart 0.16 master-proxy auth
    // needs the master principal's FQDN — the bare short name resolves
    // against Stalwart's own default domain and fails with
    // `NO [AUTHENTICATIONFAILED] localhost.local`, so every migration
    // died at the destination login having moved nothing.
    expect(argsText).not.toContain('%master');
    expect(argsText).not.toContain('--user2');

    // It is composed by the entrypoint from the mailbox address plus the
    // FQDN the kubelet reads out of mail-secrets.
    const cmd = (container?.command ?? []).join('\n');
    expect(cmd).toContain('--user2 "$DEST_MAILBOX%$DEST_MASTER_USER"');

    const env = container?.env ?? [];
    expect(env).toContainEqual({ name: 'DEST_MAILBOX', value: 'alice@acme.com' });
    expect(env).toContainEqual({
      name: 'DEST_MASTER_USER',
      valueFrom: {
        secretKeyRef: {
          name: 'mail-secrets',
          key: 'STALWART_MASTER_USER',
          optional: false,
        },
      },
    });
  });

  it('refuses to run if the master principal FQDN is empty', () => {
    // An empty STALWART_MASTER_USER would silently rebuild the old broken
    // `<mailbox>%` user. Fail loudly instead of authenticating as nobody.
    const job = service.buildJobManifest(baseInput);
    const cmd = (job.spec?.template.spec?.containers?.[0]?.command ?? []).join('\n');
    expect(cmd).toContain('if [ -z "$DEST_MASTER_USER" ]');
    expect(cmd).toContain('exit 78');
  });

  it('passes optional --automap and --nofoldersizes when set in options', () => {
    const job = service.buildJobManifest({
      ...baseInput,
      options: { automap: true, noFolderSizes: true },
    });
    const args = job.spec?.template.spec?.containers?.[0]?.args ?? [];
    expect(args).toContain('--automap');
    expect(args).toContain('--nofoldersizes');
  });

  it('passes --dry for a dry-run', () => {
    const job = service.buildJobManifest({ ...baseInput, options: { dryRun: true } });
    const args = job.spec?.template.spec?.containers?.[0]?.args ?? [];
    expect(args).toContain('--dry');
  });

  it('passes --exclude flags for each exclude folder pattern', () => {
    const job = service.buildJobManifest({
      ...baseInput,
      options: { excludeFolders: ['Spam', 'Trash'] },
    });
    const args = job.spec?.template.spec?.containers?.[0]?.args ?? [];
    // imapsync uses --exclude '<regex>' — we expect both patterns
    const argsText = args.join(' ');
    expect(argsText).toContain('--exclude Spam');
    expect(argsText).toContain('--exclude Trash');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildJobSecret (pure function)
// ═══════════════════════════════════════════════════════════════════════════

describe('buildJobSecret', () => {
  it('carries ONLY the source password into stringData', () => {
    const sec = service.buildJobSecret({
      jobId: 'job-123',
      namespace: 'mail',
      sourcePassword: 'srcpw',
    });
    expect(sec.metadata?.name).toBe('imapsync-job-123');
    expect(sec.stringData).toEqual({
      SOURCE_PASSWORD: 'srcpw',
    });
    // type defaults to Opaque
    expect(sec.type).toBe('Opaque');
  });

  // Regression: platform-api used to read Stalwart's master password out
  // of its own STALWART_MASTER_SECRET env var and copy the cleartext into
  // this per-job Secret. The Job now reads it from `mail-secrets` via
  // secretKeyRef, so the master password must never land here.
  it('never writes DEST_PASSWORD into the per-job Secret', () => {
    const sec = service.buildJobSecret({
      jobId: 'job-123',
      namespace: 'mail',
      sourcePassword: 'srcpw',
    });
    expect(Object.keys(sec.stringData ?? {})).not.toContain('DEST_PASSWORD');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createImapSyncJob (DB only — does NOT touch K8s)
// ═══════════════════════════════════════════════════════════════════════════

describe('createImapSyncJob', () => {
  it('inserts a pending row with the encrypted source password', async () => {
    // ownership lookup: mailbox exists and belongs to tenant
    selectResults = [
      [{ id: 'mb1', tenantId: 'c1', fullAddress: 'alice@acme.com' }],
    ];
    const now = new Date('2026-04-08T12:00:00Z');
    insertReturning = [
      {
        id: 'job-1',
        tenantId: 'c1',
        mailboxId: 'mb1',
        sourceHost: 'imap.gmail.com',
        sourcePort: 993,
        sourceUsername: 'alice@gmail.com',
        sourcePasswordEncrypted: 'encrypted:p@ss',
        sourceSsl: 1,
        options: {},
        status: 'pending',
        k8sJobName: null,
        k8sNamespace: 'mail',
        logTail: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ];
    const db = createMockDb();

    const result = await service.createImapSyncJob(db as never, 'enckey', 'c1', {
      mailbox_id: 'mb1',
      source_host: 'imap.gmail.com',
      source_port: 993,
      source_username: 'alice@gmail.com',
      source_password: 'p@ss',
      source_ssl: true,
      options: {},
    });

    expect(result.status).toBe('pending');
    expect(db.insert).toHaveBeenCalled();
    // Inspect the values that were passed to .values()
    const insertedValues = (db._insertValuesFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    const v = insertedValues as Record<string, unknown>;
    expect(v.tenantId).toBe('c1');
    expect(v.mailboxId).toBe('mb1');
    expect(v.sourcePasswordEncrypted).toBe('encrypted:p@ss');
    expect(v.status).toBe('pending');
    // Ensure the plaintext password is NOT in the inserted values under any
    // other field name.
    for (const [key, value] of Object.entries(v)) {
      if (key === 'sourcePasswordEncrypted') continue;
      expect(typeof value === 'string' ? value : '').not.toContain('p@ss');
    }
  });

  it('throws MAILBOX_NOT_FOUND when the mailbox does not belong to the tenant', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(
      service.createImapSyncJob(db as never, 'k', 'c1', {
        mailbox_id: 'ghost',
        source_host: 'h',
        source_port: 993,
        source_username: 'u',
        source_password: 'p',
        source_ssl: true,
        options: {},
      }),
    ).rejects.toMatchObject({ code: 'MAILBOX_NOT_FOUND', status: 404 });
  });

  it('throws IMAPSYNC_ALREADY_RUNNING on partial-unique-index violation', async () => {
    selectResults = [
      [{ id: 'mb1', tenantId: 'c1', fullAddress: 'alice@acme.com' }],
    ];
    insertImpl = () => {
      // Simulate the partial unique index violation
      const err = new Error('duplicate key value violates unique constraint "imap_sync_jobs_mailbox_active_unique"') as Error & { code?: string };
      err.code = '23505';
      return Promise.reject(err);
    };
    const db = createMockDb();

    await expect(
      service.createImapSyncJob(db as never, 'k', 'c1', {
        mailbox_id: 'mb1',
        source_host: 'h',
        source_port: 993,
        source_username: 'u',
        source_password: 'p',
        source_ssl: true,
        options: {},
      }),
    ).rejects.toMatchObject({ code: 'IMAPSYNC_ALREADY_RUNNING', status: 409 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// listImapSyncJobs / getImapSyncJob
// ═══════════════════════════════════════════════════════════════════════════

describe('listImapSyncJobs', () => {
  it('returns rows for the tenant with passwords stripped', async () => {
    const dbRow = {
      id: 'job-1',
      tenantId: 'c1',
      mailboxId: 'mb1',
      sourceHost: 'imap.gmail.com',
      sourcePort: 993,
      sourceUsername: 'alice@gmail.com',
      sourcePasswordEncrypted: 'encrypted:secret',
      sourceSsl: 1,
      options: {},
      status: 'running',
      k8sJobName: 'imapsync-job-1',
      k8sNamespace: 'mail',
      logTail: 'transferring 100/200 messages',
      errorMessage: null,
      startedAt: new Date('2026-04-08T10:00:00Z'),
      finishedAt: null,
      createdAt: new Date('2026-04-08T09:59:00Z'),
      updatedAt: new Date('2026-04-08T10:00:00Z'),
    };
    selectResults = [[dbRow]];
    const db = createMockDb();

    const rows = await service.listImapSyncJobs(db as never, 'c1');
    expect(rows).toHaveLength(1);
    // Password fields MUST be stripped
    expect(rows[0]).not.toHaveProperty('sourcePasswordEncrypted');
    expect(rows[0]).not.toHaveProperty('source_password_encrypted');
    expect(rows[0].id).toBe('job-1');
    expect(rows[0].sourceSsl).toBe(true); // converted from int to bool
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Round-4 Phase 1: deleteTerminalJob
// ═══════════════════════════════════════════════════════════════════════════

describe('deleteTerminalJob', () => {
  it('deletes a succeeded job and returns its tenantId, status, and K8s coordinates', async () => {
    selectResults = [[
      {
        tenantId: 'c1',
        status: 'succeeded',
        k8sJobName: 'imapsync-job-1',
        k8sNamespace: 'mail',
      },
    ]];
    let deleted = false;
    deleteImpl = async () => { deleted = true; };
    const db = createMockDb();

    const result = await service.deleteTerminalJob(db as never, 'c1', 'job-1');

    expect(result).toEqual({
      tenantId: 'c1',
      status: 'succeeded',
      k8sJobName: 'imapsync-job-1',
      k8sNamespace: 'mail',
    });
    expect(deleted).toBe(true);
  });

  it('deletes a failed job', async () => {
    selectResults = [[{ tenantId: 'c1', status: 'failed', k8sJobName: 'imapsync-job-1', k8sNamespace: 'mail' }]];
    deleteImpl = async () => undefined;
    const db = createMockDb();

    const result = await service.deleteTerminalJob(db as never, 'c1', 'job-1');
    expect(result?.status).toBe('failed');
  });

  it('deletes a cancelled job', async () => {
    selectResults = [[{ tenantId: 'c1', status: 'cancelled', k8sJobName: 'imapsync-job-1', k8sNamespace: 'mail' }]];
    deleteImpl = async () => undefined;
    const db = createMockDb();

    const result = await service.deleteTerminalJob(db as never, 'c1', 'job-1');
    expect(result?.status).toBe('cancelled');
  });

  it('throws INVALID_STATE 409 when the job is still running', async () => {
    selectResults = [[{ tenantId: 'c1', status: 'running', k8sJobName: 'imapsync-job-1', k8sNamespace: 'mail' }]];
    const db = createMockDb();

    await expect(service.deleteTerminalJob(db as never, 'c1', 'job-1'))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('throws INVALID_STATE 409 when the job is still pending', async () => {
    selectResults = [[{ tenantId: 'c1', status: 'pending', k8sJobName: null, k8sNamespace: 'mail' }]];
    const db = createMockDb();

    await expect(service.deleteTerminalJob(db as never, 'c1', 'job-1'))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('returns null when the job does not exist', async () => {
    selectResults = [[]];
    const db = createMockDb();

    const result = await service.deleteTerminalJob(db as never, 'c1', 'missing');
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Round-4 Phase 1: resyncImapSyncJob
// ═══════════════════════════════════════════════════════════════════════════

describe('resyncImapSyncJob', () => {
  const ORIGINAL = {
    id: 'job-orig',
    tenantId: 'c1',
    mailboxId: 'mb1',
    sourceHost: 'imap.gmail.com',
    sourcePort: 993,
    sourceUsername: 'alice@gmail.com',
    sourcePasswordEncrypted: 'encrypted:secret',
    sourceSsl: 1,
    options: { automap: true },
    status: 'succeeded',
    k8sJobName: 'imapsync-job-orig',
    k8sNamespace: 'mail',
    logTail: null,
    errorMessage: null,
    startedAt: new Date(),
    finishedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('resets the existing row in-place to pending status', async () => {
    // 1st select: find original, 2nd select: count active (limit check)
    selectResults = [[ORIGINAL], [{ count: 0 }]];
    const db = createMockDb();
    (db as unknown as { _setUpdateReturning: (v: unknown[]) => void })._setUpdateReturning([
      { ...ORIGINAL, status: 'pending', logTail: null, errorMessage: null },
    ]);

    const result = await service.resyncImapSyncJob(db as never, 'c1', 'job-orig');

    expect(result.status).toBe('pending');
    // Verify the update was called with reset fields
    const setArgs = (db as unknown as { _updateSet: { mock: { calls: [Record<string, unknown>][] } } })._updateSet.mock.calls[0]?.[0];
    expect(setArgs.status).toBe('pending');
    expect(setArgs.logTail).toBeNull();
    expect(setArgs.errorMessage).toBeNull();
    expect(setArgs.messagesTotal).toBeNull();
    expect(setArgs.messagesTransferred).toBeNull();
  });

  it('throws INVALID_STATE when the original is still running', async () => {
    selectResults = [[{ ...ORIGINAL, status: 'running' }]];
    const db = createMockDb();

    await expect(service.resyncImapSyncJob(db as never, 'c1', 'job-orig'))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('throws INVALID_STATE when the original is still pending', async () => {
    selectResults = [[{ ...ORIGINAL, status: 'pending' }]];
    const db = createMockDb();

    await expect(service.resyncImapSyncJob(db as never, 'c1', 'job-orig'))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
  });

  it('throws IMAPSYNC_JOB_NOT_FOUND when the row does not exist', async () => {
    selectResults = [[]];
    const db = createMockDb();

    await expect(service.resyncImapSyncJob(db as never, 'c1', 'missing'))
      .rejects.toMatchObject({ code: 'IMAPSYNC_JOB_NOT_FOUND', status: 404 });
  });

  it('throws IMAPSYNC_ACTIVE_LIMIT when 3 jobs are already active', async () => {
    // 1st select: find original, 2nd select: count active = 3 (at limit)
    selectResults = [[ORIGINAL], [{ count: 3 }]];
    const db = createMockDb();

    await expect(service.resyncImapSyncJob(db as never, 'c1', 'job-orig'))
      .rejects.toMatchObject({ code: 'IMAPSYNC_ACTIVE_LIMIT', status: 429 });
  });
});

/**
 * Spam-folder remapping. Measured on a real DinD Stalwart 0.16 (2026-09-02)
 * by running the pinned imapsync image twice against identical seeded
 * sources — once as shipped, once with the remap:
 *
 *   source folders: spam / Spam / Junk / junk, one message each
 *
 *   CONTROL (--automap only, as shipped)
 *     Junk Mail (\Junk) : FROM-2-Spam, FROM-3-Junk, FROM-4-junk
 *     spam      (no flag): FROM-1-spam          <-- stray folder, the bug
 *
 *   WITH --regextrans2
 *     Junk Mail (\Junk) : all four
 *     (no stray folder)
 *
 * So automap already handles `Spam`, `Junk` and `junk`; only all-lowercase
 * `spam` escapes it. The remap closes that without disturbing the three that
 * already worked, and transferred the same 4 messages in both runs.
 *
 * Stalwart's junk folder is `Junk Mail` with role `junk` — verified via
 * Mailbox/get on both a production and a DinD server. It is NOT `Spam`;
 * targeting `Spam` would create a second, role-less folder.
 */
describe('spam-folder remapping', () => {
  const { buildFolderRemapExpression, SPAM_ALIASES, DEFAULT_SPAM_FOLDER, buildJobManifest } = service;
  const baseManifestInput = (over: { options: Record<string, unknown> }) => ({
    jobId: 'job-spam', secretName: 'imapsync-job-spam', namespace: 'mail',
    mailboxAddress: 'alice@acme.com', sourceHost: 'imap.example.test', sourcePort: 993,
    sourceUsername: 'alice@example.test', sourceSsl: true,
    destHost: 'stalwart-mail.mail.svc.cluster.local', destPort: 143,
    image: 'gilleslamiral/imapsync:2.319',
    ...over,
  });
  const expr = () => buildFolderRemapExpression({ dest: DEFAULT_SPAM_FOLDER, aliases: SPAM_ALIASES });

  it('targets Stalwart\'s real junk folder name, not "Spam"', () => {
    expect(DEFAULT_SPAM_FOLDER).toBe('Junk Mail');
  });

  it('is a well-formed anchored, case-insensitive substitution', () => {
    const e = expr();
    expect(e.startsWith('s{^')).toBe(true);
    expect(e.endsWith('}i')).toBe(true);
    expect(e).toContain('{Junk Mail}');
  });

  it('covers every reported variant plus the INBOX-prefixed forms', () => {
    const e = expr();
    // Mirror Perl's semantics closely enough to assert coverage.
    const body = e.slice('s{'.length, e.indexOf('}{'));
    const re = new RegExp(body, 'i');
    for (const f of ['spam', 'Spam', 'SPAM', 'junk', 'Junk', 'JUNK',
                     'Junk E-mail', 'Bulk Mail', 'INBOX.spam', 'INBOX/Junk']) {
      expect(re.test(f), `${f} should remap`).toBe(true);
    }
  });

  it('leaves unrelated folders and spam SUBfolders alone', () => {
    const e = expr();
    const body = e.slice('s{'.length, e.indexOf('}{'));
    const re = new RegExp(body, 'i');
    // Anchoring matters: an unanchored rule would collapse a whole subtree.
    for (const f of ['INBOX', 'Sent Items', 'Archive', 'Spam/2024', 'Spammers', 'MySpam']) {
      expect(re.test(f), `${f} must NOT remap`).toBe(false);
    }
  });

  it('escapes regex metacharacters in an alias', () => {
    const e = buildFolderRemapExpression({ dest: 'X', aliases: ['a.b', 'c+d'] });
    expect(e).toContain('a\\.b');
    expect(e).toContain('c\\+d');
  });

  it('emits --regextrans2 in the Job args by default', () => {
    const job = buildJobManifest(baseManifestInput({ options: { automap: true } }));
    const args = job.spec?.template.spec?.containers[0].args ?? [];
    const i = args.indexOf('--regextrans2');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toContain('Junk Mail');
    // Must come after --automap so the explicit rule wins.
    expect(i).toBeGreaterThan(args.indexOf('--automap'));
  });

  it('honours an operator-supplied destination', () => {
    const job = buildJobManifest(baseManifestInput({ options: { spamFolder: 'Junk' } }));
    const args = job.spec?.template.spec?.containers[0].args ?? [];
    expect(args[args.indexOf('--regextrans2') + 1]).toContain('{Junk}');
  });

  it('omits the remap entirely when spamFolder is blank', () => {
    const job = buildJobManifest(baseManifestInput({ options: { spamFolder: '' } }));
    const args = job.spec?.template.spec?.containers[0].args ?? [];
    expect(args).not.toContain('--regextrans2');
  });
});

/**
 * Re-sync must produce the SAME job spec as a fresh run.
 *
 * `resyncImapSyncJob` resets the row and the route then rebuilds the manifest
 * through `buildJobManifest` with the row's STORED `options` jsonb. Rows
 * created before the spam remap existed have no `spamFolder` key, so the
 * default has to apply — otherwise re-syncing an old migration would quietly
 * reproduce the original mis-filed spam, which is the one case where a user
 * is most likely to re-sync.
 */
describe('re-sync rebuilds the folder mapping', () => {
  const resyncInput = (storedOptions: Record<string, unknown>) => ({
    jobId: 'job-1-1756800000000',
    secretName: 'imapsync-job-1-1756800000000',
    namespace: 'mail',
    mailboxAddress: 'alice@acme.com',
    sourceHost: 'imap.example.test',
    sourcePort: 993,
    sourceUsername: 'alice@example.test',
    sourceSsl: true,
    destHost: 'stalwart-mail.mail.svc.cluster.local',
    destPort: 143,
    image: 'gilleslamiral/imapsync:2.319',
    options: storedOptions,
  });

  it('applies the spam remap to a row stored before the feature existed', () => {
    // Exactly what an pre-existing row's `options` jsonb looks like.
    const job = service.buildJobManifest(resyncInput({ automap: true }));
    const args = job.spec?.template.spec?.containers[0].args ?? [];
    expect(args).toContain('--regextrans2');
    expect(args[args.indexOf('--regextrans2') + 1]).toContain('Junk Mail');
  });

  it('applies it even when the stored options are empty', () => {
    const job = service.buildJobManifest(resyncInput({}));
    const args = job.spec?.template.spec?.containers[0].args ?? [];
    expect(args).toContain('--regextrans2');
  });

  it('carries an operator override through a re-sync', () => {
    const job = service.buildJobManifest(resyncInput({ spamFolder: 'Junk' }));
    const args = job.spec?.template.spec?.containers[0].args ?? [];
    expect(args[args.indexOf('--regextrans2') + 1]).toContain('{Junk}');
  });
});
