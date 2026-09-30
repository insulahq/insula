import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// ── mocks for everything the orchestrator reaches out to ──────────────────
const waitForJobMock = vi.fn();
const readLogMock = vi.fn();
const createJobMock = vi.fn();
const deleteJobMock = vi.fn();
const deleteSecretMock = vi.fn();
const createSecretMock = vi.fn();
const initRepoMock = vi.fn();
const forgetMock = vi.fn();
const storeDeleteMock = vi.fn();
const putMetaMock = vi.fn();
const reserveMock = vi.fn();
const fmRemoveMock = vi.fn();

vi.mock('../backup-restore/executors/files-paths.js', () => ({
  waitForJob: (...a: unknown[]) => waitForJobMock(...a),
}));
vi.mock('../storage-lifecycle/job-log-tail.js', () => ({
  readJobLogTail: (...a: unknown[]) => readLogMock(...a),
}));
vi.mock('./components/files.js', () => ({
  buildResticCredsStringData: (a: { repoUri: string }) => ({ restic_password: 'p', repo_uri: a.repoUri }),
  createResticCredsSecret: (...a: unknown[]) => createSecretMock(...a),
  wireSecretOwnerRef: vi.fn(),
}));
vi.mock('./restic-driver.js', () => ({
  buildResticEnv: () => ({}),
  buildResticRepoUri: (_t: unknown, tid: string, c: string) => `repo:${tid}:${c}`,
  deriveResticPassword: () => 'deadbeef',
  ensureResticRepoInitialised: (...a: unknown[]) => initRepoMock(...a),
}));
vi.mock('./orchestrator.js', () => ({
  // Reused by buildImportedMeta so an imported bundle's meta is shaped
  // exactly like a captured one.
  captureTenantBlock: async () => ({
    name: 'T', primaryEmail: 'o@example.test', secondaryEmail: null, status: 'active',
    kubernetesNamespace: 'tenant-x', regionId: '11111111-1111-4111-8111-111111111111',
    planId: '22222222-2222-4222-8222-222222222222', nodeName: null, storageTier: 'local',
    timezone: null, storageLimitOverride: null, cpuLimitOverride: null, memoryLimitOverride: null,
    maxSubUsersOverride: null, maxMailboxesOverride: null, monthlyPriceOverride: null,
    emailSendRateLimit: null, subscriptionExpiresAt: null, effectiveResources: null,
    counts: { mailboxes: 0, domains: 0, deployments: 0 },
  }),
  captureDomainsSummary: async () => [],
  captureDeploymentsSummary: async () => [],
}));
vi.mock('./repo-init-lock.js', () => ({ makeRepoInitSerialiser: () => (_u: string, fn: () => unknown) => fn() }));
vi.mock('./repo-layout.js', () => ({ CURRENT_REPO_LAYOUT: 'per-tenant' }));
vi.mock('./upload-token.js', () => ({ signUploadToken: () => 'tok-123' }));
vi.mock('./resolve-backup-target.js', () => ({
  resolveShimBackupTarget: async () => ({ kind: 'hostpath', hostPath: '/srv' }),
}));
vi.mock('./shim-backup-store.js', () => ({
  resolveShimBackupStore: async () => ({
    kind: 'rclone',
    reserveBundle: (...a: unknown[]) => reserveMock(...a),
    putMeta: (...a: unknown[]) => putMetaMock(...a),
    delete: (...a: unknown[]) => storeDeleteMock(...a),
  }),
}));
vi.mock('./resolve-store.js', () => ({
  resolveBackupStore: async () => ({
    // `kind` matters: targetKind is derived from the STORE, and the
    // backup_target_kind enum has no `cifs` — a config-derived kind fails
    // the insert on any real (shim/cifs) cluster.
    kind: 'rclone',
    reserveBundle: (...a: unknown[]) => reserveMock(...a),
    putMeta: (...a: unknown[]) => putMetaMock(...a),
    delete: (...a: unknown[]) => storeDeleteMock(...a),
  }),
}));
vi.mock('./import-reaper.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  forgetImportSnapshots: (...a: unknown[]) => forgetMock(...a),
  reapImportUpload: (...a: unknown[]) => fmRemoveMock(...a),
  deleteAbortedImportRow: (...a: unknown[]) => deleteRowMock(...a),
}));
const deleteRowMock = vi.fn();
const writableMock = vi.fn();
vi.mock('../backup-config/writable-guard.js', () => ({
  requireWritableTarget: (...a: unknown[]) => writableMock(...a),
}));

