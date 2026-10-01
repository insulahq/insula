/**
 * Daily prune of the mail-snapshot restic repository.
 *
 * The stalwart-snapshot Job used to run `restic forget … --prune` on EVERY
 * run. At the operator cadence of every 10 minutes that meant a full prune
 * 144 times a day. On a ~60 GiB repo each prune re-downloaded every tree
 * pack into a cold cache, listed every pack file on the target (~20 s over
 * SMB) and rewrote the whole index — per day ~2.1 GB pulled from the backup
 * target, ~0.3 GB pushed, ~7 GB of in-cluster traffic and over an hour of Job
 * runtime, while the backups themselves added ~1.4 MiB per run.
 *
 * The Job now only FORGETS (cheap: rewrites the snapshot list) when the
 * CronJob template sets RESTIC_PRUNE_MODE=platform, and this pass does the
 * reclaiming at most once per PRUNE_INTERVAL_MS — the same split the
 * tenant-bundle retention made (`tenant-bundles/restic-retention.ts`).
 * Reclamation is delayed by up to a day; restore points are not, because
 * forget still applies the retention policy on every run.
 *
 * ── Which repo ──────────────────────────────────────────────────────────────
 * Read from the Secret the Job itself mounts, so this prunes exactly the repo
 * the Job writes, whichever reconciler owns that Secret. Only repos behind the
 * in-cluster shim are handled; anything else is skipped and logged.
 *
 * ── One prune per day across replicas ───────────────────────────────────────
 * Every replica ticks. A conditional upsert on `platform_settings` takes a
 * LEASE: it moves the "next due" time forward by PRUNE_LEASE_MS (longer than
 * the prune timeout), and only the replica whose upsert matched prunes. Only a
 * successful prune pushes the due time a full day out; a failure pulls it to
 * within the hour. A replica killed mid-prune (deploy, OOM) therefore leaves
 * the lease to expire — a retry hours later, not tomorrow — and the durable
 * `running` marker it wrote first lets the next attempt say that it happened.
 *
 * ── Gates, in order ─────────────────────────────────────────────────────────
 * Kill switch, a bound mail target, a WRITABLE target (a DR-restored cluster
 * must never prune the repo it restored from), a readable shim repo — all
 * BEFORE the claim, so none of them burns the day's slot.
 */

import type { Logger } from 'pino';
import type * as k8s from '@kubernetes/client-node';
import { inArray, eq, sql } from 'drizzle-orm';

import type { Database } from '../../db/index.js';
import { backupConfigurations, backupTargetAssignments, platformSettings } from '../../db/schema.js';
import { requireWritableTarget, TargetFrozenError } from '../backup-config/writable-guard.js';
import {
  MAIL_NAMESPACE,
  MAIL_RESTIC_SECRET_NAME,
  MAIL_SHIM_BUCKET,
  SHIM_S3_ENDPOINT_URL,
} from '../backup-rclone-shim/mail-restic.js';
import { runResticPrune, type RunResticPruneArgs } from '../tenant-bundles/restic-driver.js';
import { notifyResticFailure } from '../tenant-bundles/restic-failure-notify.js';

export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PRUNE_RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
/** Hard ceiling on one prune; restic is killed past it. */
export const PRUNE_TIMEOUT_MS = 60 * 60 * 1000;
/** The claim's hold. Outlives the timeout, so a live prune is never doubled. */
export const PRUNE_LEASE_MS = PRUNE_TIMEOUT_MS + 2 * 60 * 60 * 1000;
/**
 * How long the prune waits for a lock held by a running snapshot Job. A Job
 * that only forgets holds its lock for seconds; this is generous on purpose.
 */
export const PRUNE_RETRY_LOCK = '5m';
/**
 * Repack at most this much per prune (restic `--max-repack-size`). The Job
 * waits on the prune's EXCLUSIVE lock, so the lock must stay short: a repo
 * that needs more repacking converges over several days instead.
 */
export const PRUNE_MAX_REPACK_SIZE = '1G';

/** `platform_settings` key holding the ISO time the next prune may start. */
export const PRUNE_DUE_KEY = 'mail_snapshot_prune_next_due_at';
/** `platform_settings` key holding the last attempt's outcome, as JSON. */
export const PRUNE_LAST_RESULT_KEY = 'mail_snapshot_prune_last_result';

const KILL_SWITCH_ENV = 'MAIL_SNAPSHOT_PRUNE';

export type MailPruneOutcome =
  | 'running'
  | 'pruned'
  | 'failed'
  | 'not-due'
  | 'disabled'
  | 'no-target'
  | 'frozen'
  | 'unsupported-repo'
  | 'incomplete-credentials';

export interface MailPruneResult {
  readonly outcome: MailPruneOutcome;
  readonly at: string;
  readonly durationMs: number | null;
  readonly error: string | null;
}

type RepoEnv = Readonly<Record<string, string | undefined>>;

