/**
 * Login passwords (a.k.a. app passwords) for a mailbox — stateless,
 * backed entirely by Stalwart "AppPassword" registry objects over JMAP.
 *
 * Design (spike-verified 2026-06-07):
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
function toLoginPassword(row: StalwartAppPasswordRow): LoginPassword {
  return {
    id: row.id,
    label: row.description ?? '',
    createdAt: row.createdAt ?? null,
    expiresAt: row.expiresAt ?? null,
    allowedIps: Object.keys(row.allowedIps ?? {}),
  };
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
  return rows.map(toLoginPassword);
}

export async function createLoginPassword(
  db: Database,
  tenantId: string,
  mailboxId: string,
  input: CreateLoginPasswordInput,
): Promise<CreateLoginPasswordResult> {
  const mb = await resolveMailbox(db, tenantId, mailboxId);
  return issueLoginPasswordForPrincipal(mb.stalwartPrincipalId, input);
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