const { runBundleImport, buildImportLabel, assertImportComplete, buildImportedMeta, MANUAL_IMPORT_LABEL } =
  await import('./import-orchestrator.js');

type Insert = { table: string; rows: unknown[] };

function recordingDb(cfg: Record<string, unknown> | null) {
  const inserts: Insert[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(cfg ? [cfg] : []) }) }) }),
    insert: (t: { _: { name?: string } } | unknown) => ({
      values: (rows: unknown) => {
        inserts.push({ table: tableName(t), rows: Array.isArray(rows) ? rows : [rows] });
        return Promise.resolve();
      },
    }),
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: () => { updates.push(v); return Promise.resolve(); } }) }),
  };
  return { db: db as never, inserts, updates };
}
function tableName(t: unknown): string {
  const sym = Object.getOwnPropertySymbols(t as object).find((s) => String(s).includes('Name'));
  return sym ? String((t as Record<symbol, unknown>)[sym]) : 'unknown';
}

// `enabled` is the operator's on/off switch. `active` is the Longhorn
// BackupTarget designator — at most one row per cluster carries it and the
// schema says it is "not consulted by the shim path (… tenant-bundles …)",
// so gating on it refused almost every real target.
const CFG = { id: 'cfg-1', name: 'main', enabled: 1, active: false, storageType: 's3' };

const PREFLIGHT = {
  sourceBundleId: 'bkp-src', sourceTenantId: 't-src',
  units: [
    { component: 'files' as const, name: 'archive', sizeBytes: 100 },
    { component: 'mailboxes' as const, name: 'a@example.test', sizeBytes: 0 },
  ],
  objectArtifacts: [], dropped: [], totalBytes: 100, stageSizeLimit: '2Gi',
  sourceComponents: { files: { sizeBytes: 100 } },
  quota: { limitBytes: 0, incomingBytes: 100, fits: true },
  mailboxDomains: { ok: true, rejected: [] },
  warnings: [], blocked: false, blockReasons: [],
};

const INPUT = {
  // A REAL v4 uuid: the manifest schema validates tenantId, and zod v4
  // checks the version and variant nibbles, not just the shape.
  tenantId: '33333333-3333-4333-8333-333333333333', namespace: 'tenant-x', pvcName: 'pvc-1', importId: 'imp1',
  archiveRelPath: '.insula-imports/imp1.tar.gz', targetConfigId: 'cfg-1',
  preflight: PREFLIGHT, scope: 'admin' as const, initiator: 'admin' as const,
};

function deps(db: unknown) {
  return {
    db: db as never,
    k8s: {
      batch: { createNamespacedJob: createJobMock, deleteNamespacedJob: deleteJobMock },
      core: {
        deleteNamespacedSecret: deleteSecretMock,
        listNamespacedPod: async () => ({ items: [{ metadata: { name: 'p1' } }] }),
      },
    } as never,
    fm: { remove: async () => {}, list: async () => [] },
    log: { warn: vi.fn(), info: vi.fn() },
    encryptionKey: 'ab'.repeat(32),
    platformApiUrl: 'http://platform-api.platform.svc:3000',
    platformVersion: 'v1',
  };
}

const OK_LOG = [
  `IMPORT_UNIT_DONE importId=imp1 component=files name=archive snapshot=${'a'.repeat(64)} sizeBytes=100 addedBytes=50 fileCount=3`,
  `IMPORT_UNIT_DONE importId=imp1 component=mailboxes name=a@example.test snapshot=${'b'.repeat(64)} sizeBytes=20 addedBytes=10 fileCount=5`,
  'IMPORT_DONE importId=imp1 units=2 objects=0',
].join('\n');

