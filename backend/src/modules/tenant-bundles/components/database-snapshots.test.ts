import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildDbContext: vi.fn(),
  listDatabases: vi.fn(),
  mintBackupLogin: vi.fn(),
  dropBackupLogin: vi.fn(),
  readJobLogTail: vi.fn(),
}));
vi.mock('../../deployments/db-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../deployments/db-manager.js')>()),
  buildDbContext: mocks.buildDbContext,
  listDatabases: mocks.listDatabases,
}));
vi.mock('../../deployments/backup-login.js', () => ({
  BACKUP_LOGIN_MAX_AGE_MS: 7 * 3_600_000, mintBackupLogin: mocks.mintBackupLogin, dropBackupLogin: mocks.dropBackupLogin,
}));
vi.mock('../../storage-lifecycle/job-log-tail.js', () => ({ readJobLogTail: mocks.readJobLogTail, tailJobLog: vi.fn(async () => '') }));

import {
  buildDatabaseBackupJobSpec,
  buildDatabaseBackupScript,
  buildDatabaseSnapshotsSummary,
  databaseArtifactName,
  DROP_LOGIN_BACKOFF_MS,
  dropRunLogin,
  dumpFileName,
  hexName,
  parseDatabaseArtifactName,
  parseDatabaseBackupLines,
  snapshotInstanceDatabases,
  tagValue,
  type DatabaseSnapshotResult,
} from './database-snapshots.js';

const ENGINES = ['mariadb', 'mysql', 'postgresql', 'mongodb'] as const;

describe('names', () => {
  it('a dump file is the database name in hex, with the engine\'s extension', () => {
    expect(hexName('we;ird db')).toBe(Buffer.from('we;ird db').toString('hex'));
    expect(dumpFileName('mariadb', 'shop')).toBe('73686f70.sql');
    expect(dumpFileName('postgresql', 'shop')).toBe('73686f70.pgdump');
    expect(dumpFileName('mongodb', 'shop')).toBe('73686f70.archive.gz');
  });

  it('a tag value holds no comma or space', () => {
    expect(tagValue('18.1 (Debian 18.1-1.pgdg13+2)')).toBe('18.1__Debian_18.1-1.pgdg13+2_');
    expect(tagValue('a,b')).not.toContain(',');
  });

  it('an artifact name splits at the first colon: a database name may hold one', () => {
    const name = databaseArtifactName('0b7e4c1e-0000-4000-8000-000000000001', 'odd:name');
    expect(parseDatabaseArtifactName(name)).toEqual({ deploymentId: '0b7e4c1e-0000-4000-8000-000000000001', database: 'odd:name' });
    expect(parseDatabaseArtifactName('databases')).toBeNull();
  });
});

describe('buildDatabaseBackupScript', () => {
  it.each(ENGINES)('%s: valid POSIX sh, dumps through restic, reads its secrets from files', (engine) => {
    const script = buildDatabaseBackupScript(engine);
    const check = spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' });
    expect(check.status, check.stderr).toBe(0);
    expect(script).toContain('backup --json --no-cache');
    expect(script).toContain('--stdin-from-command --');
    expect(script).toContain('/var/run/db-login/password');
    expect(script).toContain('C=/var/run/restic-creds');
    // The dump client does not get the restic credentials.
    expect(script).toContain('--stdin-from-command -- env -u RESTIC_PASSWORD -u RESTIC_REPOSITORY -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY');
    // printf, never echo: no escape in a reason is expanded into a line of its own.
    expect(script).not.toMatch(/\becho\b/);
    expect(script).toContain('$(cat $C/restic_password)');
    // A database name is read with eval on the variable NAME, never its value.
    expect(script).toContain('eval "db=\\${DB_$i}; hex=\\${DB_HEX_$i}; conn=\\${DB_CONN_$i}"');
  });

  it('MySQL alone gets --set-gtid-purged=OFF', () => {
    expect(buildDatabaseBackupScript('mysql')).toContain('--set-gtid-purged=OFF');
    expect(buildDatabaseBackupScript('mariadb')).not.toContain('--set-gtid-purged');
  });

  it('PostgreSQL dumps the custom format, the name as a quoted conninfo', () => {
    expect(buildDatabaseBackupScript('postgresql')).toContain('pg_dump -Fc -d "$conn"');
  });
});

