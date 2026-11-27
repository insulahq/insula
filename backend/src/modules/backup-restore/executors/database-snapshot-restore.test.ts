import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDatabase: vi.fn(),
  dropDatabase: vi.fn(),
  listDatabases: vi.fn(),
  readServerVersion: vi.fn(),
  trustRoutineCreators: vi.fn(),
  readJobLogTail: vi.fn(),
  sh: vi.fn(),
}));
vi.mock('../../deployments/db-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../deployments/db-manager.js')>()),
  createDatabase: mocks.createDatabase,
  dropDatabase: mocks.dropDatabase,
  listDatabases: mocks.listDatabases,
}));
vi.mock('../../deployments/db-exec.js', async (orig) => ({
  ...(await orig<typeof import('../../deployments/db-exec.js')>()),
  sh: mocks.sh,
}));
vi.mock('../../deployments/backup-login.js', async (orig) => ({
  ...(await orig<typeof import('../../deployments/backup-login.js')>()),
  readServerVersion: mocks.readServerVersion,
}));
vi.mock('../../deployments/tenant-admin.js', () => ({ trustRoutineCreators: mocks.trustRoutineCreators }));
vi.mock('../../storage-lifecycle/job-log-tail.js', () => ({ readJobLogTail: mocks.readJobLogTail, tailJobLog: vi.fn(async () => '') }));

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PG_TOC_FILTER_AWK,
  buildDatabaseFetchScript,
  buildDatabaseRestoreJobSpec,
  buildDatabaseRestoreScript,
  defaultCopyName,
  parseDatabaseRestoreLines,
  restoreInstanceFromSnapshots,
} from './database-snapshot-restore.js';

describe('defaultCopyName', () => {
  const at = new Date(Date.UTC(2026, 10, 26, 9, 5));
  it('appends the time, from the allowed characters only', () => {
    expect(defaultCopyName('shop', at)).toBe('shop_restored_20261126090500');
    expect(defaultCopyName('we;ird db', at)).toBe('we_ird_db_restored_20261126090500');
    expect(defaultCopyName('2024', at)).toBe('db_2024_restored_20261126090500');
  });
  it('stays within PostgreSQL\'s 63 bytes', () => {
    const n = defaultCopyName('x'.repeat(64), at);
    expect(n.length).toBeLessThanOrEqual(63);
    expect(n).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
  });
});

describe('buildDatabaseRestoreScript', () => {
  it.each(['mariadb', 'mysql', 'postgresql', 'mongodb'] as const)('%s: valid POSIX sh that reads every value by variable name, and no restic', (engine) => {
    const script = buildDatabaseRestoreScript(engine);
    const check = spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' });
    expect(check.status, check.stderr).toBe(0);
    expect(script).toContain('eval "target=\\${TARGET_$i}; conn=\\${CONN_$i}; src=\\${SRC_$i}; fd=\\${FD_$i}; fl=\\${FL_$i:-}; evtf=\\${EVTF_$i:-}"');
    // The client side never holds the store's credentials.
    expect(script).not.toMatch(/restic|RESTIC_|AWS_/);
    expect(script).not.toMatch(/\becho\b/);
  });

  it('the fetch side: valid POSIX sh, one dump per pipe, and it waits to be stopped', () => {
    const script = buildDatabaseFetchScript();
    const check = spawnSync('sh', ['-n', '-c', script], { encoding: 'utf8' });
    expect(check.status, check.stderr).toBe(0);
    expect(script).toContain('restic dump --no-cache "$snap" "/$file" > $P/$i.fifo');
    expect(script).toContain('idle() { while :; do sleep 3600 & wait $!; done; }');
    // Stops when asked; started again after dying, it reports rather than idles.
    expect(script).toContain("trap 'exit 0' TERM");
    expect(script).toContain('fail "the backup reader stopped part-way (restarted)"');
  });

  it('the restore side never waits on a pipe the fetch will not write', () => {
    const script = buildDatabaseRestoreScript('postgresql');
    expect(script).toContain('if [ -e $Q/fetch-failed ]; then why=$(cat $Q/fetch-failed)');
    expect(script).toContain(': > $Q/$1.fifo; exit 0');
    // A table of contents that cannot be read: its dump pass is called off, not left waiting.
    expect(script).toContain('touch $Q/$fd.skip');
  });
  it('MariaDB/MySQL: the tenant import rewrite; PostgreSQL: one transaction', () => {
    expect(buildDatabaseRestoreScript('mariadb')).toContain('sed -E "$IMPORT_SED"');
    expect(buildDatabaseRestoreScript('postgresql')).toContain('pg_restore -L /tmp/use $OWNER_OPT --clean --if-exists --single-transaction --exit-on-error -d "$conn"');
    expect(buildDatabaseRestoreScript('postgresql')).toContain('pg_restore -l < $Q/$fl.fifo > /tmp/toc');
    expect(buildDatabaseRestoreScript('mongodb')).toContain('--nsFrom="$src.*" --nsTo="$target.*"');
  });
});