beforeEach(() => {
  for (const m of [waitForJobMock, readLogMock, createJobMock, deleteJobMock, deleteSecretMock,
    createSecretMock, initRepoMock, forgetMock, storeDeleteMock, putMetaMock, reserveMock,
    fmRemoveMock, deleteRowMock, writableMock]) m.mockReset();
  createJobMock.mockResolvedValue({ metadata: { uid: 'u1' } });
  reserveMock.mockResolvedValue({ backupId: 'x' });
  readLogMock.mockResolvedValue(OK_LOG);
});

describe('buildImportLabel', () => {
  it('always carries the manual-import marker', () => {
    expect(buildImportLabel()).toBe(MANUAL_IMPORT_LABEL);
    expect(buildImportLabel('  ')).toBe(MANUAL_IMPORT_LABEL);
    expect(buildImportLabel('from prod')).toBe('manual-import: from prod');
    expect(buildImportLabel('x'.repeat(400))).toHaveLength(255);
    expect(buildImportLabel('x'.repeat(400)).startsWith(MANUAL_IMPORT_LABEL)).toBe(true);
  });
});

describe('runBundleImport — success path', () => {
  it('registers the bundle only after every unit landed, and reaps the upload', async () => {
    const { db, inserts, updates } = recordingDb(CFG);
    const d = deps(db);
    const r = await runBundleImport(d, INPUT);

    expect(r.bundleId).toMatch(/^bkp-/);
    expect(r.sizeBytes).toBe(120);

    // the job row is inserted as `running`, never as `completed`
    const jobRow = inserts.find((i) => i.table.includes('backup_jobs'))!.rows[0] as Record<string, unknown>;
    expect(jobRow.status).toBe('running');
    // rclone (the shim) maps to `s3`; `cifs` is not a backup_target_kind value
    expect(jobRow.targetKind).toBe('s3');
    expect(jobRow.label).toBe(MANUAL_IMPORT_LABEL);

    // component rows exist and carry the SNAPSHOT id in sha256
    const comps = inserts.find((i) => i.table.includes('backup_components'))!.rows as Array<Record<string, unknown>>;
    expect(comps).toHaveLength(2);
    expect(comps[0]!.sha256).toBe('a'.repeat(64));

    // …and only then is it flipped to completed
    expect(updates.at(-1)).toMatchObject({ status: 'completed', sizeBytes: 120 });
    // consumed on success, so it stops counting against the tenant's quota
    expect(fmRemoveMock).toHaveBeenCalled();
    expect(forgetMock).not.toHaveBeenCalled();
    expect(storeDeleteMock).not.toHaveBeenCalled();
  });

  it('initialises one repo per distinct component URI before the Job', async () => {
    const { db } = recordingDb(CFG);
    await runBundleImport(deps(db), INPUT);
    expect(initRepoMock).toHaveBeenCalled();
    expect(initRepoMock.mock.invocationCallOrder[0]!).toBeLessThan(createJobMock.mock.invocationCallOrder[0]!);
  });
});

