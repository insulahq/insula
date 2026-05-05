/**
 * pg_dump orchestrator — runs inside the pg-dump-job pod.
 *
 * Pipeline:
 *   1. Resolve target backup_configurations row (S3 / SSH).
 *   2. Reserve a BackupStore bundle under synthetic clientId='__system__'
 *      so system artifacts live in a dedicated subtree.
 *   3. Spawn `pg_dump --format=custom --compress=9 --no-owner
 *      --no-privileges` against the CNPG `<cluster>-ro` read-replica
 *      service so the dump doesn't load the primary.
 *   4. Tee stdout: count bytes + sha256 while passing through to
 *      BackupStore.writeComponent (component='config').
 *   5. Persist bundleId + artifactName + sha256 + size_bytes on the
 *      system_backup_runs row; status='succeeded'.
 *
 * Errors update status='failed' + an OperatorError-shaped error_envelope
 * so the UI can render <ErrorPanel>.
 *
 * Reuses backups-v2's BackupStore interface + S3/SshBackupStore — does
 * NOT modify backups-v2 module code.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { systemBackupRuns, backupConfigurations } from '../../db/schema.js';
import { S3BackupStore } from '../backups-v2/s3-backup-store.js';
import { SshBackupStore } from '../backups-v2/ssh-backup-store.js';
import type { BackupStore } from '../backups-v2/bundle-store.js';
import { decrypt } from '../oidc/crypto.js';

export interface PgDumpInputs {
  readonly db: Database;
  readonly runId: string;
  readonly namespace: string;
  readonly cluster: string;
  readonly database: string;
  readonly targetConfigId: string;
  readonly oidcEncryptionKey: string | null;
}

export interface PgDumpResult {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly bundleId: string;
  readonly artifactName: string;
}

const SYSTEM_CLIENT_ID = '__system__';

async function resolveSystemStore(
  db: Database,
  targetConfigId: string,
  oidcEncryptionKey: string | null,
): Promise<{ store: BackupStore; targetType: 's3' | 'ssh' }> {
  const rows = await db
    .select()
    .from(backupConfigurations)
    .where(eq(backupConfigurations.id, targetConfigId))
    .limit(1);
  const cfg = rows[0];
  if (!cfg) throw new Error(`backup_configurations row ${targetConfigId} not found`);
  if (cfg.active === false) throw new Error(`backup_configurations row ${targetConfigId} is not active`);

  const decryptIfPresent = (s: string | null | undefined): string => {
    if (!s) return '';
    if (!oidcEncryptionKey) throw new Error('OIDC_ENCRYPTION_KEY required to decrypt backup target credentials');
    return decrypt(s, oidcEncryptionKey);
  };

  if (cfg.storageType === 's3') {
    const store = new S3BackupStore({
      endpoint: cfg.s3Endpoint ?? undefined,
      region: cfg.s3Region ?? 'us-east-1',
      bucket: cfg.s3Bucket ?? '',
      accessKeyId: decryptIfPresent(cfg.s3AccessKeyEncrypted),
      secretAccessKey: decryptIfPresent(cfg.s3SecretKeyEncrypted),
      pathPrefix: `${cfg.s3Prefix ?? ''}/system-backup`.replace(/^\/+/, ''),
    });
    return { store, targetType: 's3' };
  }
  if (cfg.storageType === 'ssh') {
    const store = new SshBackupStore({
      host: cfg.sshHost ?? '',
      port: cfg.sshPort ?? 22,
      user: cfg.sshUser ?? '',
      privateKey: decryptIfPresent(cfg.sshKeyEncrypted),
      basePath: `${cfg.sshPath ?? '/backups'}/system-backup`,
    });
    return { store, targetType: 'ssh' };
  }
  throw new Error(`backup_configurations.storage_type=${cfg.storageType} not supported`);
}

function spawnPgDump(
  namespace: string,
  cluster: string,
  database: string,
): { stdout: Readable; stderr: Readable; done: Promise<void> } {
  const host = `${cluster}-ro.${namespace}.svc`;
  const args = [
    '-h', host,
    '-p', '5432',
    '-d', database,
    '--format=custom',
    '--compress=9',
    '--no-owner',
    '--no-privileges',
  ];
  const proc = spawn('pg_dump', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exit ${code}`));
    });
  });
  return { stdout: proc.stdout, stderr: proc.stderr, done };
}

export async function runPgDump(inputs: PgDumpInputs): Promise<PgDumpResult> {
  const { db, runId, namespace, cluster, database, targetConfigId, oidcEncryptionKey } = inputs;

  await db.update(systemBackupRuns)
    .set({ status: 'running', jobName: process.env.HOSTNAME ?? null })
    .where(eq(systemBackupRuns.id, runId));

  try {
    const { store } = await resolveSystemStore(db, targetConfigId, oidcEncryptionKey);
    const handle = await store.reserveBundle({ backupId: runId, clientId: SYSTEM_CLIENT_ID });

    const { stdout, stderr, done } = spawnPgDump(namespace, cluster, database);
    const stderrChunks: Buffer[] = [];
    stderr.on('data', (c: Buffer) => stderrChunks.push(c));

    const hasher = createHash('sha256');
    let sizeBytes = 0;
    const passthrough = new PassThrough();
    stdout.on('data', (c: Buffer) => {
      hasher.update(c);
      sizeBytes += c.length;
      passthrough.write(c);
    });
    stdout.on('end', () => passthrough.end());
    stdout.on('error', (err) => passthrough.destroy(err));

    const artifactName = `${cluster}.${database}.pgdump`;
    const writePromise = store.writeComponent(handle, 'config', artifactName, passthrough, {
      contentType: 'application/octet-stream',
    });

    try {
      await Promise.all([done, writePromise]);
    } catch (err) {
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').slice(0, 2000);
      const e = err as Error;
      throw new Error(`pg_dump pipeline failed: ${e.message}; stderr: ${stderrText}`);
    }

    const sha256 = hasher.digest('hex');

    await db.update(systemBackupRuns)
      .set({
        status: 'succeeded',
        finishedAt: new Date(),
        sizeBytes,
        sha256,
        bundleId: handle.bundleId,
        artifactName,
      })
      .where(eq(systemBackupRuns.id, runId));

    return { sizeBytes, sha256, bundleId: handle.bundleId, artifactName };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.update(systemBackupRuns)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorEnvelope: { code: 'SYSTEM_BACKUP_PG_DUMP_FAILED', message: msg } as unknown as Record<string, unknown>,
      })
      .where(eq(systemBackupRuns.id, runId));
    throw err;
  }
}
