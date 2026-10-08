/**
 * How long the mail server keeps an automatic IP ban.
 *
 * Stalwart bans an address on its own when it collects too many strikes for
 * one of four reasons — failed logins (auth), port scanning (invalid commands,
 * exploit-path probes), loitering (idle connections), abuse (unknown recipients)
 * — and by default keeps the ban FOREVER. The ban lives in the mail store, so
 * it also survives restarts, restores and failovers. A permanent ban of an
 * address that is shared or reassigned — a NAT, an office, a monitoring probe,
 * the operator's own test runner — locks it out for good, with nothing in the
 * panel to say so. (Seen on the VM tier: a TLS probe loop got the test runner
 * banned with no expiry, and the ban followed the store onto the next failover
 * target.)
 *
 * The platform therefore sets an expiry on all four reasons — 24 hours unless
 * the operator chooses otherwise (Mail Settings), or "never" to keep Stalwart's
 * behaviour. Manual bans are not touched.
 *
 * Bans that are already there get the same lifetime, counted from when each
 * was created (backfillBanLifetimes): automatic bans with no expiry — made
 * before this setting existed, while it was "never", or brought back by a
 * restored store — are given `createdAt + lifetime`, and the ones whose
 * lifetime is already over are lifted on the spot.
 *
 * Applied like the other Stalwart settings groups: the COMPLETE `x:Security`
 * group is committed (a partial write to a never-written group is accepted and
 * discarded — settings-group.ts), read back, and followed by ReloadSettings,
 * which is what makes new bans use it without a restart (measured live: a ban
 * created after commit + reload expired at created + period). Reconciled on
 * the 5-minute mail tick, because a restored or failed-over store carries the
 * group as it was when the snapshot was taken.
 */
import { eq, sql } from 'drizzle-orm';
import {
  MAIL_BAN_EXPIRY_HOURS_DEFAULT,
  MAIL_BAN_EXPIRY_HOURS_MAX,
  MAIL_BAN_EXPIRY_HOURS_MIN,
} from '@insula/api-contracts';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  actionReloadBlockedIps,
  actionReloadSettings,
  blockedIpGet,
  blockedIpQuery,
  blockedIpUpdate,
  securityGet,
  securityUpdate,
  type StalwartSecurityRow,
} from '../stalwart-jmap/client.js';
import { commitSettingsGroup } from '../stalwart-jmap/settings-group.js';
import { claimBanBackfillSlot, releaseBanBackfillSlot } from './ban-backfill-slot.js';

/** platform_settings key: a whole number of hours, or MAIL_BAN_EXPIRY_NEVER. */
export const MAIL_BAN_EXPIRY_KEY = 'mail_ban_expiry_hours';

/** Stored when the operator chooses permanent bans — distinct from "never set". */
export const MAIL_BAN_EXPIRY_NEVER = 'never';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The four ban periods the platform sets — every automatic ban reason. */
const BAN_PERIOD_FIELDS = ['abuseBanPeriod', 'authBanPeriod', 'loiterBanPeriod', 'scanBanPeriod'] as const;

/**
 * Stalwart's built-in values for the fields of the group the platform has no
 * opinion about — `impl Default for Security` in Stalwart v0.16.25, the same
 * as the v0.16.24 the platform pins (read back live after a cold commit). Only
 * used when the group has never been written, or lacks the field: a written
 * group keeps whatever is stored in it. Re-check on a Stalwart upgrade.
 */
const STALWART_SECURITY_DEFAULTS: Required<Omit<StalwartSecurityRow, (typeof BAN_PERIOD_FIELDS)[number]>> = {
  abuseBanRate: { count: 35, period: DAY_MS },
  authBanRate: { count: 100, period: DAY_MS },
  loiterBanRate: { count: 150, period: DAY_MS },
  scanBanPaths: Object.fromEntries([
    '*.php*', '*.cgi*', '*.asp*', '*/wp-*', '*/php*', '*/cgi-bin*', '*xmlrpc*',
    '*../*', '*/..*', '*joomla*', '*wordpress*', '*drupal*',
  ].map((p) => [p, true])),
  scanBanRate: { count: 30, period: DAY_MS },
};

/**
 * The stored setting as hours, or null for "never". Absent, empty or
 * unreadable values fall back to the default rather than to "never": an
 * expiry is the safe side.
 */
