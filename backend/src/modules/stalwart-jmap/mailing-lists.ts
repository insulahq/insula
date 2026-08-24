/**
 * Stalwart MailingList + domain catch-all helpers — the mail-server side
 * of email aliases (ROADMAP R28 remainder).
 *
 * Verified live against Stalwart v0.16.16 (2026-08-24):
 *   - `x:MailingList/set` create/update/destroy; `recipients` is a MAP of
 *     address → true (string values are rejected with invalidPatch).
 *     Fan-out delivers to every recipient, across local domains; external
 *     recipients ride the normal outbound MTA path.
 *   - The list's own address = `name`@domain(`domainId`) — exactly an
 *     alias: an address with no inbox that delivers to N destinations.
 *   - Catch-all is a DOMAIN-level field: `x:Domain/set` update
 *     `catchAllAddress` (string or null). An account-alias of `*` does
 *     NOT act as catch-all (RCPT-rejected; probed).
 *
 * Platform DB is authoritative: pushes are fail-visible at the API layer
 * and re-converged by the boot reconcile.
 */
import {
  rawStalwartCall,
  JmapError,
  type JmapAccountId,
} from './client.js';

const JMAP_STALWART = 'urn:stalwart:jmap';

interface MailingListSetResponse {
  readonly created?: Record<string, { id: string } | null>;
  readonly updated?: Record<string, unknown>;
  readonly destroyed?: readonly string[];
  readonly notCreated?: Record<string, { type: string; description?: string }>;
  readonly notUpdated?: Record<string, { type: string; description?: string }>;
  readonly notDestroyed?: Record<string, { type: string; description?: string }>;
}

interface MailingListGetResponse {
  readonly list?: readonly {
    id: string;
    name?: string;
    emailAddress?: string;
    recipients?: Record<string, boolean>;
  }[];
}

function recipientsMap(destinations: readonly string[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const d of destinations) map[d] = true;
  return map;
}

function firstError(
  res: MailingListSetResponse,
): { type: string; description?: string } | null {
  for (const bucket of [res.notCreated, res.notUpdated, res.notDestroyed]) {
    const first = bucket && Object.values(bucket)[0];
    if (first) return first;
  }
  return null;
}

/** Create a MailingList for an alias. Returns the Stalwart list id. */
export async function createMailingList(params: {
  accountId: JmapAccountId;
  /** Local part of the alias source address. */
  localPart: string;
  /** Stalwart id of the parent domain (email_domains.stalwartDomainId). */
  stalwartDomainId: string;
  destinations: readonly string[];
  description?: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const { accountId, localPart, stalwartDomainId, destinations, description, baseUrl, env } = params;
  const res = await rawStalwartCall<MailingListSetResponse>({
    using: [JMAP_STALWART],
    method: 'x:MailingList/set',
    args: {
      accountId,
      create: {
        'new-list': {
          name: localPart,
          domainId: stalwartDomainId,
          recipients: recipientsMap(destinations),
          ...(description ? { description } : {}),
        },
      },
    },
    baseUrl,
    env,
  });
  const err = firstError(res);
  if (err) {
    throw new JmapError(
      `x:MailingList/set rejected create: ${err.description ?? err.type}`,
      err.type,
      err,
    );
  }
  const id = res.created?.['new-list']?.id;
  if (!id) {
    throw new JmapError('x:MailingList/set returned no id for created list', 'missingResult', res);
  }
  return id;
}

/** Replace a list's recipients (whole-map update). */
export async function updateMailingListRecipients(params: {
  accountId: JmapAccountId;
  listId: string;
  destinations: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { accountId, listId, destinations, baseUrl, env } = params;
  const res = await rawStalwartCall<MailingListSetResponse>({
    using: [JMAP_STALWART],
    method: 'x:MailingList/set',
    args: {
      accountId,
      update: { [listId]: { recipients: recipientsMap(destinations) } },
    },
    baseUrl,
    env,
  });
  const err = firstError(res);
  if (err) {
    throw new JmapError(
      `x:MailingList/set rejected update: ${err.description ?? err.type}`,
      err.type,
      err,
    );
  }
}

/** Destroy a list. `notFound`/already-gone is treated as success. */
export async function destroyMailingList(params: {
  accountId: JmapAccountId;
  listId: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { accountId, listId, baseUrl, env } = params;
  const res = await rawStalwartCall<MailingListSetResponse>({
    using: [JMAP_STALWART],
    method: 'x:MailingList/set',
    args: { accountId, destroy: [listId] },
    baseUrl,
    env,
  });
  const err = firstError(res);
  if (err && err.type !== 'notFound') {
    throw new JmapError(
      `x:MailingList/set rejected destroy: ${err.description ?? err.type}`,
      err.type,
      err,
    );
  }
}

/** List every MailingList (id + address) — used by the boot reconcile. */
export async function listMailingLists(params: {
  accountId: JmapAccountId;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ReadonlyArray<{ id: string; emailAddress: string; recipients: Record<string, boolean> }>> {
  const { accountId, baseUrl, env } = params;
  const res = await rawStalwartCall<MailingListGetResponse>({
    using: [JMAP_STALWART],
    method: 'x:MailingList/get',
    args: { accountId, ids: null },
    baseUrl,
    env,
  });
  return (res.list ?? [])
    .filter((l) => typeof l.emailAddress === 'string')
    .map((l) => ({
      id: l.id,
      emailAddress: (l.emailAddress as string).toLowerCase(),
      recipients: l.recipients ?? {},
    }));
}

/**
 * Push a domain's catch-all target (null clears it). The DB value on
 * `email_domains.catch_all_address` is authoritative.
 */
export async function setDomainCatchAll(params: {
  accountId: JmapAccountId;
  stalwartDomainId: string;
  catchAllAddress: string | null;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { accountId, stalwartDomainId, catchAllAddress, baseUrl, env } = params;
  const res = await rawStalwartCall<MailingListSetResponse>({
    using: [JMAP_STALWART],
    method: 'x:Domain/set',
    args: {
      accountId,
      update: { [stalwartDomainId]: { catchAllAddress } },
    },
    baseUrl,
    env,
  });
  const err = firstError(res);
  if (err) {
    throw new JmapError(
      `x:Domain/set rejected catchAllAddress update: ${err.description ?? err.type}`,
      err.type,
      err,
    );
  }
}
