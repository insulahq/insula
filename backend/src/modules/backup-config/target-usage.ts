/**
 * How much each backup target holds, per class, and how much room it has left.
 *
 * Nothing measured this before. The panel showed per-class sizes taken from
 * restic's own accounting (tenant repos, the mail repo) and an hourly LIST of
 * the system prefixes — all through the shim, which only exposes the class
 * bound NOW, so a class moved to another target left its old data on the first
 * one uncounted, and no figure said how full a target was.
 *
 * This lists the target itself, with the rclone the platform-api image already
 * carries, configured from the same section renderer the shim uses
 * (`renderUpstreamSection`) so every target kind is reached the way backups
 * reach it:
 *
 *   `rclone size <root>/<class> --json`  bytes and objects per class folder
 *   `rclone about <root> --json`         the target's total / used / free
 *
 * `about` is what SMB and SFTP servers answer and what S3 does not: S3 has no
 * capacity, so an S3 target reports "not reported by S3" rather than a guess.
 *
 * Read-only throughout — safe on a frozen (DR) target. Listing moves metadata
 * only: a few hundred bytes per object, tens of MB for a large tenant class.
 * That is why it runs every 6 hours (and on demand from the targets page), not
 * every few minutes.
 *
 * Stored per target in `platform_settings` (`backup_target_usage:<id>`), so a
 * measurement of one target never overwrites another's.
 */
import { spawn } from 'node:child_process';
import { eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type {
  BackupUsageClass,
  ClassUsage,
  TargetCapacity,
  TargetUsageMeasurement,
  TargetUsageRow,
} from '@insula/api-contracts';
import { BACKUP_USAGE_CLASSES, targetUsageMeasurementSchema } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { backupConfigurations, backupTargetAssignments, platformSettings } from '../../db/schema.js';
import {
  rcloneEnvFromSection,
  renderUpstreamSection,
  upstreamRootPath,
  type BackupTargetConfig,
} from '../backup-rclone-shim/rclone-config.js';
import { rowToTargetConfig } from '../backup-rclone-shim/service.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';

const KEY_PREFIX = 'backup_target_usage:';
const MEASURING_PREFIX = 'backup_target_usage_measuring:';
const REMOTE = 'usage';
const ABOUT_TIMEOUT_MS = 2 * 60 * 1000;
/** A large tenant class over SMB lists in minutes; a stuck listing must still end. */
const SIZE_TIMEOUT_MS = 30 * 60 * 1000;
/** A measurement older than this is no longer "running" — its process is gone. */
const MEASURING_STALE_MS = 2 * 60 * 60 * 1000;

// ─── rclone ─────────────────────────────────────────────────────────────────

export interface RcloneResult { readonly code: number; readonly stdout: string; readonly stderr: string }
export type RcloneRunner = (args: readonly string[], env: Record<string, string>, timeoutMs: number) => Promise<RcloneResult>;

const RCLONE_BASE_ARGS = ['--config', '/dev/null', '--low-level-retries', '3', '--retries', '1'];

/**
 * Only what rclone needs: the remote's own `RCLONE_CONFIG_*` and a PATH/HOME.
 * platform-api's environment holds the encryption key and the database
 * credentials; a child process that lists a backup target has no use for them.
 */
function childEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'TZ'] as const;
  const base: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) base[k] = process.env[k];
  return { ...base, ...env };
}

export const runRclone: RcloneRunner = (args, env, timeoutMs) => new Promise((resolve) => {
  const child = spawn('rclone', [...RCLONE_BASE_ARGS, ...args], { env: childEnv(env) });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const finish = (code: number) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  };
  const timer = setTimeout(() => {
    stderr += `\nrclone timed out after ${Math.round(timeoutMs / 1000)}s`;
    child.kill('SIGTERM');
    finish(124);
  }, timeoutMs);
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
  child.stderr.on('data', (c: Buffer) => { if (stderr.length < 8192) stderr += c.toString('utf8'); });
  child.on('close', (code) => finish(code ?? 1));
  child.on('error', (err) => { stderr += err.message; finish(127); });
});

/**
 * The target as an rclone remote, from the environment (no secret on disk).
 *
 * The SFTP section names a key FILE the shim's reconciler projects into its own
 * pod; there is no such file here, so the key goes in as `key_pem` instead —
 * rclone wants it on one line with `\n` for each line break.
 */
export function remoteFor(target: BackupTargetConfig): { env: Record<string, string>; root: string } {
  const rendered = renderUpstreamSection(REMOTE, target);
  const env = rcloneEnvFromSection(REMOTE, rendered.conf);
  if (rendered.sshKey) {
    delete env[`RCLONE_CONFIG_${REMOTE.toUpperCase()}_KEY_FILE`];
    env[`RCLONE_CONFIG_${REMOTE.toUpperCase()}_KEY_PEM`] = rendered.sshKey.pemContent.trim().replace(/\r?\n/g, '\\n');
  }
  return { env, root: upstreamRootPath(target) };
}