describe('runBundleImport — failure teardown', () => {
  it('★ writes NO component rows and tears everything down when a unit is missing', async () => {
    // The Job says DONE but only one unit reported — a truncated log or a
    // dropped malformed snapshot id. Registering would publish a bundle the
    // restore cart cannot fulfil.
    readLogMock.mockResolvedValue(
      `IMPORT_UNIT_DONE importId=imp1 component=files name=archive snapshot=${'a'.repeat(64)} sizeBytes=100 addedBytes=1\n`
      + 'IMPORT_DONE importId=imp1 units=2 objects=0',
    );
    const { db, inserts } = recordingDb(CFG);
    await expect(runBundleImport(deps(db), INPUT)).rejects.toThrow(/did not produce a snapshot/);

    expect(inserts.some((i) => i.table.includes('backup_components'))).toBe(false);
    // the partial snapshot is forgotten, the bundle dropped, the row deleted
    expect(forgetMock).toHaveBeenCalled();
    const byRepo = (forgetMock.mock.calls[0]![0] as { byRepo: Map<string, string[]> }).byRepo;
    expect([...byRepo.values()].flat()).toEqual(['a'.repeat(64)]);
    expect(storeDeleteMock).toHaveBeenCalled();
    expect(deleteRowMock).toHaveBeenCalled();
    expect(fmRemoveMock).not.toHaveBeenCalled();
  });

  it('★ KEEPS the uploaded archive when the import fails, so a retry is cheap', async () => {
    // The archive is the one artifact the import did not create. Deleting it
    // on failure makes the obvious next step cost a full re-upload of a
    // multi-GB file. The sweeper reclaims it if no retry follows.
    waitForJobMock.mockRejectedValue(new Error('Job failed: evicted'));
    readLogMock.mockResolvedValue('');   // died before any unit reported
    const { db } = recordingDb(CFG);
    await expect(runBundleImport(deps(db), INPUT)).rejects.toThrow(/evicted/);
    expect(fmRemoveMock).not.toHaveBeenCalled();
    // everything the import DID create is still torn down
    expect(deleteJobMock).toHaveBeenCalled();
    expect(deleteSecretMock).toHaveBeenCalled();
    // nothing was snapshotted, so nothing to forget
    expect(forgetMock).not.toHaveBeenCalled();
  });

  it('★ forgets the snapshots a PARTIALLY successful Job already wrote', async () => {
    // The common failure: unit 1 succeeds, unit 2 fails, the Job is marked
    // Failed and waitForJob throws. The snapshot from unit 1 is real and its
    // id exists only in the Job log — so reading the log ONLY on the success
    // path left it orphaned in the repo forever, referenced by nothing and
    // invisible to retention.
    waitForJobMock.mockRejectedValue(new Error('Job failed: unit 2 exited 1'));
    readLogMock.mockResolvedValue(
      `IMPORT_UNIT_DONE importId=imp1 component=files name=archive snapshot=${'a'.repeat(64)} sizeBytes=100 addedBytes=5`,
    );
    const { db, inserts } = recordingDb(CFG);
    await expect(runBundleImport(deps(db), INPUT)).rejects.toThrow(/unit 2 exited/);

    expect(forgetMock).toHaveBeenCalled();
    const byRepo = (forgetMock.mock.calls[0]![0] as { byRepo: Map<string, string[]> }).byRepo;
    expect([...byRepo.values()].flat()).toEqual(['a'.repeat(64)]);
    expect(inserts.some((i) => i.table.includes('backup_components'))).toBe(false);
  });

  it('★ a failing progress sink cannot fail an import that already succeeded', async () => {
    // The only statement between the flip to `completed` and `return` is the
    // progress call, and it is wrapped: a cosmetic sink failure must not
    // surface as a failed import, and must not reach the teardown.
    const { db } = recordingDb(CFG);
    const r = await runBundleImport(deps(db), { ...INPUT, onProgress: (m: string) => {
      if (m === 'Import complete.') throw new Error('progress sink exploded');
    } } as never);
    expect(r.bundleId).toMatch(/^bkp-/);
    expect(forgetMock).not.toHaveBeenCalled();
    expect(storeDeleteMock).not.toHaveBeenCalled();
    expect(deleteRowMock).not.toHaveBeenCalled();
  });

  it('★ the teardown is guarded on `succeeded`', () => {
    // Source-level ON PURPOSE. Behaviourally this is unreachable today —
    // the one post-commit statement is wrapped above, so nothing can throw
    // into the catch after the bundle is registered, and a behavioural test
    // would pass with the guard REMOVED (verified by mutation). The guard is
    // defence for the next statement someone adds there, and the property
    // worth pinning is that it exists: without it, a throw after the flip to
    // `completed` would forget the snapshots and delete the artefacts while
    // `deleteAbortedImportRow` (which skips completed rows) left the row —
    // a bundle registered complete with no data behind it.
    const src = readFileSync('src/modules/tenant-bundles/import-orchestrator.ts', 'utf8');
    // Anchored on the guard comment, not on `  } catch (err) {` — that
    // 2-space pattern is a SUBSTRING of the 6-space inner catch around
    // waitForJob, so it sliced the wrong block and the test failed on
    // correct code.
    const start = src.indexOf('    // ★ Guarded on `succeeded`.');
    expect(start, 'guard comment not found').toBeGreaterThan(-1);
    const catchBlock = src.slice(start, src.indexOf('\n  } finally {', start));
    expect(catchBlock).toMatch(/if \(!succeeded\) \{/);
    // Match the CALLS, not the bare names — the comment above the guard
    // names them too, and matching that put the first "hit" before the guard.
    const guardAt = catchBlock.indexOf('if (!succeeded) {');
    expect(guardAt, 'guard not found in the catch block').toBeGreaterThan(-1);
    for (const call of [
      'await forgetImportSnapshots({',
      'await store.delete(handle)',
      'await deleteAbortedImportRow(deps.db, bundleId)',
    ]) {
      const at = catchBlock.indexOf(call);
      expect(at, `${call} not found`).toBeGreaterThan(-1);
      expect(at, `${call} is not inside the guard`).toBeGreaterThan(guardAt);
    }
  });

  it('refuses a blocked preflight before creating anything', async () => {
    const { db } = recordingDb(CFG);
    await expect(runBundleImport(deps(db), {
      ...INPUT, preflight: { ...PREFLIGHT, blocked: true, blockReasons: ['does not own example.test'] },
    })).rejects.toThrow(/does not own/);
    expect(reserveMock).not.toHaveBeenCalled();
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it('★ refuses a FROZEN (read-only) backup target before creating anything', async () => {
    // A frozen target is still `active` — freezing is what an operator does
    // while decommissioning one, and an import is a write like any other.
    writableMock.mockRejectedValueOnce(new Error('Backup target is frozen'));
    const { db } = recordingDb(CFG);
    await expect(runBundleImport(deps(db), INPUT)).rejects.toThrow(/frozen/);
    expect(reserveMock).not.toHaveBeenCalled();
    expect(createJobMock).not.toHaveBeenCalled();
    expect(initRepoMock).not.toHaveBeenCalled();
  });

  it('refuses a DISABLED backup target', async () => {
    const { db } = recordingDb({ ...CFG, enabled: 0 });
    await expect(runBundleImport(deps(db), INPUT)).rejects.toThrow(/is disabled/);
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('★ does NOT gate on `active`, which is the Longhorn-only column', () => {
    // Gating on it would refuse every target except the single Longhorn row —
    // a failure that reads like a misconfigured backup rather than a wrong
    // column, which is why it is pinned here.
    const src = readFileSync('src/modules/tenant-bundles/import-orchestrator.ts', 'utf8');
    expect(src).not.toMatch(/cfg\.active/);
    expect(src).toMatch(/cfg\.enabled === 0/);
  });
});

describe('assertImportComplete', () => {
  const pf = PREFLIGHT as never;
  const units = [{ component: 'files', name: 'archive' }, { component: 'mailboxes', name: 'a@example.test' }];

  it('passes when the log and the promise agree', () => {
    expect(() => assertImportComplete(OK_LOG, 'imp1', pf, units, [])).not.toThrow();
  });

  it('refuses a log with no completion marker', () => {
    expect(() => assertImportComplete('IMPORT_EXTRACTED units=2', 'imp1', pf, units, []))
      .toThrow(/did not report completion/);
  });

  it('refuses a completion marker belonging to another import', () => {
    expect(() => assertImportComplete('IMPORT_DONE importId=other units=2 objects=0', 'imp1', pf, units, []))
      .toThrow(/did not report completion/);
  });

  it('refuses a missing object artifact', () => {
    const withObjects = { ...PREFLIGHT, objectArtifacts: [{ component: 'config', name: 'db-rows.json.gz', sizeBytes: 1 }] } as never;
    expect(() => assertImportComplete(OK_LOG, 'imp1', withObjects, units, []))
      .toThrow(/did not upload: config/);
  });
});

describe('buildImportedMeta', () => {
  const UNITS = [
    { component: 'files', name: 'archive', snapshotId: 'a'.repeat(64), sizeBytes: 100, addedBytes: 1, fileCount: 3 },
    { component: 'mailboxes', name: 'a@example.test', snapshotId: 'b'.repeat(64), sizeBytes: 20, addedBytes: 1, fileCount: 5 },
  ];

  it('rebuilds components from what actually landed, not from the source meta', async () => {
    const meta = await buildImportedMeta({
      db: {} as never, bundleId: 'bkp-new', input: INPUT as never, preflight: PREFLIGHT as never,
      units: UNITS, objects: [], platformVersion: 'v1', retentionDays: 30,
    });
    expect(meta.backupId).toBe('bkp-new');
    expect(meta.tenantId).toBe('33333333-3333-4333-8333-333333333333');
    expect(meta.label).toBe(MANUAL_IMPORT_LABEL);
    const c = meta.components as Record<string, Record<string, unknown>>;
    // the files component's sha256 IS the restic snapshot id, and fileCount
    // comes out of the run rather than being guessed
    expect(c.files).toEqual({ sizeBytes: 100, fileCount: 3, sha256: 'a'.repeat(64) });
    expect(c.mailboxes!.addresses).toEqual(['a@example.test']);
    expect(c.mailboxes!.snapshots).toEqual({ 'a@example.test': 'b'.repeat(64) });
    // provenance, readable without the Job log
    expect(meta.description).toContain('[import:imp1]');
    expect(meta.description).toContain('bkp-src');
  });

  it('★ satisfies the manifest schema putMeta validates against', async () => {
    // An ad-hoc object shaped by hand failed this validation on the first
    // real run — AFTER the snapshots had been written.
    const { backupMetaV1Schema } = await import('@insula/api-contracts');
    const meta = await buildImportedMeta({
      db: {} as never, bundleId: 'bkp-new', input: INPUT as never, preflight: PREFLIGHT as never,
      units: UNITS,
      objects: [{ component: 'config', name: 'db-rows.json.gz', sizeBytes: 12 }],
      platformVersion: 'v1', retentionDays: 30,
    });
    const parsed = backupMetaV1Schema.safeParse(meta);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 1)).toBe(true);
  });
});

describe('assertJobCanSchedule', () => {
  const { } = {};

  function coreWith(pods: unknown[], events: unknown[] = []) {
    return {
      db: {} as never,
      k8s: { core: {
        listNamespacedPod: async () => ({ items: pods }),
        listNamespacedEvent: async () => ({ items: events }),
      } } as never,
      fm: { remove: async () => {}, list: async () => [] },
      log: { warn: vi.fn(), info: vi.fn() },
      encryptionKey: 'ab'.repeat(32),
      platformApiUrl: 'http://x', platformVersion: 'v1',
    };
  }

  it('returns as soon as a pod exists', async () => {
    const { assertJobCanSchedule } = await import('./import-orchestrator.js');
    await expect(assertJobCanSchedule(coreWith([{ metadata: { name: 'p' } }]), 'ns', 'j', { timeoutMs: 50, pollMs: 5 }))
      .resolves.toBeUndefined();
  });

  it('★ fails fast with the quota reason when no pod ever appears', async () => {
    // backoffLimit:0 bounds pod FAILURES, not pod CREATE failures — a quota
    // rejection retries forever, so without this the Job sits in Running 0/1
    // and waitForJob blocks for the whole (multi-hour) deadline.
    const { assertJobCanSchedule } = await import('./import-orchestrator.js');
    const deps = coreWith([], [{
      reason: 'FailedCreate',
      involvedObject: { name: 'j' },
      message: 'failed quota: must specify limits.memory for: import',
    }]);
    await expect(assertJobCanSchedule(deps, 'ns', 'j', { timeoutMs: 40, pollMs: 5 }))
      .rejects.toThrow(/could not start a pod.*failed quota: must specify limits.memory/s);
  });

  it('does not block the import when the pod listing itself fails', async () => {
    const { assertJobCanSchedule } = await import('./import-orchestrator.js');
    const deps = {
      ...coreWith([]),
      k8s: { core: { listNamespacedPod: async () => { throw new Error('api down'); } } } as never,
    };
    await expect(assertJobCanSchedule(deps, 'ns', 'j', { timeoutMs: 40, pollMs: 5 })).resolves.toBeUndefined();
  });
});
