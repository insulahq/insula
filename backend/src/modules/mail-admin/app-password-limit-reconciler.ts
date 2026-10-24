/**
 * Keeps Stalwart's per-account app-password limit (`x:Authentication.maxAppPasswords`)
 * at MAIL_SERVER_APP_PASSWORD_LIMIT or above.
 *
 * Why: a mailbox's login passwords are Stalwart app passwords, and so is every
 * "Open webmail" session (Bulwark signs in with an 8-hour app password it
 * creates on the mailbox). Stalwart's default limit is 5 per account, expired
 * ones included. With the "Initial" password and a few sessions a mailbox hit
 * it: "Open webmail" failed and a new login password was refused with
 * "overQuota". The platform lets a mailbox hold MAX_LOGIN_PASSWORDS_PER_MAILBOX
 * login passwords (login-passwords/service.ts) and keeps WEBMAIL_SESSION_SLOTS
 * more free on the mail server, so a session still opens on a full mailbox.
 *
 * Only raises: a lower limit is set to MAIL_SERVER_APP_PASSWORD_LIMIT, while a
 * higher one, or none (Stalwart then allows any number), is the operator's and
 * stays. Safe on every replica: the write is idempotent and only happens when
 * the value is too low. The settings reload applies it without a restart.
 */

import { MAIL_SERVER_APP_PASSWORD_LIMIT } from '@insula/api-contracts';
import { mailLogger } from '../../shared/mail-logger.js';
import { safeTick } from '../../shared/safe-tick.js';
import { JmapError } from '../stalwart-jmap/client.js';
import { resolveTransport, type ImapConcurrencyDeps, type ResolvedTransport } from './imap-concurrency.js';

const log = mailLogger().child({ module: 'mail-admin-app-password-limit' });

const JMAP_CORE = 'urn:ietf:params:jmap:core';
const JMAP_STALWART = 'urn:stalwart:jmap';
/** Stalwart admin account ID — fixed constant, matches bootstrap.sh. */
const ADMIN_ACCOUNT_ID = 'd333333';

export const APP_PASSWORD_LIMIT_RECONCILER_TICK_MS = 10 * 60 * 1000;

export type AppPasswordLimitReconcilerDeps = ImapConcurrencyDeps;

export interface AppPasswordLimitTickResult {
  readonly outcome: 'updated' | 'unchanged';
  /** The limit Stalwart had; null when it had none (no limit). */
  readonly prior: number | null;
  readonly current: number | null;
  /** Whether Stalwart confirmed the ReloadSettings action (else: next restart). */
  readonly reloaded: boolean;
}

/** One tick. Exported for tests; throws on a malformed Stalwart answer (safeTick logs it). */
export async function runAppPasswordLimitReconcilerTick(
  deps: AppPasswordLimitReconcilerDeps = {},
  minimum: number = MAIL_SERVER_APP_PASSWORD_LIMIT,
): Promise<AppPasswordLimitTickResult> {
  const t = await resolveTransport(deps);
  const prior = await readLimit(t);
  if (prior === null || prior >= minimum) return { outcome: 'unchanged', prior, current: prior, reloaded: false };

  const res = await t.jmapPost(t.authHeader, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:Authentication/set', { accountId: ADMIN_ACCOUNT_ID, update: { singleton: { maxAppPasswords: minimum } } }, 's'],
      // The per-account object limits are read from the settings when the core
      // is built, so a settings reload applies the change at once.
      ['x:Action/set', { accountId: ADMIN_ACCOUNT_ID, create: { r: { '@type': 'ReloadSettings' } } }, 'r'],
    ],
  });
  const setArgs = res.methodResponses.find((m) => m[2] === 's')?.[1] as { updated?: Record<string, unknown> } | undefined;
  if (!setArgs?.updated || !('singleton' in setArgs.updated)) {
    throw new JmapError('x:Authentication/set did not update the singleton', 'malformedResponse', res.methodResponses);
  }
  const reloadArgs = res.methodResponses.find((m) => m[2] === 'r')?.[1] as
    { created?: Record<string, unknown>; notCreated?: Record<string, unknown> | null } | undefined;
  const reloaded = Boolean(reloadArgs?.created && 'r' in reloadArgs.created);
  if (reloaded) {
    log.info({ prior, current: minimum }, `Stalwart app passwords per account ${prior} → ${minimum}`);
  } else {
    log.warn({ prior, current: minimum, reload: reloadArgs ?? null },
      `Stalwart app passwords per account set ${prior} → ${minimum}, but ReloadSettings did not run — it applies at the next Stalwart restart`);
  }
  return { outcome: 'updated', prior, current: minimum, reloaded };
}

/** The live limit, or null when Stalwart has none. */
async function readLimit(t: ResolvedTransport): Promise<number | null> {
  const res = await t.jmapPost(t.authHeader, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [['x:Authentication/get', { accountId: ADMIN_ACCOUNT_ID, ids: ['singleton'] }, 'g']],
  });
  const list = (res.methodResponses[0]?.[1] as { list?: unknown })?.list;
  const singleton = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined;
  if (!singleton) {
    throw new JmapError('x:Authentication/get returned no singleton — Stalwart bootstrap may not be complete',
      'malformedResponse', res.methodResponses);
  }
  const raw = singleton.maxAppPasswords;
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number') {
    throw new JmapError('x:Authentication/get returned a maxAppPasswords that is not a number', 'malformedResponse', res.methodResponses);
  }
  return raw;
}

/** Start the reconciler: one tick now, then every 10 minutes. Returns a stop function. */
export function startAppPasswordLimitReconciler(
  deps: AppPasswordLimitReconcilerDeps = {},
  tickMs: number = APP_PASSWORD_LIMIT_RECONCILER_TICK_MS,
): () => void {
  const tick = async (): Promise<void> => { await runAppPasswordLimitReconcilerTick(deps); };
  safeTick('app-password-limit-reconciler', tick, log);
  const timer = setInterval(() => safeTick('app-password-limit-reconciler', tick, log), tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