const at = (root: string, sub: string) => `${REMOTE}:${[root, sub].filter((s) => s.length > 0).join('/')}`;

function lastLine(stderr: string): string {
  const lines = stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  // rclone prefixes every log line with a timestamp and level; keep the message.
  return (lines.at(-1) ?? 'rclone failed').replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} [A-Z]+ ?:\s*/, '').slice(0, 300);
}

const isMissingDir = (stderr: string) => /directory not found|not found|does not exist|NoSuchKey|NoSuchBucket/i.test(stderr);
const isAboutUnsupported = (stderr: string) => /doesn'?t support about|not supported|about is not supported/i.test(stderr);

// ─── one target ─────────────────────────────────────────────────────────────

export async function measureTarget(
  target: BackupTargetConfig,
  run: RcloneRunner = runRclone,
  now: () => Date = () => new Date(),
): Promise<TargetUsageMeasurement> {
  const started = Date.now();
  const { env, root } = remoteFor(target);
  const classes: Record<BackupUsageClass, ClassUsage | null> = { system: null, tenant: null, mail: null };
  const errors: Record<string, string> = {};

  for (const cls of BACKUP_USAGE_CLASSES) {
    const res = await run(['size', '--json', at(root, cls)], env, SIZE_TIMEOUT_MS);
    if (res.code === 0) {
      try {
        const parsed = JSON.parse(res.stdout) as { bytes?: number; count?: number };
        classes[cls] = { bytes: Math.max(0, Math.trunc(parsed.bytes ?? 0)), objects: Math.max(0, Math.trunc(parsed.count ?? 0)) };
      } catch {
        errors[cls] = 'rclone size returned output that is not JSON';
      }
    } else if (isMissingDir(res.stderr)) {
      // Nothing of this class was ever written here.
      classes[cls] = { bytes: 0, objects: 0 };
    } else {
      errors[cls] = lastLine(res.stderr);
    }
  }

  let capacity: TargetCapacity | null = null;
  let capacityNote: string | null = null;
  if (target.storageType === 's3') {
    capacityNote = 'S3 storage does not report free space';
  } else {
    const res = await run(['about', '--json', at(root, '')], env, ABOUT_TIMEOUT_MS);
    if (res.code === 0) {
      try {
        const parsed = JSON.parse(res.stdout) as { total?: number; used?: number; free?: number };
        const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null);
        capacity = { totalBytes: n(parsed.total), usedBytes: n(parsed.used), freeBytes: n(parsed.free) };
        if (capacity.freeBytes === null && capacity.totalBytes === null) {
          capacity = null;
          capacityNote = 'the server answered without a size';
        }
      } catch {
        capacityNote = 'the server\'s answer could not be read';
      }
    } else {
      capacityNote = isAboutUnsupported(res.stderr)
        ? 'this server does not report free space'
        : `free space could not be read: ${lastLine(res.stderr)}`;
    }
  }

  const usedByBackupsBytes = BACKUP_USAGE_CLASSES.reduce((sum, c) => sum + (classes[c]?.bytes ?? 0), 0);
  return {
    measuredAt: now().toISOString(),
    durationMs: Date.now() - started,
    classes,
    usedByBackupsBytes,
    capacity,
    capacityNote,
    errors,
  };
}

// ─── storage ────────────────────────────────────────────────────────────────