describe('parseDatabaseBackupLines', () => {
  const N = '0011223344556677';
  it('reads each database\'s result and the end marker', () => {
    const p = parseDatabaseBackupLines([
      'noise',
      `DB_DONE nonce=${N} index=0 snapshot=0123abcd4567ef89 bytes=2048 added=512`,
      `DB_FAIL nonce=${N} index=1 rc=1 reason=mysqldump: Got error: 1044: Access denied`,
      `DB_ALL_DONE nonce=${N}`,
    ].join('\n'), N);
    expect(p.results.get(0)).toEqual({ kind: 'done', snapshotId: '0123abcd4567ef89', sizeBytes: 2048, addedBytes: 512 });
    expect(p.results.get(1)).toEqual({ kind: 'failed', error: 'mysqldump: Got error: 1044: Access denied' });
    expect(p.finished).toBe(true);
    expect(p.setupFailed).toBeNull();
  });

  it('a setup failure, an empty reason, a cut-off log', () => {
    const p = parseDatabaseBackupLines(`DB_SETUP_FAILED nonce=${N} no dump tool in this image\nDB_FAIL nonce=${N} index=0 rc=2 reason=`, N);
    expect(p.setupFailed).toBe('no dump tool in this image');
    expect(p.results.get(0)).toEqual({ kind: 'failed', error: 'the dump exited 2' });
    expect(p.finished).toBe(false);
  });

  it('ignores a forged line: a non-hex snapshot, another run\'s nonce, or a second result for a database', () => {
    expect(parseDatabaseBackupLines(`DB_DONE nonce=${N} index=0 snapshot=../../x bytes=1 added=-`, N).results.size).toBe(0);
    expect(parseDatabaseBackupLines('DB_DONE nonce=ffffffffffffffff index=0 snapshot=aaaaaaaa bytes=1 added=-', N).results.size).toBe(0);
    const twice = parseDatabaseBackupLines(`DB_FAIL nonce=${N} index=0 rc=1 reason=x\nDB_DONE nonce=${N} index=0 snapshot=aaaaaaaa bytes=1 added=-`, N);
    expect(twice.results.get(0)).toEqual({ kind: 'failed', error: 'x' });
  });
});

describe('buildDatabaseBackupJobSpec', () => {
  const spec = buildDatabaseBackupJobSpec({
    jobName: 'bk-db-x', namespace: 'tenant-a', tenantId: 't1', bundleId: 'bkp-1', deploymentId: 'd1', engine: 'mariadb',
    image: 'mariadb@sha256:' + 'a'.repeat(64), toolsImage: 'tools:1', serviceHost: 'maria.tenant-a.svc', servicePort: 3306,
    credsSecretName: 'creds', loginSecretName: 'login', databases: ['shop', 'we;ird'], tags: ['tenant-id=t1', 'component=databases'], serverVersion: '10.11.9-MariaDB',
    nonce: '0011223344556677', placement: { nodeSelector: { 'kubernetes.io/hostname': 'node-a' }, priorityClassName: 'platform-tenant-overhead' },
  }) as { metadata: { labels: Record<string, string> }; spec: { template: { spec: Record<string, any> } } };
  const pod = spec.spec.template.spec;

  it('runs unprivileged, without a service account token or a tenant volume', () => {
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 999 });
    // On the tenant's node, outside its quota.
    expect(pod.nodeSelector).toEqual({ 'kubernetes.io/hostname': 'node-a' });
    expect(pod.priorityClassName).toBe('platform-tenant-overhead');
    // restic stages its packs there.
    expect(pod.volumes.find((v: { name: string }) => v.name === 'tmp').emptyDir.sizeLimit).toBe('1Gi');
    expect(pod.automountServiceAccountToken).toBe(false);
    for (const c of [...pod.initContainers, ...pod.containers]) {
      expect(c.securityContext).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    }
    expect(pod.volumes.some((v: Record<string, unknown>) => 'persistentVolumeClaim' in v)).toBe(false);
    for (const m of pod.containers[0].volumeMounts) if (m.name !== 'tmp') expect(m.readOnly).toBe(true);
  });

  it('carries the backup egress label and the databases as environment values', () => {
    expect(spec.metadata.labels['platform.io/component']).toBe('backup-files');
    const env = Object.fromEntries(pod.containers[0].env.map((e: { name: string; value: string }) => [e.name, e.value]));
    expect(env).toMatchObject({ DB_COUNT: '2', DB_0: 'shop', DB_1: 'we;ird', DB_HEX_1: hexName('we;ird'), SVC_PORT: '3306', SERVER_VERSION: '10.11.9-MariaDB' });
    expect(env.TAGS).toBe('tenant-id=t1,component=databases');
    expect(pod.containers[0].image).toBe('mariadb@sha256:' + 'a'.repeat(64));
  });
});

