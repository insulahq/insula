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
 * behaviour. Manual bans are not touched. Bans that already exist keep the
 * expiry they were created with.
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
  actionReloadSettings,
  securityGet,
  securityUpdate,
  type StalwartSecurityRow,
} from '../stalwart-jmap/client.js';
import { commitSettingsGroup } from '../stalwart-jmap/settings-group.js';

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
}

const periodsMatch = (row: StalwartSecurityRow, periodMs: number | null): boolean =>
  BAN_PERIOD_FIELDS.every((f) => (row[f] ?? null) === periodMs);

/** Advisory-lock key serializing every apply, across replicas ('MBAN'). */
const APPLY_LOCK_KEY = 0x4d42414e;

/**
 * Push the configured ban lifetime into Stalwart. Never throws: the outcome is
 * returned and logged, so a save or a reconcile tick cannot fail on it.
 *
 * Serialized cluster-wide: a save applies at once on the replica that took it
 * while the 5-minute tick runs on another, and a tick that read the setting
 * just before the save could otherwise commit the OLD lifetime right after the
 * save committed the new one. Under the lock the second caller re-reads both
 * the setting and Stalwart, so it applies the latest value or finds it in sync.
 */
export async function ensureMailBanExpiry(
  db: Database,
  logger: MailBanExpiryLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<MailBanExpiryResult> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${APPLY_LOCK_KEY})`);
      return applyMailBanExpiry(db, logger, opts);
    });
  } catch (err) {
    logger.warn({ err }, 'mail ban expiry: could not take the apply lock — retried on the next tick');
    return { state: 'skipped', periodMs: null, reason: 'database unavailable' };
  }
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