async function putSetting(db: Database, key: string, value: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO platform_settings (setting_key, setting_value, updated_at)
    VALUES (${key}, ${value}, now())
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = now()
  `);
}

async function deleteSetting(db: Database, key: string): Promise<void> {
  await db.delete(platformSettings).where(eq(platformSettings.key, key));
}

async function readPrefixed(db: Database, prefix: string): Promise<Map<string, string>> {
  const rows = await db.select({ key: platformSettings.key, value: platformSettings.value })
    .from(platformSettings)
    // A prefix compare, not LIKE: `_` in the keys is a LIKE wildcard.
    .where(sql`left(${platformSettings.key}, ${prefix.length}) = ${prefix}`);
  return new Map(rows.map((r) => [r.key.slice(prefix.length), r.value]));
}

/** Every configured target with its last measurement and bound classes. */
export async function listTargetUsage(db: Database, now: Date = new Date()): Promise<TargetUsageRow[]> {
  const [targets, assignments, stored, measuring] = await Promise.all([
    db.select({
      id: backupConfigurations.id,
      name: backupConfigurations.name,
      storageType: backupConfigurations.storageType,
      enabled: backupConfigurations.enabled,
      readOnly: backupConfigurations.readOnly,
    }).from(backupConfigurations),
    db.select({ cls: backupTargetAssignments.backupClass, targetId: backupTargetAssignments.targetId }).from(backupTargetAssignments),
    readPrefixed(db, KEY_PREFIX),
    readPrefixed(db, MEASURING_PREFIX),
  ]);
  return targets
    .map((t) => {
      let usage: TargetUsageMeasurement | null = null;
      const raw = stored.get(t.id);
      if (raw) {
        const parsed = targetUsageMeasurementSchema.safeParse(safeJson(raw));
        usage = parsed.success ? parsed.data : null;
      }
      const since = measuring.get(t.id) ?? null;
      const live = since !== null && now.getTime() - Date.parse(since) < MEASURING_STALE_MS;
      return {
        targetId: t.id,
        name: t.name,
        storageType: t.storageType,
        enabled: Boolean(t.enabled),
        readOnly: t.readOnly,
        boundClasses: assignments
          .filter((a) => a.targetId === t.id && (BACKUP_USAGE_CLASSES as readonly string[]).includes(a.cls))
          .map((a) => a.cls as BackupUsageClass)
          .sort(),
        usage,
        measuringSince: live ? since : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

// ─── measuring ──────────────────────────────────────────────────────────────

export interface MeasureDeps {
  readonly db: Database;
  readonly encryptionKey: string;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
  readonly run?: RcloneRunner;
}

/**
 * Measure one target and store the result. Never throws: the route fires it
 * in the background, where a rejection would be unhandled.
 *
 * One measurement per target at a time, across replicas — a per-target lease,
 * taken by the 6-hour tick and by "Measure now" alike. Two at once would list a
 * slow target twice and the first to finish would clear the other's
 * "measuring" marker. Null when one is already running, or it failed.
 */
export async function measureAndStore(deps: MeasureDeps, targetId: string): Promise<TargetUsageMeasurement | null> {
  try {
    const leased = await withSchedulerLease(deps.db, `backup-target-usage:${targetId}`, MEASURING_STALE_MS, async () => {
      const [row] = await deps.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetId)).limit(1);
      if (!row) return null;
      await putSetting(deps.db, `${MEASURING_PREFIX}${targetId}`, new Date().toISOString());
      try {
        const target = rowToTargetConfig(row, deps.encryptionKey);
        const usage = await measureTarget(target, deps.run);
        await putSetting(deps.db, `${KEY_PREFIX}${targetId}`, JSON.stringify(usage));
        deps.log.info({ targetId, name: row.name, usedByBackupsBytes: usage.usedByBackupsBytes, free: usage.capacity?.freeBytes ?? null, durationMs: usage.durationMs, errors: usage.errors },
          'backup-target usage: measured');
        return usage;
      } finally {
        await deleteSetting(deps.db, `${MEASURING_PREFIX}${targetId}`).catch(() => undefined);
      }
    }, { release: true, startupRetry: false, log: deps.log });
    return leased.ran ? leased.value : null;
  } catch (err) {
    deps.log.warn({ targetId, err: err instanceof Error ? err.message : String(err) }, 'backup-target usage: measurement failed');
    return null;
  }
}

/** Every enabled target, one after another. */
export async function measureAllTargets(deps: MeasureDeps): Promise<number> {
  const rows = await deps.db.select({ id: backupConfigurations.id, enabled: backupConfigurations.enabled }).from(backupConfigurations);
  let measured = 0;
  for (const r of rows) {
    if (!r.enabled) continue;
    if (await measureAndStore(deps, r.id)) measured += 1;
  }
  return measured;
}

/** True while a measurement of this target is (still) running somewhere. */
export async function isMeasuring(db: Database, targetId: string, now: Date = new Date()): Promise<boolean> {
  const since = (await readPrefixed(db, `${MEASURING_PREFIX}${targetId}`)).get('');
  return since !== undefined && now.getTime() - Date.parse(since) < MEASURING_STALE_MS;
}

// ─── scheduler ──────────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 10 * 60 * 1000;

export function startTargetUsageScheduler(deps: MeasureDeps): { stop: () => void } {
  const tick = async (): Promise<void> => {
    try {
      await withSchedulerLease(deps.db, 'backup-target-usage', TICK_INTERVAL_MS * 1.5, () => measureAllTargets(deps), { log: deps.log });
    } catch (err) {
      deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'backup-target usage: tick threw');
    }
  };
  let interval: NodeJS.Timeout | null = null;
  const first = setTimeout(() => {
    void tick();
    interval = setInterval(() => { void tick(); }, TICK_INTERVAL_MS);
    interval.unref?.();
  }, INITIAL_DELAY_MS);
  first.unref?.();
  return {
    stop: () => {
      clearTimeout(first);
      if (interval) clearInterval(interval);
    },
  };
}
