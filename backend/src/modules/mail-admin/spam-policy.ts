/**
 * Spam thresholds and DMARC enforcement on the mail server.
 *
 * Stalwart's defaults deliver forged mail to the inbox. DMARC is verified in
 * "relaxed" mode — the result goes into the headers and nothing is enforced,
 * so even a domain that publishes `p=reject` is delivered — and a DMARC
 * failure under `p=quarantine` is one scored tag (+1.5 against a Junk
 * threshold of 5). A phish forging a tenant's own domain (`p=quarantine`)
 * failed SPF and DMARC on production and still reached the inbox at a score
 * under 4.
 *
 * Three things are kept set, on the 5-minute mail tick (a restored or
 * failed-over store brings back the settings it had when its snapshot was
 * taken) and at once when the operator saves Mail Settings:
 *
 *  1. DMARC is verified STRICTLY on port 25 (`SenderAuth.dmarcVerify`): mail
 *     that fails DMARC for a domain publishing `p=reject` is refused during
 *     the SMTP session (550 5.7.1), so the sending server — not the forged
 *     sender — holds the bounce. Mail through haproxy counts as port 25:
 *     Stalwart takes `local_port` from the PROXY header, not its :12025
 *     listener. Submission and IMAP ports never verify DMARC.
 *  2. A failure under `p=quarantine` scores enough to land in Junk on its own
 *     (the DMARC_POLICY_QUARANTINE tag) — see dmarcQuarantineScore.
 *  3. The operator's thresholds (`SpamSettings.scoreSpam` / `scoreReject`):
 *     ONE pair for the whole server. Stalwart's thresholds are plain numbers,
 *     not expressions, so they cannot differ per domain.
 *
 * Only those fields are the platform's. Every other field of each group stays
 * as stored (Stalwart's defaults while unwritten), and a quarantine tag an
 * operator turned into a Reject or Discard action is stricter than Junk, so it
 * is left alone.
 *
 * Measured on DEV (v0.16.27): after a settings reload the next SMTP session
 * applies all three — no restart — and they survive a restart.
 */
import { inArray, sql } from 'drizzle-orm';
import {
  MAIL_SPAM_JUNK_SCORE_DEFAULT,
  MAIL_SPAM_JUNK_SCORE_MAX,
  MAIL_SPAM_JUNK_SCORE_MIN,
  MAIL_SPAM_REJECT_SCORE_MAX,
} from '@insula/api-contracts';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  actionReloadSettings,
  senderAuthGet,
  senderAuthUpdate,
  spamSettingsGet,
  spamSettingsUpdate,
  spamTagFind,
  spamTagSet,
  type StalwartExpression,
} from '../stalwart-jmap/client.js';
import { commitSettingsGroup, type SettingsCommitState } from '../stalwart-jmap/settings-group.js';

/** platform_settings keys: the Junk threshold, and the refuse threshold or SPAM_REJECT_OFF. */
export const SPAM_JUNK_SCORE_KEY = 'mail_spam_junk_score';
export const SPAM_REJECT_SCORE_KEY = 'mail_spam_reject_score';
/** Stored when the operator chooses to refuse nothing on score — distinct from "never set". */
export const SPAM_REJECT_OFF = 'off';