export interface MailSnapshotPruneDeps {
  readonly disabled: () => boolean;
  readonly findMailTargetId: () => Promise<string | null>;
  /** Throws TargetFrozenError for a read-only target. */
  readonly requireWritable: (targetId: string) => Promise<unknown>;
  /** The Job's restic env from its Secret, or null when the Secret is absent. */
  readonly readRepoEnv: () => Promise<RepoEnv | null>;
  /** True when THIS caller won the lease (due time moved to `leaseUntilIso`). */
  readonly claim: (nowIso: string, leaseUntilIso: string) => Promise<boolean>;
  readonly setNextDue: (dueIso: string) => Promise<void>;
  readonly readLastResult: () => Promise<MailPruneResult | null>;
  readonly recordResult: (result: MailPruneResult) => Promise<void>;
  readonly prune: (args: RunResticPruneArgs) => Promise<void>;
  readonly notifyFailure: (err: unknown) => Promise<void>;
  readonly now: () => Date;
  readonly log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

function skip(outcome: MailPruneOutcome, now: Date): MailPruneResult {
  return { outcome, at: now.toISOString(), durationMs: null, error: null };
}

/** One pass. Prunes only when every gate passes and this caller wins the claim. */
export async function runMailSnapshotPrune(deps: MailSnapshotPruneDeps): Promise<MailPruneResult> {
  const now = deps.now();
  if (deps.disabled()) return skip('disabled', now);

  const targetId = await deps.findMailTargetId();
  if (!targetId) return skip('no-target', now);
  try {
    await deps.requireWritable(targetId);
  } catch (err) {
    if (err instanceof TargetFrozenError) return skip('frozen', now);
    throw err;
  }

  const env = await deps.readRepoEnv();
  const repoUri = env?.RESTIC_REPOSITORY ?? '';
  if (!repoUri) return skip('no-target', now);
  // The trailing slash keeps a host that merely STARTS with the shim's from
  // passing as the shim.
  if (!repoUri.startsWith(`s3:${SHIM_S3_ENDPOINT_URL}/`)) {
    deps.log.warn({ repo: repoUri.replace(/\/\/[^/]*@/, '//') },
      'mail-snapshot-prune: repo is not behind the backup shim — not pruning it from platform-api');
    return skip('unsupported-repo', now);
  }
  const password = env?.RESTIC_PASSWORD ?? '';
  const accessKey = env?.AWS_ACCESS_KEY_ID ?? '';
  const secretKey = env?.AWS_SECRET_ACCESS_KEY ?? '';
  if (!password || !accessKey || !secretKey) return skip('incomplete-credentials', now);

  const won = await deps.claim(now.toISOString(), new Date(now.getTime() + PRUNE_LEASE_MS).toISOString());
  if (!won) return skip('not-due', now);

  // An attempt that wrote `running` and never wrote an outcome died mid-prune.
  // Nothing else would ever say so: the process that knew is gone.
  const previous = await deps.readLastResult();
  if (previous?.outcome === 'running') {
    await deps.notifyFailure(new Error(
      `the previous mail-snapshot prune (started ${previous.at}) never finished — `
      + 'platform-api was restarted or killed while it ran; retrying now',
    ));
  }
  await deps.recordResult({ outcome: 'running', at: now.toISOString(), durationMs: null, error: null });

  const startedAt = Date.now();
  try {
    await deps.prune({
      target: { kind: 'shim', endpoint: SHIM_S3_ENDPOINT_URL, bucket: MAIL_SHIM_BUCKET, accessKey, secretKey },
      passwordHex: password,
      repoUri,
      retryLock: PRUNE_RETRY_LOCK,
      maxRepackSize: PRUNE_MAX_REPACK_SIZE,
      timeoutMs: PRUNE_TIMEOUT_MS,
      log: deps.log,
    });
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const failed: MailPruneResult = {
      outcome: 'failed', at: now.toISOString(), durationMs: Date.now() - startedAt, error: msg,
    };
    await deps.setNextDue(new Date(now.getTime() + PRUNE_RETRY_AFTER_FAILURE_MS).toISOString());
    await deps.recordResult(failed);
    deps.log.error({ err: msg }, 'mail-snapshot-prune: prune failed — retrying within the hour');
    await deps.notifyFailure(err);
    return failed;
  }

  // The prune succeeded. What follows is bookkeeping, and a failure in it must
  // not be reported as a failed prune: the worst it costs is a repeat prune
  // when the lease expires.
  const result: MailPruneResult = {
    outcome: 'pruned', at: now.toISOString(), durationMs: Date.now() - startedAt, error: null,
  };
  try {
    await deps.setNextDue(new Date(now.getTime() + PRUNE_INTERVAL_MS).toISOString());
    await deps.recordResult(result);
  } catch (err) {
    deps.log.warn({ err: err instanceof Error ? err.message : String(err) },
      'mail-snapshot-prune: pruned, but recording it failed — the lease expiry will prune again');
  }
  deps.log.info({ durationMs: result.durationMs }, 'mail-snapshot-prune: pruned mail snapshot repo');
  return result;
}

// ─── Real dependencies ──────────────────────────────────────────────────────

async function findMailTargetId(db: Database): Promise<string | null> {
  // Same lookup triggerMailSnapshot uses to decide whether a mail target is
  // bound and writable.
  const rows = await db
    .select({ targetId: backupTargetAssignments.targetId })
    .from(backupTargetAssignments)
    .innerJoin(backupConfigurations, eq(backupConfigurations.id, backupTargetAssignments.targetId))
    .where(inArray(backupTargetAssignments.backupClass, ['mail']))
    .orderBy(backupTargetAssignments.priority)
    .limit(1);
  return rows[0]?.targetId ?? null;
}

async function readRepoEnv(core: k8s.CoreV1Api): Promise<RepoEnv | null> {
  try {
    const secret = (await core.readNamespacedSecret({
      name: MAIL_RESTIC_SECRET_NAME,
      namespace: MAIL_NAMESPACE,
    } as unknown as Parameters<typeof core.readNamespacedSecret>[0])) as { data?: Record<string, string> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(secret.data ?? {})) {
      out[k] = Buffer.from(v, 'base64').toString('utf8');
    }
    return out;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 404) return null;
    throw err;
  }
}

