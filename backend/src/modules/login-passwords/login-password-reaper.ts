/**
 * Delete the login passwords (Stalwart app passwords) that have expired.
 *
 * Stalwart refuses an expired app password but never deletes it. Two kinds
 * expire:
 *   - one a user or an admin gave an expiry date;
 *   - the app password Bulwark (1.11.1+) signs a panel "Open webmail" in with,
 *     `Support session <jti>`, 8 hours. Bulwark deletes it only when the user
 *     clicks Sign out, so every session that was simply closed, or left to
 *     run out, stayed.
 * Both stayed on the mailbox for good: in the panels' login-password list, and
 * in Bulwark's own Settings → App passwords, where the mailbox owner reads
 * "Support session …" as support having opened their mail.
 *
 * Hourly, on one replica. A password is deleted only GRACE_MS after it
 * expired, so a pod clock slightly ahead of Stalwart's never cuts one short.
 * One `x:AppPassword/get` per provisioned mailbox, and a destroy only where an
 * expired password exists. A login password with no expiry is never touched.
 */
import { isNotNull } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { mailboxes } from '../../db/schema.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { mailLogger } from '../../shared/mail-logger.js';
import { appPasswordGet, appPasswordSet, JmapError } from '../stalwart-jmap/client.js';
import { isExpiredLoginPassword } from './service.js';

export const REAPER_TICK_MS = 60 * 60 * 1000;
const REAPER_INITIAL_DELAY_MS = 10 * 60 * 1000;
export const GRACE_MS = 5 * 60 * 1000;
/**
 * This many mailboxes in a row with no answer from the mail server means it is
 * down: stop instead of asking every other mailbox. An error the server
 * answers with is about one mailbox and does not count.
 */
export const MAX_CONSECUTIVE_FAILURES = 10;

/** JMAP codes for a request that never got a proper answer from the mail server. */
const NO_ANSWER_CODES = new Set(['httpError', 'malformedResponse', 'missingResponse']);

/** True when the error is the mail server's own answer about one mailbox. */
function mailServerAnswered(err: unknown): boolean {
  return err instanceof JmapError && !NO_ANSWER_CODES.has(err.code);
}

export interface ReapResult {
  readonly mailboxesChecked: number;
  readonly passwordsDeleted: number;
  readonly failures: number;
  readonly abandoned: boolean;
  readonly firstError: string | null;
}

export async function reapExpiredLoginPasswords(
  db: Pick<Database, 'select'>,
  now: Date = new Date(),
): Promise<ReapResult> {
  const rows = await db
    .select({ id: mailboxes.id, principalId: mailboxes.stalwartPrincipalId })
    .from(mailboxes)
    .where(isNotNull(mailboxes.stalwartPrincipalId))
    .orderBy(mailboxes.id);

  const baseUrl = process.env.STALWART_MGMT_URL;
  let mailboxesChecked = 0;
  let passwordsDeleted = 0;
  let failures = 0;
  let consecutive = 0;
  let firstError: string | null = null;

  const fail = (mailboxId: string, message: string) => {
    failures += 1;
    firstError ??= `${mailboxId}: ${message}`;
  };

  for (const row of rows) {
    if (consecutive >= MAX_CONSECUTIVE_FAILURES) break;
    const accountId = row.principalId as string;
    try {
      const passwords = await appPasswordGet({ accountId, baseUrl });
      mailboxesChecked += 1;
      consecutive = 0;
      const expired = passwords.filter((p) => isExpiredLoginPassword(p, now, GRACE_MS)).map((p) => p.id);
      if (expired.length === 0) continue;
      const res = await appPasswordSet({ accountId, baseUrl, destroy: expired });
      const gone = expired.filter((id) => (res.destroyed ?? []).includes(id) || res.notDestroyed?.[id]?.type === 'notFound');
      passwordsDeleted += gone.length;
      const kept = expired.filter((id) => !gone.includes(id));
      if (kept.length > 0) {
        fail(row.id, `mail server kept ${kept.length} expired login password(s): ${res.notDestroyed?.[kept[0]]?.type ?? 'unknown'}`);
      }
    } catch (err) {
      fail(row.id, err instanceof Error ? err.message : String(err));
      // A mailbox the mail server answered for — its account gone, say — is
      // that mailbox's problem. Only a server that does not answer stops the run.
      consecutive = mailServerAnswered(err) ? 0 : consecutive + 1;
    }
  }

  return {
    mailboxesChecked,
    passwordsDeleted,
    failures,
    abandoned: consecutive >= MAX_CONSECUTIVE_FAILURES,
    firstError,
  };
}

/** Hourly reaper tick. Returns a stop function for `app.addHook('onClose', …)`. */
export function startLoginPasswordReaper(db: Database): { stop: () => void } {
  const log = mailLogger().child({ module: 'login-password-reaper' });
  let timer: NodeJS.Timeout | null = null;
  const run = () => {
    void withSchedulerLease(db, 'login-password-reaper', REAPER_TICK_MS * 1.5, async () => {
      const r = await reapExpiredLoginPasswords(db);
      // One line per run, never one per mailbox: a mail-server outage must not
      // turn into a log line for every mailbox on the platform.
      if (r.failures > 0) {
        log.warn(r, r.abandoned
          ? 'login-password-reaper: mail server unreachable, run abandoned'
          : 'login-password-reaper: some mailboxes could not be checked');
      } else if (r.passwordsDeleted > 0) {
        log.info(r, 'login-password-reaper: expired login passwords deleted');
      }
    }).catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'login-password-reaper: tick failed');
    });
  };
  const initial = setTimeout(() => {
    run();
    timer = setInterval(run, REAPER_TICK_MS);
  }, REAPER_INITIAL_DELAY_MS);

  return {
    stop: () => {
      clearTimeout(initial);
      if (timer) clearInterval(timer);
    },
  };
}