describe('buildDatabaseSnapshotsSummary', () => {
  const ok = (over: Partial<DatabaseSnapshotResult> = {}): DatabaseSnapshotResult => ({
    deploymentId: 'd1', deploymentName: 'maria', namespace: 'ns', engine: 'mariadb', serverVersion: '10.11.9',
    databaseDumps: [{ database: 'shop', snapshotId: 'abcdef12', sizeBytes: 10 }], databaseFailures: [], durationMs: 1, ...over,
  });

  it('ok with every database dumped, each with its snapshot and server version', () => {
    const s = buildDatabaseSnapshotsSummary([ok()]);
    expect(s.status).toBe('ok');
    expect(s.deployments[0]!.databases[0]).toEqual({ name: 'shop', status: 'dumped', sizeBytes: 10, snapshotId: 'abcdef12', serverVersion: '10.11.9' });
    expect(s.remediation).toBeNull();
  });

  it('degraded on a failed database or an instance that could not be backed up', () => {
    expect(buildDatabaseSnapshotsSummary([ok({ databaseFailures: [{ database: 'x', error: 'denied', benign: false }] })]).status).toBe('degraded');
    const s = buildDatabaseSnapshotsSummary([ok({ databaseDumps: [], error: 'not running' })]);
    expect(s.status).toBe('degraded');
    expect(s.deployments[0]!.databases).toEqual([{ name: '(deployment)', status: 'failed', sizeBytes: 0, error: 'not running' }]);
  });

  it('none with nothing at all; the SQLite entries fold in', () => {
    expect(buildDatabaseSnapshotsSummary([]).status).toBe('none');
    const s = buildDatabaseSnapshotsSummary([], [{ deploymentId: '', deploymentName: '(sqlite files)', engine: 'sqlite', databases: [{ name: 'a.db', status: 'dumped', sizeBytes: 1 }] }]);
    expect(s.status).toBe('ok');
  });
});

