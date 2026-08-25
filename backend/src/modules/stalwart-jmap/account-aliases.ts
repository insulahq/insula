/**
 * Stalwart account-level aliases + send-as identities — the mail-server
 * side of per-mailbox aliases.
 *
 * Verified live against Stalwart v0.16.16 (2026-08-25):
 *   - x:Account `aliases` is an id-keyed MAP of
 *     `{ enabled, name (local part), domainId, description }`. A whole-map
 *     update REPLACES the set atomically; an entry colliding with any
 *     existing address is rejected with `primaryKeyViolation` (naming the
 *     conflicting principal) and the whole patch rolls back.
 *   - Delivery + submission enforcement read the alias set LIVE: an
 *     enabled alias accepts RCPT and authorizes MAIL FROM; disabling it
 *     turns both off (550 / 501). No restart, no reload.
 *   - JMAP Identities are materialized ONCE at the account's first
 *     `Identity/get` and never re-derived — an alias added later does NOT
 *     appear in webmail by itself. The admin credential (role carries
 *     `impersonate`, same power the platform Sieve push uses) can
 *     `Identity/set` create/destroy directly in the user's account, which
 *     is how the platform keeps the webmail From list in step.
 *
 * The platform DB (`mailbox_aliases`) is authoritative. Pushes send the
 * WHOLE desired map derived from the DB rows, so a partial failure or a
 * clobbered entry converges on the next push / boot reconcile. Identities
 * are resolved BY ADDRESS (never by stored id) so restores and rebuilt
 * mail stores self-heal.
 */
import {
  rawStalwartCall,
  JmapError,
  type JmapAccountId,
} from './client.js';

const JMAP_STALWART = 'urn:stalwart:jmap';
const JMAP_SUBMISSION = 'urn:ietf:params:jmap:submission';

export interface DesiredAccountAlias {
  /** Local part of the alias address. */
  readonly localPart: string;
  /** Stalwart id of the parent domain (email_domains.stalwartDomainId). */
  readonly stalwartDomainId: string;
  readonly enabled: boolean;
}

export interface StalwartAccountAliasEntry {
  readonly enabled: boolean;
  readonly name: string;
  readonly domainId: string;
}

interface AccountGetResponse {
  readonly list?: readonly {
    id: string;
    aliases?: Record<string, { enabled?: boolean; name?: string; domainId?: string }>;
  }[];
}

interface AccountSetResponse {
  readonly updated?: Record<string, unknown>;
  readonly notUpdated?: Record<string, { type: string; description?: string; objectId?: unknown }>;
}

