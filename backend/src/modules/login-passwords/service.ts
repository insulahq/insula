/**
 * Login passwords (a.k.a. app passwords) for a mailbox — stateless,
 * backed entirely by Stalwart "AppPassword" registry objects over JMAP.
 *
 * Design:
 *   - accountId for x:AppPassword/* IS the mailbox's own
 *     stalwart_principal_id (the credential's owner), NOT the
 *     principals-management account. Admin Basic-auth (handled by the
 *     JMAP client) authorizes creating credentials for any account.
 *   - The secret is SERVER-generated and returned exactly once in the
 *     /set `created` entry. We submit NOTHING secret (only label / expiry
 *     / IP scope), so error bodies can't leak a key — no PEM-style
 *     scrubbing needed here.
 *   - No platform DB table: the list is read live from Stalwart.
 */

import { eq, and } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { mailboxes, emailDomains, domains } from '../../db/schema.js';
import {
  appPasswordGet,
  appPasswordSet,
  type JmapAccountId,
  type StalwartAppPasswordRow,
} from '../stalwart-jmap/client.js';
import type {
  CreateLoginPasswordInput,
  CreateLoginPasswordResult,
  LoginPassword,
} from '@insula/api-contracts';
import { MAX_LOGIN_PASSWORDS_PER_MAILBOX, WEBMAIL_SESSION_LABEL_PATTERN } from '@insula/api-contracts';

export class LoginPasswordError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'LoginPasswordError';
  }
}

interface ResolvedMailbox {
  readonly id: string;
  readonly fullAddress: string;
  readonly stalwartPrincipalId: JmapAccountId;
}

/**
 * Resolve a mailbox by id, asserting it belongs to `tenantId` (defence in
 * depth on top of the route's role check) and is provisioned to Stalwart.
 */
async function resolveMailbox(
  db: Database,
  tenantId: string,
  mailboxId: string,
): Promise<ResolvedMailbox> {
  const [row] = await db
    .select({
      id: mailboxes.id,
      fullAddress: mailboxes.fullAddress,
      stalwartPrincipalId: mailboxes.stalwartPrincipalId,
    })
    .from(mailboxes)
    .innerJoin(emailDomains, eq(emailDomains.id, mailboxes.emailDomainId))
    .innerJoin(domains, eq(domains.id, emailDomains.domainId))
    .where(and(eq(mailboxes.id, mailboxId), eq(domains.tenantId, tenantId)));

  if (!row) {
    throw new LoginPasswordError(
      `Mailbox '${mailboxId}' not found for tenant '${tenantId}'`,
      'MAILBOX_NOT_FOUND',
      404,
    );
  }
  if (!row.stalwartPrincipalId) {
    throw new LoginPasswordError(
      `Mailbox '${row.fullAddress}' is not provisioned to the mail server yet`,
      'MAILBOX_NOT_PROVISIONED',
      409,
    );
  }
  return {
    id: row.id,
    fullAddress: row.fullAddress,
    stalwartPrincipalId: row.stalwartPrincipalId as JmapAccountId,
  };
}

/** Map a Stalwart AppPassword row to the platform's metadata shape. */
/** Exported for unit tests. */
export function toLoginPassword(row: StalwartAppPasswordRow): LoginPassword {
  // Bulwark (1.11.1+) signs "Open webmail" in with an app password it creates
  // on the mailbox. The create schema refuses this name, so only Bulwark can
  // have given it.
  const webmailSession = isWebmailSession(row);
  return {
    id: row.id,
    label: webmailSession ? 'Webmail session' : row.description ?? '',
    kind: webmailSession ? 'webmail_session' : 'login',
    createdAt: row.createdAt ?? null,
    expiresAt: row.expiresAt ?? null,
    allowedIps: Object.keys(row.allowedIps ?? {}),
  };
}

/**
 * How long after its expiry a webmail session's app password is deleted, so a
 * pod clock slightly ahead of Stalwart's never cuts a session short.
 */
export const SESSION_EXPIRY_GRACE_MS = 5 * 60 * 1000;

function isWebmailSession(row: StalwartAppPasswordRow): boolean {
  return WEBMAIL_SESSION_LABEL_PATTERN.test(row.description ?? '');
}

/**
 * True for a login password that expired `graceMs` or longer ago — one a user
 * gave an expiry date, or the app password of an "Open webmail" session.
 * Stalwart refuses an expired app password but never deletes it, and Bulwark
 * deletes a session's only when the user clicks Sign out, so an expired one
 * stays on the mailbox until login-password-reaper.ts removes it.
 */
export function isExpiredLoginPassword(row: StalwartAppPasswordRow, now: Date, graceMs = 0): boolean {
  if (!row.expiresAt) return false;
  const expiresAt = Date.parse(row.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt + graceMs <= now.getTime();
}

export async function listLoginPasswords(
  db: Database,
  tenantId: string,
  mailboxId: string,
): Promise<readonly LoginPassword[]> {
  const mb = await resolveMailbox(db, tenantId, mailboxId);
  const rows = await appPasswordGet({
    accountId: mb.stalwartPrincipalId,
    baseUrl: process.env.STALWART_MGMT_URL,
  });
  // An expired login password can no longer sign in, and the reaper deletes it
  // within the hour: don't list it as if it still worked.
  const now = new Date();
  return rows.filter((row) => !isExpiredLoginPassword(row, now)).map(toLoginPassword);
}

export async function createLoginPassword(
  db: Database,
  tenantId: string,
  mailboxId: string,
  input: CreateLoginPasswordInput,
): Promise<CreateLoginPasswordResult> {
  // An expired login password is deleted: one created already expired would
  // show its secret once and be gone within the hour, never having worked.
  if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
    throw new LoginPasswordError('The expiry date must be in the future', 'INVALID_FIELD_VALUE', 400);
  }
  const mb = await resolveMailbox(db, tenantId, mailboxId);
  await assertRoomForLoginPassword(mb.stalwartPrincipalId);
  return issueLoginPasswordForPrincipal(mb.stalwartPrincipalId, input);
}