describe('PG_TOC_FILTER_AWK', () => {
  const TOC = [
    ';',
    '; Archive created at 2026-11-27',
    '2; 3079 16386 EXTENSION - pgcrypto ',
    '3482; 0 0 COMMENT - EXTENSION pgcrypto ',
    '258; 1255 16424 FUNCTION public evf() dbadmin',
    '259; 1255 16425 FUNCTION public keep(integer, text) app',
    '220; 1259 16426 TABLE public t app',
    '221; 1259 16427 TABLE public su_table postgres',
    '3475; 0 16426 TABLE DATA public t app',
    '3327; 3466 16425 EVENT TRIGGER - evt postgres',
  ].join('\n');
  const run = (mode: string, evtf = ''): { kept: string[]; skipped: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'toc-'));
    try {
      // The program reads its fixed paths: run it with /tmp mapped to the scratch dir.
      const prog = PG_TOC_FILTER_AWK.replaceAll('/tmp/', `${dir}/`);
      writeFileSync(join(dir, 'evtf'), evtf);
      const r = spawnSync('awk', ['-v', 'su=postgres', '-v', `mode=${mode}`, prog], { input: TOC, encoding: 'utf8' });
      return { kept: r.stdout.split('\n').filter((l) => l && !l.startsWith(';')), skipped: readFileSync(join(dir, 'skipped'), 'utf8').trim() };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it('a copy or test leaves out only the event trigger', () => {
    const r = run('copy');
    expect(r.skipped).toBe('1');
    expect(r.kept.some((l) => l.includes('EVENT TRIGGER'))).toBe(false);
    expect(r.kept.some((l) => l.includes('EXTENSION - pgcrypto'))).toBe(true);
  });
  it('in place also leaves extensions, what the superuser owns and the event trigger\'s function', () => {
    const r = run('replace', 'public evf()\n');
    expect(r.kept).toEqual([
      '259; 1255 16425 FUNCTION public keep(integer, text) app',
      '220; 1259 16426 TABLE public t app',
      '3475; 0 16426 TABLE DATA public t app',
    ]);
    expect(r.skipped).toBe('5');
  });
});

describe('parseDatabaseRestoreLines', () => {
  it('restored, failed, setup — only with the run\'s nonce', () => {
    const N = 'aabbccddeeff0011';
    const p = parseDatabaseRestoreLines([
      `DB_RESTORED nonce=${N} index=0 objects=4 skipped=0`, `DB_RESTORED nonce=${N} index=1 objects=- skipped=2`,
      `DB_RESTORE_FAIL nonce=${N} index=2 rc=1/0 reason=ERROR 1419`, `DB_SETUP_FAILED nonce=${N} no pg_restore`,
      'DB_RESTORED nonce=0000000000000000 index=3 objects=1 skipped=0', `DB_RESTORED nonce=${N} index=2 objects=9 skipped=0`,
    ].join('\n'), N);
    expect(p.results.has(3)).toBe(false);
    expect(p.results.get(0)).toEqual({ kind: 'restored', objects: 4, skipped: 0 });
    expect(p.results.get(1)).toEqual({ kind: 'restored', objects: null, skipped: 2 });
    expect(p.results.get(2)).toEqual({ kind: 'failed', error: 'ERROR 1419' });
    expect(p.setupFailed).toBe('no pg_restore');
  });
});