export interface SpamThresholds {
  readonly junk: number;
  /** null = nothing is refused on score. */
  readonly reject: number | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const sameScore = (a: number | undefined, b: number): boolean => typeof a === 'number' && Math.abs(a - b) < 1e-6;

/**
 * The stored thresholds. An absent or unreadable Junk value reads as the
 * default. A refuse value that is absent, unreadable, or not above the Junk
 * line reads as off: when the setting is in doubt, Junk is the safe side and
 * a bounce is not.
 */
export function parseSpamThresholds(junkRaw: string | null | undefined, rejectRaw: string | null | undefined): SpamThresholds {
  const junkText = junkRaw?.trim();
  const j = Number(junkText);
  const junk = junkText && Number.isFinite(j) && j >= MAIL_SPAM_JUNK_SCORE_MIN && j <= MAIL_SPAM_JUNK_SCORE_MAX
    ? round1(j)
    : MAIL_SPAM_JUNK_SCORE_DEFAULT;
  const rejectText = rejectRaw?.trim();
  const r = Number(rejectText);
  const reject = rejectText && rejectText !== SPAM_REJECT_OFF && Number.isFinite(r) && round1(r) > junk && r <= MAIL_SPAM_REJECT_SCORE_MAX
    ? round1(r)
    : null;
  return { junk, reject };
}

/** The value to store for a threshold (null = off; only the refuse threshold can be off). */
export function serializeSpamScore(score: number | null): string {
  return score === null ? SPAM_REJECT_OFF : String(round1(score));
}

export async function getSpamThresholds(db: Database): Promise<SpamThresholds> {
  const rows = await db
    .select({ key: platformSettings.key, value: platformSettings.value })
    .from(platformSettings)
    .where(inArray(platformSettings.key, [SPAM_JUNK_SCORE_KEY, SPAM_REJECT_SCORE_KEY]));
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  return parseSpamThresholds(value(SPAM_JUNK_SCORE_KEY), value(SPAM_REJECT_SCORE_KEY));
}

// ── What is enforced ─────────────────────────────────────────────────────

/** DMARC verified strictly on the inbound MX port; never on submission or IMAP. */
export const DMARC_VERIFY_STRICT: StalwartExpression = {
  match: { '0': { if: 'local_port == 25', then: 'strict' } },
  else: 'disable',
};

export const DMARC_QUARANTINE_TAG = 'DMARC_POLICY_QUARANTINE';

/**
 * How far above the Junk threshold a DMARC failure under `p=quarantine` is
 * scored. It outweighs every "looks legitimate" signal the default rules
 * (spam-filter v3.0.3) can give a message whose DMARC failed: the trained
 * classifier's strongest ham verdict (PROB_HAM_HIGH −8), an allow-listed
 * sending IP (DWL_DNSWL_HI −3.5, RCVD_IN_DNSWL_HI −0.5,
 * RWL_MAILSPIKE_EXCELLENT −0.4) and the small MIME and list bonuses —
 * about −12.8 together. TRUSTED_DOMAIN (−7) needs a DMARC pass, so it
 * cannot apply.
 */
export const DMARC_QUARANTINE_HEADROOM = 13;

/**
 * The DMARC_POLICY_QUARANTINE score for these thresholds. With a refuse
 * threshold below that, the DMARC failure alone would refuse the message, and
 * the domain asked for Junk, not a bounce: it is scored just under the refuse
 * line instead (never under the Junk line). A message that also carries any
 * other spam signal then crosses it and is refused, like any message scoring
 * that high — the top of the Junk band keeps the most room against the
 * "looks legitimate" signals that would otherwise pull it into the inbox.
 */
export function dmarcQuarantineScore({ junk, reject }: SpamThresholds): number {
  const wanted = round1(junk + DMARC_QUARANTINE_HEADROOM);
  if (reject === null || reject > wanted) return wanted;
  return round1(Math.max(junk, reject - 0.1));
}

const normalizeExpression = (e: StalwartExpression | undefined): string =>
  JSON.stringify({
    match: Object.entries(e?.match ?? {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, m]) => [m.if, m.then]),
    else: e?.else ?? null,
  });

export const sameExpression = (a: StalwartExpression | undefined, b: StalwartExpression): boolean =>
  normalizeExpression(a) === normalizeExpression(b);

// ── Apply ────────────────────────────────────────────────────────────────

export interface SpamPolicyLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

type StalwartOpts = { baseUrl?: string; env?: NodeJS.ProcessEnv };

export type SpamPolicyPart = 'dmarc' | 'thresholds' | 'quarantine';
/** `kept`: the quarantine tag refuses or drops the message — stricter than Junk, left as the operator set it. */
export type SpamPolicyPartState = 'in-sync' | 'kept' | SettingsCommitState;

export interface SpamPolicyResult {
  /** `incomplete`: some part was refused or did not land, or Stalwart went away mid-way. */
  readonly state: 'in-sync' | 'committed' | 'incomplete' | 'skipped';
  readonly thresholds: SpamThresholds | null;
  readonly parts: Readonly<Partial<Record<SpamPolicyPart, SpamPolicyPartState>>>;
  readonly reason?: string;
}

/** Everything the group holds but its id: a commit must state every field (settings-group.ts). */
function completeGroup(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { id: _id, ...fields } = row;
  return fields;
}

async function applyDmarcEnforcement(opts: StalwartOpts): Promise<SpamPolicyPartState> {
  const current = await senderAuthGet(opts);
  if (current && sameExpression(current.dmarcVerify, DMARC_VERIFY_STRICT)) return 'in-sync';
  const result = await commitSettingsGroup({
    read: () => senderAuthGet(opts),
    write: (patch) => senderAuthUpdate({ patch, ...opts }),
    patch: { ...completeGroup(current ?? {}), dmarcVerify: DMARC_VERIFY_STRICT },
    // A by-id read answers with the defaults while the group is unwritten, so
    // `current` is only null on a malformed reply; the primer covers that.
    primer: { dmarcVerify: DMARC_VERIFY_STRICT },
    verify: (row) => sameExpression(row.dmarcVerify, DMARC_VERIFY_STRICT),
    current,
  });
  return result.state;
}

async function applyThresholds(t: SpamThresholds, opts: StalwartOpts): Promise<SpamPolicyPartState> {
  // Stalwart's "off" for the refuse threshold is 0.
  const scoreReject = t.reject ?? 0;
  const matches = (row: { scoreSpam?: number; scoreReject?: number }) =>
    sameScore(row.scoreSpam, t.junk) && sameScore(row.scoreReject ?? 0, scoreReject);
  const current = await spamSettingsGet(opts);
  if (current && matches(current)) return 'in-sync';
  const result = await commitSettingsGroup({
    read: () => spamSettingsGet(opts),
    write: (patch) => spamSettingsUpdate({ patch, ...opts }),
    patch: { ...completeGroup(current ?? {}), scoreSpam: t.junk, scoreReject },
    primer: { scoreSpam: t.junk },
    verify: matches,
    current,
  });
  return result.state;
}

