/**
 * Run a scheduled job on ONE platform-api replica at a time.
 *
 * Every in-process scheduler starts on every replica, and HA runs three. A job
 * that does not claim its work runs three times: two restic prunes on one
 * repository (the second fails on the exclusive lock and pages an admin), a
 * bandwidth window billed twice, an expired tenant suspended twice, an app
 * upgraded by two replicas at once.
 *
 * The lease is sticky, one row per job in `platform_settings`
 * (`scheduler-lease:<job>` → `{"holder","until"}`):
 *   - a replica runs a tick only when it already holds the lease or the lease
 *     has expired — so the holder keeps running every tick and the others skip;
 *   - every tick and, while a long run is in flight, a renewal timer push
 *     `until` to `now() + ttl`;
 *   - when the holder dies, its lease runs out after `ttl` and the next replica
 *     to tick takes the job over.
 * Times are the database's `now()`, never a pod clock, so skew between nodes
 * cannot hand the job to two replicas. A `ttl` of about 1.5 × the job's
 * interval keeps a live holder from losing the lease between two of its own
 * ticks and bounds the takeover delay after a holder dies.
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { sql, type SQL } from 'drizzle-orm';

/** Any drizzle database: the lease only runs raw statements. */
export interface LeaseDb {
  execute(query: SQL): Promise<unknown>;
}

/** This process. A restarted pod is a new holder: its old lease simply expires. */
export const REPLICA_ID = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;

const KEY_PREFIX = 'scheduler-lease:';

/**
 * Jobs whose `fn` is running in this process right now, by lease name. A
 * graceful shutdown must not hand these to another replica: the work is still
 * in flight (a restic prune it spawned may even outlive this process), so its
 * lease is left to expire on its own, exactly as after a crash.
 */
const inFlight = new Map<string, number>();

export interface LeaseLogger {
  readonly warn: (obj: unknown, msg?: string) => void;
}

/**
 * Take or keep `job`'s lease for `ttlMs`. True when this holder now owns it.
 * One conditional upsert: the row is written only when it is missing, already
 * this holder's, expired, or unreadable — a concurrent claimer sees the other
 * holder's fresh `until` and matches nothing.
 */
export async function claimSchedulerLease(
  db: LeaseDb,
  job: string,
  ttlMs: number,
  holder: string = REPLICA_ID,
): Promise<boolean> {
  const key = `${KEY_PREFIX}${job}`;
  const ttl = Math.max(1000, Math.round(ttlMs));
  const res = await db.execute(sql`
    INSERT INTO platform_settings (setting_key, setting_value, updated_at)
    VALUES (
      ${key},
      json_build_object('holder', ${holder}::text, 'until', now() + (${ttl}::bigint * interval '1 millisecond'))::text,
      now()
    )
    ON CONFLICT (setting_key) DO UPDATE
      SET setting_value = EXCLUDED.setting_value, updated_at = now()
      WHERE CASE
        WHEN pg_input_is_valid(platform_settings.setting_value, 'jsonb') THEN
          (platform_settings.setting_value::jsonb ->> 'holder') = ${holder}::text
          OR coalesce(CASE
            WHEN pg_input_is_valid(platform_settings.setting_value::jsonb ->> 'until', 'timestamptz')
              THEN (platform_settings.setting_value::jsonb ->> 'until')::timestamptz < now()
          END, true)
        ELSE true
      END
    RETURNING setting_key
  `) as unknown as { rows?: unknown[] };
  return (res.rows ?? []).length > 0;
}

/**
 * Give `job`'s lease up now (only if this holder has it), so the next claimer
 * does not wait for it to expire. For a lease used as a run lock rather than a
 * schedule owner.
 */
export async function releaseSchedulerLease(
  db: LeaseDb,
  job: string,
  holder: string = REPLICA_ID,
): Promise<void> {
  await db.execute(sql`
    DELETE FROM platform_settings
     WHERE setting_key = ${`${KEY_PREFIX}${job}`}
       AND pg_input_is_valid(setting_value, 'jsonb')
       AND (setting_value::jsonb ->> 'holder') = ${holder}::text
  `);
}