export function parseMailBanExpiry(raw: string | null | undefined): number | null {
  const value = raw?.trim();
  if (value === MAIL_BAN_EXPIRY_NEVER) return null;
  const hours = Number(value);
  if (value && Number.isInteger(hours) && hours >= MAIL_BAN_EXPIRY_HOURS_MIN && hours <= MAIL_BAN_EXPIRY_HOURS_MAX) {
    return hours;
  }
  return MAIL_BAN_EXPIRY_HOURS_DEFAULT;
}

/** The value to store for `hours` (null = never). */
export function serializeMailBanExpiry(hours: number | null): string {
  return hours === null ? MAIL_BAN_EXPIRY_NEVER : String(hours);
}

export async function getMailBanExpiryHours(db: Database): Promise<number | null> {
  const [row] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, MAIL_BAN_EXPIRY_KEY));
  return parseMailBanExpiry(row?.value);
}

export interface MailBanExpiryLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export type MailBanExpiryState = 'in-sync' | 'committed' | 'rejected' | 'not-stored' | 'skipped';

export interface MailBanExpiryResult {
  readonly state: MailBanExpiryState;
  /** The ban lifetime now wanted, in ms; null = never expires. */
  readonly periodMs: number | null;
  readonly reason?: string;
  /** Existing bans given the lifetime this run (absent when the backfill did not run). */
  readonly backfill?: BanBackfillResult;
}

// ── Existing bans ────────────────────────────────────────────────────────

/** Stalwart's own automatic ban reasons (BlockReason, camelCase on the wire). Never `manual` / `other`. */
const AUTOMATIC_BAN_REASONS = new Set(['rcptToFailure', 'authFailure', 'loitering', 'portScanning']);

/** Bans per `/query` page, `/get` and `/set` call — well inside Stalwart's per-request limits. */
const BAN_PAGE = 200;

export interface BanBackfillResult {
  /** Automatic bans that had no expiry and now have one. */
  readonly given: number;
  /** Of those, how many were already past their lifetime — lifted now. */
  readonly lifted: number;
}

const toUtc = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Give every automatic ban without an expiry the lifetime `periodMs`, counted
 * from its creation, then have Stalwart re-read its ban list: bans still
 * within their lifetime keep blocking until it ends, bans already past it are
 * deleted and the address is let back in. Idempotent — a ban that has an
 * expiry is never touched again.
 */
export async function backfillBanLifetimes(
  periodMs: number,
  logger: MailBanExpiryLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
  now: number = Date.now(),
): Promise<BanBackfillResult> {
  // Offset paging: a ban that expires or is purged mid-scan shifts the later
  // positions, so a run can miss a few. Harmless — they keep their old state
  // until the next hourly run, which finds them.
  const ids: string[] = [];
  for (let position = 0; ; position += BAN_PAGE) {
    const page = await blockedIpQuery({ position, limit: BAN_PAGE, ...opts });
    ids.push(...page);
    if (page.length < BAN_PAGE) break;
  }

  const expiry = new Map<string, number>();
  const unreadable: string[] = [];
  // A ban the store already counts as expired is one the running server never
  // re-read (a run whose reload failed, or that failed mid-way): only a
  // reload lifts it, and nothing else would trigger one.
  let stale = 0;
  for (let i = 0; i < ids.length; i += BAN_PAGE) {
    for (const ban of await blockedIpGet({ ids: ids.slice(i, i + BAN_PAGE), ...opts })) {
      if (!AUTOMATIC_BAN_REASONS.has(ban.reason ?? '')) continue;
      if (ban.expiresAt != null) {
        if (Date.parse(ban.expiresAt) <= now) stale++;
        continue;
      }
      const created = Date.parse(ban.createdAt ?? '');
      if (Number.isFinite(created)) expiry.set(ban.id, created + periodMs);
      else unreadable.push(ban.id);
    }
  }
  if (unreadable.length > 0) {
    logger.warn({ ids: unreadable }, 'mail ban expiry: some bans have no readable creation time — left as they are');
  }

  const pending = [...expiry.keys()];
  const updated: string[] = [];
  try {
    for (let i = 0; i < pending.length; i += BAN_PAGE) {
      const chunk = pending.slice(i, i + BAN_PAGE);
      const res = await blockedIpUpdate({
        update: Object.fromEntries(chunk.map((id) => [id, { expiresAt: toUtc(expiry.get(id)!) }])),
        ...opts,
      });
      updated.push(...Object.keys(res.updated ?? {}));
      if (res.notUpdated && Object.keys(res.notUpdated).length > 0) {
        logger.warn({ notUpdated: res.notUpdated }, 'mail ban expiry: Stalwart refused to give some existing bans a lifetime');
      }
    }
  } finally {
    // Also after a failed chunk: the chunks before it are stored, and the next
    // run skips them (they have an expiry now) — without the reload the
    // running server would keep enforcing them as permanent. A chunk whose
    // reply was lost may be stored too, so reload on any attempt.
    if (pending.length > 0 || stale > 0) {
      try {
        await actionReloadBlockedIps(opts);
      } catch (err) {
        logger.error({ err }, 'mail ban expiry: ReloadBlockedIps failed — bans past their lifetime stay blocked until the next run or Stalwart restart');
      }
    }
  }
  const lifted = updated.filter((id) => expiry.get(id)! <= now).length;
  if (updated.length > 0 || stale > 0) {
    logger.info(
      { given: updated.length, lifted, stale },
      `mail ban expiry: gave ${updated.length} existing ban(s) the lifetime; ${lifted} were already past it and are lifted`
        + (stale > 0 ? `; re-read ${stale} expired ban(s) the server still held` : ''),
    );
  }
  return { given: updated.length, lifted };
}