async function applyQuarantineScore(t: SpamThresholds, opts: StalwartOpts): Promise<SpamPolicyPartState> {
  const score = dmarcQuarantineScore(t);
  const tag = await spamTagFind({ tag: DMARC_QUARANTINE_TAG, ...opts });
  if (!tag) {
    // No rules downloaded yet (or never): create it. A later rule download
    // keeps an existing tag, so this score stays.
    const res = await spamTagSet({ create: { q: { '@type': 'Score', tag: DMARC_QUARANTINE_TAG, score } }, ...opts });
    return res.created && 'q' in res.created ? 'committed' : 'rejected';
  }
  if (tag['@type'] !== undefined && tag['@type'] !== 'Score') return 'kept';
  if (sameScore(tag.score, score)) return 'in-sync';
  const res = await spamTagSet({ update: { [tag.id]: { score } }, ...opts });
  if (res.notUpdated && Object.keys(res.notUpdated).length > 0) return 'rejected';
  const after = await spamTagFind({ tag: DMARC_QUARANTINE_TAG, ...opts });
  return after && sameScore(after.score, score) ? 'committed' : 'not-stored';
}

/** Advisory-lock key serializing every apply, across replicas ('SPAM'). */
const APPLY_LOCK_KEY = 0x5350414d;

/**
 * Push DMARC enforcement and the configured thresholds into Stalwart. Never
 * throws: the outcome is returned and logged, so a save or a tick cannot fail
 * on it.
 *
 * Serialized cluster-wide like mail-ban-expiry: a save applies at once on the
 * replica that took it while the tick runs on another, and a tick that read
 * the thresholds just before the save could otherwise write the OLD ones right
 * after. Under the lock the second caller re-reads both sides.
 */
export async function ensureSpamPolicy(
  db: Database,
  logger: SpamPolicyLogger,
  opts: StalwartOpts = {},
): Promise<SpamPolicyResult> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${APPLY_LOCK_KEY})`);
      return applySpamPolicy(db, logger, opts);
    });
  } catch (err) {
    logger.warn({ err }, 'spam policy: could not take the apply lock — retried on the next tick');
    return { state: 'skipped', thresholds: null, parts: {}, reason: 'database unavailable' };
  }
}

async function applySpamPolicy(db: Database, logger: SpamPolicyLogger, opts: StalwartOpts): Promise<SpamPolicyResult> {
  let thresholds: SpamThresholds;
  try {
    thresholds = await getSpamThresholds(db);
  } catch (err) {
    logger.warn({ err }, 'spam policy: could not read the thresholds — leaving Stalwart untouched');
    return { state: 'skipped', thresholds: null, parts: {}, reason: 'setting unreadable' };
  }

  const steps: ReadonlyArray<readonly [SpamPolicyPart, () => Promise<SpamPolicyPartState>]> = [
    ['dmarc', () => applyDmarcEnforcement(opts)],
    ['thresholds', () => applyThresholds(thresholds, opts)],
    ['quarantine', () => applyQuarantineScore(thresholds, opts)],
  ];
  const parts: Partial<Record<SpamPolicyPart, SpamPolicyPartState>> = {};
  let unreachable: unknown;
  for (const [part, run] of steps) {
    try {
      parts[part] = await run();
    } catch (err) {
      unreachable = err;
      break;
    }
  }

  const states = Object.values(parts);
  if (states.includes('committed')) {
    // Stalwart builds its configuration from these groups; without the reload
    // the running server keeps the old values until its next restart.
    try {
      await actionReloadSettings(opts);
    } catch (err) {
      logger.error({ err, parts }, 'spam policy: stored, but ReloadSettings failed — applies from the next Stalwart restart');
    }
  }
  for (const [part, state] of Object.entries(parts)) {
    if (state === 'rejected' || state === 'not-stored') {
      logger.error({ part, state }, `spam policy: Stalwart did not store the ${part} setting — retried on the next tick`);
    }
  }

  if (unreachable !== undefined) {
    logger.warn({ err: unreachable, parts }, 'spam policy: Stalwart unreachable — retried on the next tick');
    return states.length === 0
      ? { state: 'skipped', thresholds, parts, reason: 'stalwart unreachable' }
      : { state: 'incomplete', thresholds, parts, reason: 'stalwart unreachable' };
  }
  if (states.some((s) => s === 'rejected' || s === 'not-stored')) {
    return { state: 'incomplete', thresholds, parts };
  }
  if (states.includes('committed')) {
    logger.info(
      { parts, thresholds, quarantineScore: dmarcQuarantineScore(thresholds) },
      `spam policy: DMARC enforced (p=reject refused, p=quarantine to Junk); Junk at ${thresholds.junk}, `
        + (thresholds.reject === null ? 'nothing refused on score' : `refused at ${thresholds.reject}`),
    );
    return { state: 'committed', thresholds, parts };
  }
  return { state: 'in-sync', thresholds, parts };
}