/**
 * Take the lease: move the due time to `leaseUntilIso` iff it has passed (or
 * was never set). The conditional DO UPDATE is what makes this one-winner
 * across replicas: a concurrent caller sees the already-advanced value and
 * matches nothing. ISO strings in UTC compare correctly as text.
 */
async function claim(db: Database, nowIso: string, leaseUntilIso: string): Promise<boolean> {
  const res = await db.execute(sql`
    INSERT INTO platform_settings (setting_key, setting_value, updated_at)
    VALUES (${PRUNE_DUE_KEY}, ${leaseUntilIso}, now())
    ON CONFLICT (setting_key) DO UPDATE
      SET setting_value = EXCLUDED.setting_value, updated_at = now()
      WHERE platform_settings.setting_value <= ${nowIso}
    RETURNING setting_key
  `) as unknown as { rows: unknown[] };
  return res.rows.length > 0;
}

async function readLastResult(db: Database): Promise<MailPruneResult | null> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, PRUNE_LAST_RESULT_KEY))
    .limit(1);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as MailPruneResult;
  } catch {
    // A garbled marker is not evidence of a dead prune; treat it as absent.
    return null;
  }
}

async function putSetting(db: Database, key: string, value: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO platform_settings (setting_key, setting_value, updated_at)
    VALUES (${key}, ${value}, now())
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = now()
  `);
}

export function createMailSnapshotPruneDeps(
  db: Database,
  core: k8s.CoreV1Api,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): MailSnapshotPruneDeps {
  return {
    disabled: () => process.env[KILL_SWITCH_ENV] === 'disable',
    findMailTargetId: () => findMailTargetId(db),
    requireWritable: (targetId) => requireWritableTarget(db, targetId),
    readRepoEnv: () => readRepoEnv(core),
    claim: (nowIso, leaseUntilIso) => claim(db, nowIso, leaseUntilIso),
    setNextDue: (dueIso) => putSetting(db, PRUNE_DUE_KEY, dueIso),
    readLastResult: () => readLastResult(db),
    recordResult: (result) => putSetting(db, PRUNE_LAST_RESULT_KEY, JSON.stringify(result)),
    prune: runResticPrune,
    notifyFailure: (err) => notifyResticFailure(db, {
      operation: 'prune',
      scope: 'mail snapshots',
      dedupeScope: 'mail-snapshots',
    }, err, log),
    now: () => new Date(),
    log,
  };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

/** Cheap when not due: one indexed upsert that matches nothing. */
const TICK_INTERVAL_MS = 60 * 60 * 1000;
/** Delayed so a rollout that restarts every replica does not prune at once. */
const INITIAL_DELAY_MS = 15 * 60 * 1000;

export function startMailSnapshotPruneScheduler(
  db: Database,
  core: k8s.CoreV1Api,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  opts: { intervalMs?: number; initialDelayMs?: number } = {},
): { stop: () => void } {
  const deps = createMailSnapshotPruneDeps(db, core, log);
  let running = false;
  let interval: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    // A prune can outlast a tick; never stack a second one in this process.
    if (running) return;
    running = true;
    try {
      await runMailSnapshotPrune(deps);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'mail-snapshot-prune: tick threw');
    } finally {
      running = false;
    }
  };

  const initial = setTimeout(() => {
    void tick();
    interval = setInterval(() => void tick(), opts.intervalMs ?? TICK_INTERVAL_MS);
    interval.unref();
  }, opts.initialDelayMs ?? INITIAL_DELAY_MS);
  initial.unref();

  return {
    stop: () => {
      clearTimeout(initial);
      if (interval) clearInterval(interval);
    },
  };
}