/** Read an account's current alias map (empty array when none / no account). */
export async function getAccountAliases(params: {
  accountId: JmapAccountId;
  /** The USER's Stalwart principal id. */
  principalId: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<readonly StalwartAccountAliasEntry[]> {
  const { accountId, principalId, baseUrl, env } = params;
  const res = await rawStalwartCall<AccountGetResponse>({
    using: [JMAP_STALWART],
    method: 'x:Account/get',
    args: { accountId, ids: [principalId], properties: ['id', 'aliases'] },
    baseUrl,
    env,
  });
  const aliases = res.list?.[0]?.aliases ?? {};
  return Object.values(aliases)
    .filter((a) => typeof a.name === 'string' && typeof a.domainId === 'string')
    .map((a) => ({
      enabled: a.enabled !== false,
      name: (a.name as string).toLowerCase(),
      domainId: a.domainId as string,
    }));
}

/**
 * Replace the account's WHOLE alias map with the desired set. Map keys
 * are positional ("0".."n") — Stalwart keys the entries, the platform
 * compares by (name, domainId, enabled).
 *
 * Throws JmapError on rejection; `primaryKeyViolation` means an entry
 * collides with an existing address somewhere on the server.
 */
export async function setAccountAliases(params: {
  accountId: JmapAccountId;
  /** The USER's Stalwart principal id. */
  principalId: string;
  aliases: readonly DesiredAccountAlias[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { accountId, principalId, aliases, baseUrl, env } = params;
  const map: Record<string, { enabled: boolean; name: string; domainId: string; description: null }> = {};
  aliases.forEach((a, i) => {
    map[String(i)] = {
      enabled: a.enabled,
      name: a.localPart.toLowerCase(),
      domainId: a.stalwartDomainId,
      description: null,
    };
  });
  const res = await rawStalwartCall<AccountSetResponse>({
    using: [JMAP_STALWART],
    method: 'x:Account/set',
    args: { accountId, update: { [principalId]: { aliases: map } } },
    baseUrl,
    env,
  });
  const err = res.notUpdated?.[principalId];
  if (err) {
    throw new JmapError(
      `x:Account/set rejected aliases update: ${err.description ?? err.type}`,
      err.type,
      err,
    );
  }
}

/** True when the live alias set already equals the desired one. */
export function sameAliasSet(
  desired: readonly DesiredAccountAlias[],
  current: readonly StalwartAccountAliasEntry[],
): boolean {
  const key = (name: string, domainId: string, enabled: boolean) =>
    `${name.toLowerCase()}\0${domainId}\0${enabled ? 1 : 0}`;
  const want = new Set(desired.map((d) => key(d.localPart, d.stalwartDomainId, d.enabled)));
  const got = new Set(current.map((c) => key(c.name, c.domainId, c.enabled)));
  if (want.size !== got.size) return false;
  for (const w of want) if (!got.has(w)) return false;
  return true;
}

interface IdentityGetResponse {
  readonly list?: readonly { id: string; email?: string }[];
}

interface IdentitySetResponse {
  readonly created?: Record<string, { id: string } | null>;
  readonly destroyed?: readonly string[];
  readonly notCreated?: Record<string, { type: string; description?: string }>;
  readonly notDestroyed?: Record<string, { type: string; description?: string }>;
}

async function listIdentities(
  principalId: string,
  baseUrl?: string,
  env?: NodeJS.ProcessEnv,
): Promise<readonly { id: string; email: string }[]> {
  const res = await rawStalwartCall<IdentityGetResponse>({
    using: [JMAP_SUBMISSION],
    method: 'Identity/get',
    args: { accountId: principalId, ids: null },
    baseUrl,
    env,
  });
  return (res.list ?? [])
    .filter((i) => typeof i.email === 'string')
    .map((i) => ({ id: i.id, email: (i.email as string).toLowerCase() }));
}

/**
 * Ensure the user's account has a send-as Identity for `address`
 * (idempotent: no-op when one already exists — including the ones
 * Stalwart auto-materialized at first Identity/get).
 */
export async function ensureIdentityForAddress(params: {
  /** The USER's Stalwart principal id. */
  principalId: string;
  address: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { principalId, baseUrl, env } = params;
  const address = params.address.toLowerCase();
  const existing = await listIdentities(principalId, baseUrl, env);
  if (existing.some((i) => i.email === address)) return;
  const res = await rawStalwartCall<IdentitySetResponse>({
    using: [JMAP_SUBMISSION],
    method: 'Identity/set',
    args: {
      accountId: principalId,
      create: { i1: { email: address, name: address } },
    },
    baseUrl,
    env,
  });
  const err = res.notCreated?.['i1'];
  if (err) {
    throw new JmapError(
      `Identity/set rejected create for ${address}: ${err.description ?? err.type}`,
      err.type,
      err,
    );
  }
}

/**
 * Batched identity convergence for one account (reconcile path): ONE
 * Identity/get, then a single Identity/set creating what's missing from
 * `wantAddresses` and destroying every identity matching `dropAddresses`.
 * Returns the number of creates + destroys applied.
 */
export async function reconcileIdentitiesForAccount(params: {
  /** The USER's Stalwart principal id. */
  principalId: string;
  wantAddresses: readonly string[];
  dropAddresses: readonly string[];
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ created: number; destroyed: number }> {
  const { principalId, baseUrl, env } = params;
  const want = [...new Set(params.wantAddresses.map((a) => a.toLowerCase()))];
  const drop = new Set(params.dropAddresses.map((a) => a.toLowerCase()));
  const existing = await listIdentities(principalId, baseUrl, env);
  const have = new Set(existing.map((i) => i.email));

  const create: Record<string, { email: string; name: string }> = {};
  want.filter((a) => !have.has(a)).forEach((a, i) => {
    create[`i${i}`] = { email: a, name: a };
  });
  const destroy = existing.filter((i) => drop.has(i.email)).map((i) => i.id);

  if (Object.keys(create).length === 0 && destroy.length === 0) {
    return { created: 0, destroyed: 0 };
  }
  const res = await rawStalwartCall<IdentitySetResponse>({
    using: [JMAP_SUBMISSION],
    method: 'Identity/set',
    args: {
      accountId: principalId,
      ...(Object.keys(create).length > 0 ? { create } : {}),
      ...(destroy.length > 0 ? { destroy } : {}),
    },
    baseUrl,
    env,
  });
  const createErr = res.notCreated && Object.values(res.notCreated)[0];
  const destroyErr = res.notDestroyed && Object.values(res.notDestroyed)[0];
  const err = createErr ?? (destroyErr && destroyErr.type !== 'notFound' ? destroyErr : null);
  if (err) {
    throw new JmapError(
      `Identity/set rejected reconcile: ${err.description ?? err.type}`,
      err.type,
      err,
    );
  }
  return {
    created: Object.keys(res.created ?? {}).length,
    destroyed: (res.destroyed ?? []).length,
  };
}

/**
 * Destroy every Identity in the user's account matching `address`
 * (disable/delete path — a lingering identity would show an unusable
 * From option in webmail). Idempotent: none found = success.
 */
export async function destroyIdentitiesForAddress(params: {
  /** The USER's Stalwart principal id. */
  principalId: string;
  address: string;
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { principalId, baseUrl, env } = params;
  const address = params.address.toLowerCase();
  const existing = await listIdentities(principalId, baseUrl, env);
  const ids = existing.filter((i) => i.email === address).map((i) => i.id);
  if (ids.length === 0) return;
  const res = await rawStalwartCall<IdentitySetResponse>({
    using: [JMAP_SUBMISSION],
    method: 'Identity/set',
    args: { accountId: principalId, destroy: ids },
    baseUrl,
    env,
  });
  const err = res.notDestroyed && Object.values(res.notDestroyed)[0];
  if (err && err.type !== 'notFound') {
    throw new JmapError(
      `Identity/set rejected destroy for ${address}: ${err.description ?? err.type}`,
      err.type,
      err,
    );
  }
}