/**
 * Refuse a login password past MAX_LOGIN_PASSWORDS_PER_MAILBOX. Webmail
 * sessions do not count: the mail server keeps room for them on top
 * (mail-admin/app-password-limit-reconciler.ts). Expired passwords are deleted
 * first — they no longer work and the reaper would delete them within the
 * hour, but the mail server still counts them.
 */
async function assertRoomForLoginPassword(accountId: JmapAccountId): Promise<void> {
  const baseUrl = process.env.STALWART_MGMT_URL;
  const now = new Date();
  const rows = await appPasswordGet({ accountId, baseUrl });
  const expired = rows
    .filter((row) => isExpiredLoginPassword(row, now, isWebmailSession(row) ? SESSION_EXPIRY_GRACE_MS : 0))
    .map((row) => row.id);
  if (expired.length > 0) {
    // Best effort: whatever stays is counted below, and the reaper retries.
    await appPasswordSet({ accountId, baseUrl, destroy: expired }).catch(() => undefined);
  }
  const loginPasswords = rows.filter((row) => !expired.includes(row.id) && !isWebmailSession(row)).length;
  if (loginPasswords >= MAX_LOGIN_PASSWORDS_PER_MAILBOX) {
    throw new LoginPasswordError(
      `This mailbox already has ${MAX_LOGIN_PASSWORDS_PER_MAILBOX} login passwords, the most it can have. Revoke one before creating another.`,
      'LOGIN_PASSWORD_LIMIT',
      409,
    );
  }
}

/**
 * Lower-level issue path: create a login password against a Stalwart
 * principal id directly, skipping mailbox/tenant resolution. Used by the
 * mailbox-create flow (which already holds the freshly-provisioned
 * principal id) to mint the "Initial" login password without a redundant
 * lookup. Callers that take untrusted input MUST resolve+authorize the
 * mailbox first (see createLoginPassword).
 */
export async function issueLoginPasswordForPrincipal(
  stalwartPrincipalId: JmapAccountId,
  input: CreateLoginPasswordInput,
): Promise<CreateLoginPasswordResult> {
  // allowedIps array → Stalwart's IP→true map; [] / undefined = unrestricted.
  const allowedIpsMap: Record<string, boolean> = {};
  for (const ip of input.allowedIps ?? []) allowedIpsMap[ip] = true;

  const tempId = 'n1';
  const res = await appPasswordSet({
    accountId: stalwartPrincipalId,
    baseUrl: process.env.STALWART_MGMT_URL,
    create: {
      [tempId]: {
        description: input.label,
        allowedIps: allowedIpsMap,
        expiresAt: input.expiresAt ?? null,
      },
    },
  });

  const created = res.created?.[tempId];
  if (!created?.secret && res.notCreated?.[tempId]?.type === 'overQuota') {
    // The mail server's own limit, which counts open webmail sessions — and
    // app passwords made in the webmail's settings — beside login passwords.
    throw new LoginPasswordError(
      'This mailbox has no room for another password on the mail server: open webmail sessions count too. Revoke a login password or sign out of webmail, then try again.',
      'LOGIN_PASSWORD_LIMIT',
      409,
    );
  }
  if (!created || !created.secret) {
    // Surface only the JMAP error TYPE to the caller (e.g. "overQuota").
    // The full notCreated body can carry Stalwart-internal detail — log
    // it server-side, don't echo it in the API response.
    const firstError = Object.values(res.notCreated ?? {})[0];
    throw new LoginPasswordError(
      `Mail server rejected the login password (${firstError?.type ?? 'unknown'})`,
      'STALWART_API_ERROR',
      502,
    );
  }

  return {
    id: created.id,
    label: input.label,
    secret: created.secret,
    expiresAt: input.expiresAt ?? null,
    allowedIps: input.allowedIps ?? [],
  };
}

export async function revokeLoginPassword(
  db: Database,
  tenantId: string,
  mailboxId: string,
  credentialId: string,
): Promise<void> {
  const mb = await resolveMailbox(db, tenantId, mailboxId);

  const res = await appPasswordSet({
    accountId: mb.stalwartPrincipalId,
    baseUrl: process.env.STALWART_MGMT_URL,
    destroy: [credentialId],
  });

  if ((res.destroyed ?? []).includes(credentialId)) return;

  // Already gone → treat as success (idempotent revoke). Otherwise surface
  // the rejection.
  const notDestroyed = res.notDestroyed?.[credentialId];
  if (notDestroyed?.type === 'notFound') return;
  throw new LoginPasswordError(
    `Mail server did not revoke login password '${credentialId}': ${notDestroyed?.type ?? 'unknown'}`,
    'STALWART_API_ERROR',
    502,
  );
}