describe('snapshotInstanceDatabases', () => {
  const ctx = { kubeconfigPath: undefined, namespace: 'ns', podName: 'maria-abc-xyz', containerName: 'mariadb', engine: 'mariadb', rootPassword: 'x', rootUsername: 'root' };
  const deleted: string[] = [];
  const k8s = {
    core: {
      readNamespacedPod: vi.fn(async () => ({
        metadata: { labels: { app: 'maria' } },
        spec: { containers: [{ name: 'mariadb', image: 'mariadb:10.11' }] },
        status: { containerStatuses: [{ name: 'mariadb', imageID: `docker-pullable://mariadb@sha256:${'b'.repeat(64)}` }] },
      })),
      listNamespacedService: vi.fn(async () => ({ items: [{ metadata: { name: 'maria' }, spec: { selector: { app: 'maria' } } }] })),
      createNamespacedSecret: vi.fn(async () => ({})),
      patchNamespacedSecret: vi.fn(async () => ({})),
      deleteNamespacedSecret: vi.fn(async ({ name }: { name: string }) => { deleted.push(name); }),
    },
    batch: { createNamespacedJob: vi.fn(), readNamespacedJob: vi.fn() },
  };
  const args = {
    k8s: k8s as never, namespace: 'ns', tenantId: 't1', bundleId: 'bkp-0001', toolsImage: 'tools:1', tags: ['component=databases'],
    resticCreds: { restic_password: 'p', repo_uri: 's3:http://store.example.test/tenant/restic/t1' }, placement: {},
    withSlot: async <T,>(run: () => Promise<T>) => run(),
  };
  const inst = { deploymentId: 'd1', deploymentName: 'maria', catalogCode: 'mariadb', catalogRuntime: 'mariadb', configuration: {} };

  beforeEach(() => {
    vi.clearAllMocks();
    deleted.length = 0;
    mocks.buildDbContext.mockResolvedValue(ctx);
    mocks.listDatabases.mockResolvedValue([{ name: 'shop' }, { name: 'blog' }]);
    mocks.mintBackupLogin.mockResolvedValue({ username: 'platform_bk_1_abcdef', password: 'pw', serverVersion: '10.11.9' });
    mocks.dropBackupLogin.mockResolvedValue({ dropped: true });
  });

  const nonceOf = (): string => {
    const body = (k8s.batch.createNamespacedJob.mock.calls.at(-1) as unknown as [{ body: { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } } }])[0].body;
    return body.spec.template.spec.containers[0]!.env.find((e) => e.name === 'NONCE')!.value;
  };

  it('maps each database\'s line, hands the secrets to the Job, and always drops the login and both secrets', async () => {
    k8s.batch.createNamespacedJob.mockResolvedValue({ metadata: { uid: 'job-uid-1' } });
    k8s.batch.readNamespacedJob.mockResolvedValue({ status: { succeeded: 1 } });
    mocks.readJobLogTail.mockImplementation(async (_k: unknown, _n: unknown, _j: unknown, opts: { container?: string }) => {
      const n = nonceOf();
      expect(opts.container).toBe('dump');
      return `DB_DONE nonce=${n} index=0 snapshot=aaaaaaaa bytes=5 added=3\nDB_FAIL nonce=${n} index=1 rc=1 reason=Fatal: unable to open repository at s3:http://store.example.test/tenant/restic/t1\nDB_ALL_DONE nonce=${n}`;
    });
    const r = await snapshotInstanceDatabases(args, inst);
    expect(r.databaseDumps).toEqual([{ database: 'shop', snapshotId: 'aaaaaaaa', sizeBytes: 5, addedBytes: 3 }]);
    // The backup store's address never reaches a message.
    expect(r.databaseFailures).toEqual([{ database: 'blog', error: 'Fatal: unable to open repository at <backup store>', benign: false }]);
    expect(k8s.core.patchNamespacedSecret).toHaveBeenCalledTimes(2);
    expect(r.error).toBeUndefined();
    expect(mocks.dropBackupLogin).toHaveBeenCalledWith(expect.anything(), 'platform_bk_1_abcdef');
    expect(deleted).toHaveLength(2);
    const job = k8s.batch.createNamespacedJob.mock.calls[0]![0] as { body: { spec: { template: { spec: { containers: Array<{ image: string }> } } } } };
    // The pod's own image, by digest: the dump client is the server's version.
    expect(job.body.spec.template.spec.containers[0]!.image).toBe(`mariadb@sha256:${'b'.repeat(64)}`);
  });

  it('a Job that cannot be created fails the instance, and still drops the login', async () => {
    k8s.batch.createNamespacedJob.mockRejectedValue(new Error('exceeded quota'));
    const r = await snapshotInstanceDatabases(args, inst);
    expect(r.error).toBe('exceeded quota');
    // Minted only once a slot is held, right before the Job.
    expect(mocks.mintBackupLogin).toHaveBeenCalledTimes(1);
    expect(mocks.dropBackupLogin).toHaveBeenCalledTimes(1);
    expect(deleted).toHaveLength(2);
  });

  it('a login that will not drop is retried, then named in a warning (it can still read the databases)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.dropBackupLogin.mockResolvedValue({ dropped: false, error: 'command terminated: mariadb -uroot -phunter2 ERROR 2013: Lost connection' });
    const waits: number[] = [];
    const dropped = await dropRunLogin({} as never, 'platform_bk_1_abcdef', 'ns/maria', async (ms) => { waits.push(ms); });
    expect(dropped).toBe(false);
    expect(mocks.dropBackupLogin).toHaveBeenCalledTimes(DROP_LOGIN_BACKOFF_MS.length + 1);
    expect(waits).toEqual([...DROP_LOGIN_BACKOFF_MS]);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('platform_bk_1_abcdef on ns/maria could not be dropped');
    expect(line).toContain('7 h old');
    expect(line).not.toContain('hunter2');
    warn.mockRestore();
  });

  it('a login that drops on a retry is not reported', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.dropBackupLogin.mockResolvedValueOnce({ dropped: false, error: 'busy' }).mockResolvedValueOnce({ dropped: true });
    expect(await dropRunLogin({} as never, 'platform_bk_1_abcdef', 'ns/maria', async () => {})).toBe(true);
    expect(mocks.dropBackupLogin).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a database that is not running is reported, with no login minted', async () => {
    mocks.buildDbContext.mockRejectedValue(new Error('POD_NOT_FOUND'));
    const r = await snapshotInstanceDatabases(args, inst);
    expect(r.error).toMatch(/could not be reached: POD_NOT_FOUND/);
    expect(mocks.mintBackupLogin).not.toHaveBeenCalled();
  });

  it('an instance without databases needs no Job', async () => {
    mocks.listDatabases.mockResolvedValue([]);
    const r = await snapshotInstanceDatabases(args, inst);
    expect(r).toMatchObject({ databaseDumps: [], databaseFailures: [] });
    expect(k8s.batch.createNamespacedJob).not.toHaveBeenCalled();
  });
});