describe('buildDatabaseRestoreJobSpec', () => {
  const base = {
    jobName: 'rs', namespace: 'ns', tenantId: 't', restoreId: 'r', deploymentId: 'd', engine: 'postgresql' as const, image: 'pg', toolsImage: 'tools',
    serviceHost: 'pg.ns.svc', servicePort: 5432, credsSecretName: 'c', loginSecretName: 'l',
    items: [{ snapshotId: 'aaaaaaaa', fileName: '73686f70.pgdump', target: 'we"ird', source: 'shop' }],
    nonce: 'aabbccddeeff0011', placement: { priorityClassName: 'platform-tenant-overhead' }, superuser: 'postgres',
  };
  it('PostgreSQL: each dump is fetched twice, its table of contents first', () => {
    const pod = (buildDatabaseRestoreJobSpec({ ...base, mode: 'replace', items: [...base.items, { ...base.items[0]!, target: 'b', source: 'b', eventTriggerFunctions: ['public evf()'] }] }) as Spec).spec.template.spec;
    const fetch = Object.fromEntries(pod.initContainers[0].env.map((e: { name: string; value: string }) => [e.name, e.value]));
    const restore = Object.fromEntries(pod.containers[0].env.map((e: { name: string; value: string }) => [e.name, e.value]));
    expect(fetch.COUNT).toBe('4');
    expect(restore).toMatchObject({ COUNT: '2', FL_0: '0', FD_0: '1', FL_1: '2', FD_1: '3', EVTF_1: 'public evf()', MODE: 'replace', SUPERUSER: 'postgres' });
  });
  type Spec = { metadata: { labels: Record<string, string> }; spec: { template: { spec: Record<string, any> } } };
  const env = (mode: 'replace' | 'copy' | 'test') => {
    const spec = buildDatabaseRestoreJobSpec({ ...base, mode }) as Spec;
    return { labels: spec.metadata.labels, env: Object.fromEntries(spec.spec.template.spec.containers[0]!.env.map((e: { name: string; value: string }) => [e.name, e.value])) };
  };
  it('the store\'s credentials go to the fetch sidecar only, the login to the restore side only', () => {
    const pod = (buildDatabaseRestoreJobSpec({ ...base, mode: 'copy' }) as Spec).spec.template.spec;
    const mounts = (c: { volumeMounts: Array<{ name: string }> }) => c.volumeMounts.map((m) => m.name);
    expect(pod.initContainers[0]).toMatchObject({ name: 'fetch', restartPolicy: 'Always' });
    expect(mounts(pod.initContainers[0])).toContain('restic-creds');
    expect(mounts(pod.initContainers[0])).not.toContain('db-login');
    expect(mounts(pod.containers[0])).toEqual(['pipe', 'tmp', 'db-login']);
    expect(pod.containers[0].env.map((e: { name: string }) => e.name)).not.toContain('SNAP_0');
    expect(pod.priorityClassName).toBe('platform-tenant-overhead');
  });
  it('in place keeps owners; a copy or test belongs to the administrator', () => {
    expect(env('replace').env.OWNER_OPT).toBe('');
    expect(env('copy').env.OWNER_OPT).toBe('--no-owner');
    expect(env('test').env.OWNER_OPT).toBe('--no-owner');
  });
  it('a PostgreSQL target goes as a quoted conninfo, never a bare name (one holding = would be parsed as one)', () => {
    expect(env('copy').env.CONN_0).toBe("dbname='we\"ird'");
    expect(env('copy').labels['platform.io/component']).toBe('restore-files');
  });
});