/**
 * Give up every lease this process holds — on graceful shutdown. A rollout
 * replaces every pod, and the new processes are new holders: without this,
 * each job would wait out the old holder's ttl (hours for a 6- or 24-hour
 * job) after every deploy. A crashed process cannot release; its leases
 * expire on their own — and so do the leases of jobs still running here
 * (`runningSchedulerJobs`), so a sweep cut off by the rollout is not started
 * a second time alongside itself.
 */
export async function releaseAllSchedulerLeases(
  db: LeaseDb,
  holder: string = REPLICA_ID,
  keep: readonly string[] = runningSchedulerJobs(),
): Promise<number> {
  const kept = keep.length > 0
    ? sql`AND setting_key NOT IN (${sql.join(keep.map((job) => sql`${`${KEY_PREFIX}${job}`}`), sql`, `)})`
    : sql``;
  const res = await db.execute(sql`
    DELETE FROM platform_settings
     WHERE setting_key LIKE ${`${KEY_PREFIX}%`}
       AND pg_input_is_valid(setting_value, 'jsonb')
       AND (setting_value::jsonb ->> 'holder') = ${holder}::text
       ${kept}
    RETURNING setting_key
  `) as unknown as { rows?: unknown[] };
  return (res.rows ?? []).length;
}

/** Lease names whose job is running in this process right now. */
export function runningSchedulerJobs(): string[] {
  return [...inFlight.keys()];
}

export interface LeaseOptions {
  readonly holder?: string;
  /**
   * Release the lease when `fn` settles — a run lock ("one sweep at a time")
   * instead of a sticky schedule owner ("this replica runs the job").
   */
  readonly release?: boolean;
  /** How often a long run renews its lease. Default: a third of the ttl, at most every 5 min. */
  readonly renewEveryMs?: number;
  readonly log?: LeaseLogger;
}

export type LeaseOutcome<T> = { readonly ran: true; readonly value: T } | { readonly ran: false };

/**
 * Run `fn` if this replica holds (or can take) `job`'s lease; otherwise skip.
 * The lease is renewed while `fn` runs, so a run longer than `ttlMs` is not
 * taken over mid-flight. A failure to renew is logged, never thrown — the run
 * in flight is not abandoned over a database blip.
 */
export async function withSchedulerLease<T>(
  db: LeaseDb,
  job: string,
  ttlMs: number,
  fn: () => Promise<T>,
  opts: LeaseOptions = {},
): Promise<LeaseOutcome<T>> {
  const holder = opts.holder ?? REPLICA_ID;
  if (!(await claimSchedulerLease(db, job, ttlMs, holder))) return { ran: false };

  const renewEveryMs = opts.renewEveryMs ?? Math.min(ttlMs / 3, 5 * 60_000);
  const timer = setInterval(() => {
    claimSchedulerLease(db, job, ttlMs, holder).then((kept) => {
      if (!kept) opts.log?.warn({ job, holder }, 'scheduler lease: lost to another replica while running');
    }, (err: unknown) => {
      opts.log?.warn({ job, err: err instanceof Error ? err.message : String(err) }, 'scheduler lease: renewal failed');
    });
  }, Math.max(1000, renewEveryMs));
  timer.unref?.();
  inFlight.set(job, (inFlight.get(job) ?? 0) + 1);
  try {
    return { ran: true, value: await fn() };
  } finally {
    const left = (inFlight.get(job) ?? 1) - 1;
    if (left > 0) inFlight.set(job, left); else inFlight.delete(job);
    clearInterval(timer);
    if (opts.release) {
      await releaseSchedulerLease(db, job, holder).catch((err: unknown) => {
        opts.log?.warn({ job, err: err instanceof Error ? err.message : String(err) }, 'scheduler lease: release failed (it expires on its own)');
      });
    }
  }
}