/** Advisory-lock key serializing backfill runs, across replicas ('MBBF'). */
const BACKFILL_LOCK_KEY = 0x4d424246;

/**
 * Run the backfill when this caller wins the shared slot (ban-backfill-slot.ts):
 * at once after the lifetime changed, otherwise at most hourly across every
 * replica. Never throws; a failed run gives the slot back so the next tick
 * retries.
 */
async function runBanBackfill(
  db: Database,
  periodMs: number | null,
  logger: MailBanExpiryLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv },
): Promise<BanBackfillResult | undefined> {
  if (periodMs === null) return undefined; // "never": permanent bans are what the operator chose
  try {
    if (!(await claimBanBackfillSlot(db, periodMs))) return undefined;
  } catch (err) {
    logger.warn({ err }, 'mail ban expiry: could not check when existing bans were last checked — retried on the next tick');
    return undefined;
  }
  try {
    // One run at a time: two saves with different lifetimes both win the slot
    // (the value changed), and two concurrent scans could each stamp part of
    // the bans. Under the lock the setting is read again, so a run started for
    // a lifetime a newer save has replaced gives the newer one.
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${BACKFILL_LOCK_KEY})`);
      const hours = await getMailBanExpiryHours(db);
      if (hours === null) return undefined;
      return backfillBanLifetimes(hours * HOUR_MS, logger, opts);
    });
  } catch (err) {
    logger.warn({ err }, 'mail ban expiry: could not check existing bans — retried on the next tick');
    await releaseBanBackfillSlot(db).catch((releaseErr: unknown) => {
      logger.warn({ err: releaseErr }, 'mail ban expiry: could not release the backfill slot — retried within the hour');
    });
    return undefined;
  }
}

const periodsMatch = (row: StalwartSecurityRow, periodMs: number | null): boolean =>
  BAN_PERIOD_FIELDS.every((f) => (row[f] ?? null) === periodMs);

/** Advisory-lock key serializing every apply, across replicas ('MBAN'). */
const APPLY_LOCK_KEY = 0x4d42414e;

/**
 * Push the configured ban lifetime into Stalwart, then give existing bans the
 * same lifetime (runBanBackfill). Never throws: the outcome is returned and
 * logged, so a save or a reconcile tick cannot fail on it.
 *
 * The apply is serialized cluster-wide: a save applies at once on the replica
 * that took it while the 5-minute tick runs on another, and a tick that read
 * the setting just before the save could otherwise commit the OLD lifetime
 * right after the save committed the new one. Under the lock the second caller
 * re-reads both the setting and Stalwart, so it applies the latest value or
 * finds it in sync.
 *
 * The backfill runs after the lock is released — it lists every ban, which
 * takes as long as the ban list is long, and the shared slot already keeps it
 * to one run at a time. With `detachBackfill` (the save path) it runs in the
 * background, so an operator's save does not wait on it.
 */
export async function ensureMailBanExpiry(
  db: Database,
  logger: MailBanExpiryLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv; detachBackfill?: boolean } = {},
): Promise<MailBanExpiryResult> {
  const { detachBackfill = false, ...stalwart } = opts;
  let result: MailBanExpiryResult;
  try {
    result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${APPLY_LOCK_KEY})`);
      return applyMailBanExpiry(db, logger, stalwart);
    });
  } catch (err) {
    logger.warn({ err }, 'mail ban expiry: could not take the apply lock — retried on the next tick');
    return { state: 'skipped', periodMs: null, reason: 'database unavailable' };
  }
  // Only once Stalwart holds the lifetime: a ban given it now must not
  // outlive what new bans get.
  if (result.state !== 'in-sync' && result.state !== 'committed') return result;
  if (detachBackfill) {
    void runBanBackfill(db, result.periodMs, logger, stalwart);
    return result;
  }
  const backfill = await runBanBackfill(db, result.periodMs, logger, stalwart);
  return backfill ? { ...result, backfill } : result;
}

