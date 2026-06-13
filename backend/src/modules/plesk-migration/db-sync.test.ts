import { describe, it, expect } from 'vitest';
import { isValidDbName, mysqlDatabasesOf, parseDbResults, buildDbSyncJob } from './db-sync.js';
import type { PleskSubscription } from '@insula/api-contracts';

function sub(databases: PleskSubscription['databases']): PleskSubscription {
  return { name: 'acme.example', sysUser: 'acme', cronCount: 0, cronLines: [], mailBytes: 0, domains: [], databases, mailboxes: [] };
}

describe('isValidDbName', () => {
  it('accepts normal MySQL identifiers', () => {
    expect(isValidDbName('wp_acme')).toBe(true);
    expect(isValidDbName('acme-db_2')).toBe(true);
  });
  it('rejects names with shell/SQL metacharacters (injection guard)', () => {
    expect(isValidDbName("wp; DROP")).toBe(false);
    expect(isValidDbName('a b')).toBe(false);
    expect(isValidDbName("'x'")).toBe(false);
    expect(isValidDbName('')).toBe(false);
  });
});

describe('mysqlDatabasesOf', () => {
  it('keeps only MySQL/MariaDB databases (PostgreSQL is out of scope here)', () => {
    const names = mysqlDatabasesOf(sub([
      { name: 'wp_a', type: 'mysql', sizeBytes: 1000 },
      { name: 'shop_b', type: 'mariadb', sizeBytes: 2000 },
      { name: 'pg_c', type: 'postgresql', sizeBytes: 3000 },
    ]));
    expect(names.sort()).toEqual(['shop_b', 'wp_a']);
  });
  it('defaults a null/absent type to mysql (Plesk default)', () => {
    expect(mysqlDatabasesOf(sub([{ name: 'd1', type: null as unknown as string, sizeBytes: null }]))).toEqual(['d1']);
  });
});

describe('parseDbResults', () => {
  it('parses ok/fail DBRESULT lines between the sentinels', () => {
    const log = [
      'noise before',
      '===DBSYNC-BEGIN===',
      'DBRESULT wp_a ok imported',
      'DBRESULT shop_b fail mysqldump: access denied',
      '===DBSYNC-END===',
      'noise after',
    ].join('\n');
    const r = parseDbResults(log);
    expect(r.get('wp_a')).toEqual({ ok: true, message: 'imported' });
    expect(r.get('shop_b')).toEqual({ ok: false, message: 'mysqldump: access denied' });
    expect(r.size).toBe(2);
  });
  it('returns an empty map when there are no result lines', () => {
    expect(parseDbResults('FATAL: cannot ssh').size).toBe(0);
  });

  it('still parses results when the END sentinel is missing (job OOM-killed mid-output)', () => {
    // No ===DBSYNC-END=== — the slice must run to the end of the log, not drop
    // the already-emitted results.
    const log = '===DBSYNC-BEGIN===\nDBRESULT wp_a ok imported\nDBRESULT wp_b ok imported';
    const r = parseDbResults(log);
    expect(r.size).toBe(2);
    expect(r.get('wp_a')?.ok).toBe(true);
  });
});

describe('buildDbSyncJob (hardening)', () => {
  const source = {
    id: 'src12345', name: 's', hostname: 'plesk.example.test', sshPort: 2222, sshUser: 'root',
    sshKeyEncrypted: 'x', pleskVersion: null, passwordStorage: null, lastDiscoveredAt: null,
    status: 'discovered', createdBy: null, createdAt: new Date(),
  } as Parameters<typeof buildDbSyncJob>[0]['source'];

  it('is hardened and passes the db list + host via env', () => {
    const job = buildDbSyncJob({ jobName: 'j', secretName: 'sec', namespace: 'tenant-x', source, dbHost: 'plesk-databases.tenant-x.svc.cluster.local', dbNames: ['wp_a', 'shop_b'] }) as any;
    const c = job.spec.template.spec.containers[0];
    expect(c.securityContext).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    expect(job.spec.template.spec.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 65534 });
    const env = Object.fromEntries(c.env.map((e: { name: string; value: string }) => [e.name, e.value]));
    expect(env.DB_HOST).toBe('plesk-databases.tenant-x.svc.cluster.local');
    expect(env.DB_NAMES).toBe('wp_a shop_b');
    expect(env.PLESK_HOST).toBe('plesk.example.test');
    expect(job.spec.backoffLimit).toBe(0); // never retry a partial import
  });
});
