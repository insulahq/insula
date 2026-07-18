/**
 * RcloneBackupStore — READ-ONLY bundle store backed by the `rclone` CLI.
 *
 * Purpose: read a FOREIGN backup target of ANY type (S3 / SFTP / CIFS-SMB)
 * during cross-cluster MIGRATION + DR-recover, where the shared
 * backup-rclone-shim can't help — the shim is scoped to THIS cluster's
 * `system/tenant/mail` class bindings, and a migration source is a foreign
 * target the operator adds by targetConfigId. The native S3BackupStore /
 * SshBackupStore cover s3+ssh but have no SMB client; rclone does, so this
 * store closes the CIFS gap using the exact same rclone engine the shim runs.
 *
 * It is deliberately read-only: migration/DR only enumerate + read bundles
 * from the source. Write methods throw.
 *
 * Config is passed as `RCLONE_CONFIG_<REMOTE>_<KEY>` env vars (never a file
 * on disk) — rclone reads a remote's config straight from the environment.
 * The env is built by the caller from the shim's own `renderUpstreamSection`
 * (obscured passwords included), so this store stays target-agnostic.
 *
 * Bundle layout (same as every other store):
 *   <basePath>/<bundleId>/meta.json
 *   <basePath>/<bundleId>/components/<component>/<name>
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable } from 'node:stream';
import type { BackupComponentName, BackupMetaV1 } from '@insula/api-contracts';
import type { BackupStore, BundleHandle, ArtifactRef, ArtifactStat } from './bundle-store.js';
import { META_FILENAME, componentDir, parseMeta } from './meta.js';

export interface RcloneBackupStoreConfig {
  /** RCLONE_CONFIG_<REMOTE>_* env vars defining the single source remote. */
  readonly rcloneEnv: Record<string, string>;
  /** The remote name used in `<remote>:<path>` addressing (matches rcloneEnv). */
  readonly remoteName: string;
  /** Path within the remote where the tenant bundles live (e.g. `share/dir/tenant`). */
  readonly basePath: string;
  readonly logFn?: (level: 'info' | 'warn' | 'error', ctx: Record<string, unknown>, msg: string) => void;
}

type RcloneSpawn = (args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;

let spawnImpl: RcloneSpawn | null = null;
/** Test seam — inject a fake rclone process. */
export function __setRcloneSpawnForTest(impl: RcloneSpawn): void { spawnImpl = impl; }
export function __resetRcloneSpawnForTest(): void { spawnImpl = null; }

function isNotFound(stderr: string): boolean {
  return /directory not found|not found|does not exist|error 3|couldn't list/i.test(stderr);
}

const RCLONE_ARGS = ['--config', '/dev/null', '--no-check-dest', '--low-level-retries', '3', '--retries', '2'];

export class RcloneBackupStore implements BackupStore {
  readonly kind = 'rclone' as const;

  constructor(private readonly config: RcloneBackupStoreConfig) {}

  private addr(sub: string): string {
    const path = [this.config.basePath.replace(/^\/+|\/+$/g, ''), sub].filter((s) => s.length > 0).join('/');
    return `${this.config.remoteName}:${path}`;
  }

  private spawnRclone(args: readonly string[]): ChildProcessWithoutNullStreams {
    const env = { ...process.env, ...this.config.rcloneEnv } as NodeJS.ProcessEnv;
    if (spawnImpl) return spawnImpl(args, env);
    return spawn('rclone', [...RCLONE_ARGS, ...args], { env }) as ChildProcessWithoutNullStreams;
  }

  private async run(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = this.spawnRclone(args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    const code = await new Promise<number>((resolve) => {
      const done = (c: number | null) => resolve(c ?? 0);
      child.on('exit', done);
      child.on('close', done);
      child.on('error', () => resolve(127));
    });
    return { code, stdout, stderr };
  }

  async listBundleIds(): Promise<string[]> {
    // `rclone lsf --dirs-only` prints one `<bundleId>/` per line. A missing
    // base dir (fresh/empty source) is NOT an error here — return [].
    const { code, stdout, stderr } = await this.run(['lsf', '--dirs-only', this.addr('')]);
    if (code !== 0) {
      if (isNotFound(stderr)) return [];
      throw new Error(`rclone lsf failed (${code}): ${stderr.trim()}`);
    }
    return stdout.split('\n').map((l) => l.replace(/\/+$/, '').trim()).filter((l) => l.length > 0);
  }

  async open(backupId: string): Promise<BundleHandle | null> {
    // Opaque handle — getMeta()/readComponent() validate existence lazily.
    return { bundleId: backupId, _backend: {} };
  }

  async getMeta(handle: BundleHandle): Promise<BackupMetaV1> {
    const { code, stdout, stderr } = await this.run(['cat', this.addr(`${handle.bundleId}/${META_FILENAME}`)]);
    if (code !== 0) throw new Error(`rclone cat meta.json failed (${code}): ${stderr.trim()}`);
    if (!stdout) throw new Error('RcloneBackupStore: empty meta.json');
    return parseMeta(stdout);
  }

  async readComponent(handle: BundleHandle, component: BackupComponentName, name: string): Promise<Readable> {
    const child = this.spawnRclone(['cat', this.addr(`${handle.bundleId}/${componentDir(component)}/${name}`)]);
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    // Surface a non-zero exit as a stream error so the consumer fails loudly
    // instead of silently getting a truncated body.
    child.on('close', (code) => {
      if (code && code !== 0 && !child.stdout.destroyed) {
        child.stdout.destroy(new Error(`rclone cat ${name} failed (${code}): ${stderr.trim()}`));
      }
    });
    child.on('error', (err) => { if (!child.stdout.destroyed) child.stdout.destroy(err); });
    return child.stdout;
  }

  async listArtifacts(handle: BundleHandle, component: BackupComponentName): Promise<ArtifactRef[]> {
    const { code, stdout, stderr } = await this.run(['lsjson', this.addr(`${handle.bundleId}/${componentDir(component)}`)]);
    if (code !== 0) {
      if (isNotFound(stderr)) return [];
      throw new Error(`rclone lsjson failed (${code}): ${stderr.trim()}`);
    }
    let entries: Array<{ Name?: string; Size?: number; IsDir?: boolean }>;
    try { entries = JSON.parse(stdout || '[]'); } catch { return []; }
    return entries
      .filter((e) => e && !e.IsDir && typeof e.Name === 'string')
      .map((e) => ({ component, name: e.Name as string, sizeBytes: Number(e.Size ?? 0) }));
  }

  async stat(handle: BundleHandle, component: BackupComponentName, name: string): Promise<ArtifactStat | null> {
    const refs = await this.listArtifacts(handle, component);
    const hit = refs.find((r) => r.name === name);
    return hit ? { sizeBytes: hit.sizeBytes, sha256: null } : null;
  }

  // ── Read-only source: writes are unsupported ────────────────────────────
  private readOnly(op: string): never {
    throw new Error(`RcloneBackupStore is read-only (migration/DR source); ${op} is not supported`);
  }
  async reserveBundle(): Promise<BundleHandle> { return this.readOnly('reserveBundle'); }
  async writeComponent(): Promise<ArtifactRef> { return this.readOnly('writeComponent'); }
  async putMeta(): Promise<void> { return this.readOnly('putMeta'); }
  async delete(): Promise<void> { return this.readOnly('delete'); }
}