async function applyMailBanExpiry(
  db: Database,
  logger: MailBanExpiryLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv },
): Promise<MailBanExpiryResult> {
  let hours: number | null;
  try {
    hours = await getMailBanExpiryHours(db);
  } catch (err) {
    logger.warn({ err }, 'mail ban expiry: could not read the setting — leaving Stalwart untouched');
    return { state: 'skipped', periodMs: null, reason: 'setting unreadable' };
  }
  const periodMs = hours === null ? null : hours * HOUR_MS;

  let current: StalwartSecurityRow | null;
  try {
    current = await securityGet(opts);
  } catch (err) {
    logger.warn({ err }, 'mail ban expiry: Stalwart unreachable — retried on the next tick');
    return { state: 'skipped', periodMs, reason: 'stalwart unreachable' };
  }
  if (current && periodsMatch(current, periodMs)) {
    return { state: 'in-sync', periodMs };
  }

  // The complete group: what is stored for the fields the platform leaves
  // alone (Stalwart's defaults while the group is unwritten), and the period
  // on all four ban reasons.
  const keep = (field: keyof typeof STALWART_SECURITY_DEFAULTS) =>
    current && field in current ? current[field] ?? null : STALWART_SECURITY_DEFAULTS[field];
  const patch: Record<string, unknown> = {
    abuseBanRate: keep('abuseBanRate'),
    authBanRate: keep('authBanRate'),
    loiterBanRate: keep('loiterBanRate'),
    scanBanPaths: keep('scanBanPaths'),
    scanBanRate: keep('scanBanRate'),
    ...Object.fromEntries(BAN_PERIOD_FIELDS.map((f) => [f, periodMs])),
  };

  let result;
  try {
    result = await commitSettingsGroup<StalwartSecurityRow>({
      read: () => securityGet(opts),
      write: (p) => securityUpdate({ patch: p, ...opts }),
      patch,
      primer: { scanBanPeriod: periodMs },
      verify: (row) => periodsMatch(row, periodMs),
      current,
    });
  } catch (err) {
    logger.warn({ err }, 'mail ban expiry: Stalwart unreachable mid-commit — retried on the next tick');
    return { state: 'skipped', periodMs, reason: 'stalwart unreachable' };
  }

  if (result.state !== 'committed') {
    logger.error({ state: result.state, reason: result.reason }, 'mail ban expiry: Stalwart did not store the ban lifetime');
    return { state: result.state, periodMs, reason: result.reason };
  }

  // Stalwart reads the group when it builds its configuration; without the
  // reload new bans keep the old lifetime until the next restart.
  try {
    await actionReloadSettings(opts);
  } catch (err) {
    logger.error({ err }, 'mail ban expiry: stored, but ReloadSettings failed — applies from the next Stalwart restart');
  }
  logger.info(
    { hours, wasCold: result.wasCold },
    hours === null ? 'mail ban expiry: automatic bans never expire' : `mail ban expiry: automatic bans expire after ${hours} h`,
  );
  return { state: 'committed', periodMs };
}