describe('restoreInstanceFromSnapshots', () => {
  const ctx = (engine: string) => ({ kubeconfigPath: undefined, namespace: 'ns', podName: 'db-abc-xyz', containerName: 'db', engine, rootPassword: 'x', rootUsername: 'root' });
  const k8s = {
    core: {
      readNamespacedPod: vi.fn(async () => ({ metadata: { labels: { app: 'db' } }, spec: { containers: [{ name: 'db', image: 'img:1' }] }, status: {} })),
      listNamespacedService: vi.fn(async () => ({ items: [{ metadata: { name: 'db' }, spec: { selector: { app: 'db' } } }] })),
      createNamespacedSecret: vi.fn(async () => ({})),
      patchNamespacedSecret: vi.fn(async () => ({})),
      deleteNamespacedSecret: vi.fn(async () => ({})),
    },
    batch: { createNamespacedJob: vi.fn(async () => ({ metadata: { uid: 'u1' } })), readNamespacedJob: vi.fn(async () => ({ status: { succeeded: 1 } })) },
  };
  const args = (engine: string, mode: 'replace' | 'copy' | 'test', requests: Array<{ source: string; snapshotId: string; serverVersion?: string; targetName?: string }>) => ({
    k8s: k8s as never, ctx: ctx(engine) as never, namespace: 'ns', tenantId: 't', restoreId: 'rst-1', deploymentId: 'd1', mode, requests,
    login: { username: 'dbadmin', password: 'pw' }, toolsImage: 'tools', resticCreds: { restic_password: 'p', repo_uri: 'r' }, placement: {},
  });
  const jobEnv = (): Record<string, string> => {
    const body = (k8s.batch.createNamespacedJob.mock.calls.at(-1) as unknown as [{ body: { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }>; initContainers: Array<{ env: Array<{ name: string; value: string }> }> } } } } }])[0].body;
    const pod = body.spec.template.spec;
    return Object.fromEntries([...pod.initContainers[0]!.env, ...pod.containers[0]!.env].map((e) => [e.name, e.value]));
  };
  /** The Job's restore-side log, with the run's nonce. */
  const logs = (...lines: string[]) => mocks.readJobLogTail.mockImplementation(async () => lines.map((l) => l.replace('NONCE', jobEnv().NONCE!)).join('\n'));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readServerVersion.mockResolvedValue('10.11.9-MariaDB');
    mocks.listDatabases.mockResolvedValue([{ name: 'shop' }]);
    mocks.trustRoutineCreators.mockResolvedValue([]);
    mocks.createDatabase.mockResolvedValue(undefined);
    mocks.dropDatabase.mockResolvedValue(undefined);
    mocks.sh.mockResolvedValue('');
  });

  it('refuses a backup from a newer server without touching anything', async () => {
    const r = await restoreInstanceFromSnapshots(args('mariadb', 'replace', [{ source: 'shop', snapshotId: 'aaaaaaaa', serverVersion: '11.4.3-MariaDB' }]));
    expect(r.failed[0]!.error).toMatch(/newer than this server/);
    expect(k8s.batch.createNamespacedJob).not.toHaveBeenCalled();
  });

  it('in place: into the same name; routines allowed first on MariaDB/MySQL', async () => {
    logs('DB_RESTORED nonce=NONCE index=0 objects=3 skipped=0');
    const r = await restoreInstanceFromSnapshots(args('mariadb', 'replace', [{ source: 'shop', snapshotId: 'aaaaaaaa' }]));
    expect(r.restored).toEqual([{ source: 'shop', target: 'shop', objects: 3, skipped: 0 }]);
    expect(jobEnv()).toMatchObject({ TARGET_0: 'shop', SRC_0: 'shop', SNAP_0: 'aaaaaaaa', FILE_0: '73686f70.sql', COUNT: '1' });
    expect(mocks.trustRoutineCreators).toHaveBeenCalled();
    expect(mocks.createDatabase).not.toHaveBeenCalled();
  });

  it('copy: refuses a name that exists, creates the new one, and drops it again if the restore failed', async () => {
    const taken = await restoreInstanceFromSnapshots(args('mariadb', 'copy', [{ source: 'shop', snapshotId: 'aaaaaaaa', targetName: 'shop' }]));
    expect(taken.failed[0]!.error).toMatch(/exists already/);
    logs('DB_RESTORE_FAIL nonce=NONCE index=0 rc=1/0 reason=ERROR 1064');
    const r = await restoreInstanceFromSnapshots(args('mariadb', 'copy', [{ source: 'shop', snapshotId: 'aaaaaaaa', targetName: 'shop_old' }]));
    expect(mocks.createDatabase).toHaveBeenCalledWith(expect.anything(), 'shop_old');
    expect(r.failed).toEqual([{ database: 'shop', error: 'ERROR 1064' }]);
    expect(mocks.dropDatabase).toHaveBeenCalledWith(expect.anything(), 'shop_old');
  });

  it('PostgreSQL copy: the new database goes to the tenant administrator', async () => {
    mocks.readServerVersion.mockResolvedValue('17.6');
    logs('DB_RESTORED nonce=NONCE index=0 objects=2 skipped=0');
    await restoreInstanceFromSnapshots(args('postgresql', 'copy', [{ source: 'shop', snapshotId: 'aaaaaaaa', targetName: 'shop_copy' }]));
    const statements = mocks.sh.mock.calls.map((c) => JSON.stringify(c[1]));
    expect(statements.some((s) => s.includes('ALTER DATABASE \\"shop_copy\\" OWNER TO \\"dbadmin\\"'))).toBe(true);
  });

  it('test: a scratch database, always dropped, the original untouched', async () => {
    logs('DB_RESTORED nonce=NONCE index=0 objects=7 skipped=0');
    const r = await restoreInstanceFromSnapshots(args('mariadb', 'test', [{ source: 'shop', snapshotId: 'aaaaaaaa' }]));
    const target = jobEnv().TARGET_0!;
    expect(target).toMatch(/^restoretest_[0-9a-f]{8}$/);
    expect(r.restored).toEqual([{ source: 'shop', target, objects: 7, skipped: 0 }]);
    expect(mocks.dropDatabase).toHaveBeenCalledWith(expect.anything(), target);
    expect(mocks.dropDatabase).not.toHaveBeenCalledWith(expect.anything(), 'shop');
  });

  it('never restores into one of the server\'s own databases, on any engine', async () => {
    mocks.readServerVersion.mockResolvedValue('7.0.12');
    const r = await restoreInstanceFromSnapshots(args('mongodb', 'copy', [{ source: 'shop', snapshotId: 'aaaaaaaa', targetName: 'admin' }]));
    expect(r.failed[0]!.error).toMatch(/one of the server's own databases/);
    expect(k8s.batch.createNamespacedJob).not.toHaveBeenCalled();
  });

  it('MongoDB: two databases in one restore never land in one target', async () => {
    mocks.readServerVersion.mockResolvedValue('7.0.12');
    mocks.listDatabases.mockResolvedValue([{ name: 'shop' }, { name: 'orders' }]);
    logs('DB_RESTORED nonce=NONCE index=0 objects=2 skipped=0');
    // `orders` asks for the name `shop` gets by default (`shop_restored_<time>`), in a different case.
    const shopDefault = defaultCopyName('shop');
    const r = await restoreInstanceFromSnapshots(args('mongodb', 'copy', [
      { source: 'shop', snapshotId: 'aaaaaaaa' },
      { source: 'orders', snapshotId: 'bbbbbbbb', targetName: shopDefault.toUpperCase() },
    ]));
    expect(r.failed).toEqual([{ database: 'orders', error: `another database in this restore goes to ${shopDefault.toUpperCase()}: choose another name` }]);
    expect(jobEnv()).toMatchObject({ COUNT: '1', SRC_0: 'shop' });
  });

  it('SQL engines tell target names apart by case', async () => {
    logs('DB_RESTORED nonce=NONCE index=0 objects=1 skipped=0', 'DB_RESTORED nonce=NONCE index=1 objects=1 skipped=0');
    mocks.listDatabases.mockResolvedValue([{ name: 'shop' }, { name: 'Shop' }]);
    const r = await restoreInstanceFromSnapshots(args('mariadb', 'copy', [
      { source: 'shop', snapshotId: 'aaaaaaaa', targetName: 'app' },
      { source: 'Shop', snapshotId: 'bbbbbbbb', targetName: 'App' },
    ]));
    expect(r.failed).toEqual([]);
    expect(jobEnv()).toMatchObject({ COUNT: '2', TARGET_0: 'app', TARGET_1: 'App' });
  });

  it('MongoDB: a failed copy into a new name is dropped again', async () => {
    mocks.readServerVersion.mockResolvedValue('7.0.12');
    logs('DB_RESTORE_FAIL nonce=NONCE index=0 rc=1/0 reason=Failed: E11000');
    await restoreInstanceFromSnapshots(args('mongodb', 'copy', [{ source: 'shop', snapshotId: 'aaaaaaaa', targetName: 'shop_old' }]));
    expect(mocks.dropDatabase).toHaveBeenCalledWith(expect.anything(), 'shop_old');
  });

  it('PostgreSQL: a database made but not handed over is dropped again', async () => {
    mocks.readServerVersion.mockResolvedValue('17.6');
    mocks.sh.mockRejectedValue(new Error('permission denied'));
    const r = await restoreInstanceFromSnapshots(args('postgresql', 'copy', [{ source: 'shop', snapshotId: 'aaaaaaaa', targetName: 'shop_copy' }]));
    expect(mocks.dropDatabase).toHaveBeenCalledWith(expect.anything(), 'shop_copy');
    expect(r.failed[0]!.error).toMatch(/could not be created: permission denied/);
  });

  it('a scratch database that cannot be dropped is reported', async () => {
    logs('DB_RESTORED nonce=NONCE index=0 objects=1 skipped=0');
    mocks.dropDatabase.mockRejectedValue(new Error('in use'));
    const r = await restoreInstanceFromSnapshots(args('mariadb', 'test', [{ source: 'shop', snapshotId: 'aaaaaaaa' }]));
    expect(r.failed[0]!.error).toMatch(/scratch database restoretest_[0-9a-f]{8} could not be dropped \(in use\): drop it by hand/);
  });

  it('in place, a database that is gone and cannot be made again is skipped', async () => {
    mocks.listDatabases.mockResolvedValue([]);
    mocks.createDatabase.mockRejectedValue(new Error('INVALID_IDENTIFIER'));
    const r = await restoreInstanceFromSnapshots(args('mariadb', 'replace', [{ source: 'we;ird', snapshotId: 'aaaaaaaa' }]));
    expect(r.skipped[0]).toMatch(/is gone and could not be created again/);
    expect(k8s.batch.createNamespacedJob).not.toHaveBeenCalled();
  });
});
