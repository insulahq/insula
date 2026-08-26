/**
 * Per-mailbox aliases — alternate receive+send-as addresses attached to
 * an existing mailbox (operator request 2026-08-25; spike-verified the
 * same day, see stalwart-jmap/account-aliases.ts for the server facts).
 *
 * Distinct from email-aliases (MailingList-backed forwarding addresses):
 * a mailbox alias delivers into its mailbox AND lets the mailbox send AS
 * the alias (server-enforced; webmail picks it up via a platform-pushed
 * JMAP Identity). Aliases do not count against any plan quota.
 *
 * Push model: the mailbox's Stalwart account carries its aliases as one
 * id-keyed map, so every change pushes the WHOLE desired map derived
 * from the DB rows (fail-visible on create/enable/disable; best-effort
 * on delete — the periodic reconcile hard-converges the map, so a
 * leftover entry is swept, not stranded). Same-domain only in v1: the
 * alias dies with its account at domain teardown, no cross-domain
 * unlink ordering to get wrong.
 */
import { eq, and } from 'drizzle-orm';
import { mailboxAliases, mailboxes, emailAliases, emailDomains, domains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { mailLogger } from '../../shared/mail-logger.js';
import { getCachedPrincipalsAccountId, JmapError } from '../stalwart-jmap/client.js';
import {
  setAccountAliases,
  ensureIdentityForAddress,
  destroyIdentitiesForAddress,
  type DesiredAccountAlias,
} from '../stalwart-jmap/account-aliases.js';
import type { Database } from '../../db/index.js';
import type { CreateMailboxAliasInput, UpdateMailboxAliasInput } from '@insula/api-contracts';

const log = mailLogger().child({ module: 'mailbox-aliases' });

function aliasNotFound(id: string): ApiError {
  return new ApiError('MAILBOX_ALIAS_NOT_FOUND', `Mailbox alias '${id}' not found`, 404);
}

// Cap mirrors the mailing-list destination cap (20): every mutation
// re-pushes the account's whole alias map and the periodic sweep loads
// all rows, so an unbounded count is a shared-resource abuse vector
// (security review 2026-08-25). Not a plan quota — a fixed sanity bound.
export const MAX_ALIASES_PER_MAILBOX = 20;

function mailServerError(op: string, err: unknown): ApiError {
  if (err instanceof JmapError && err.code === 'primaryKeyViolation') {
    return new ApiError(
      'DUPLICATE_ENTRY',
      'This address is already in use on the mail server',
      409,
      {},
      'Use a different alias name',
    );
  }
  return new ApiError(
    'MAIL_SERVER_ERROR',
    `Mailbox alias ${op} failed at the mail server: ${err instanceof Error ? err.message : String(err)}`,
    502,
    {},
    'Check Stalwart JMAP API reachability and logs, then retry',
  );
}

// Serialize alias pushes per mailbox: each push writes the WHOLE map, so
// two concurrent edits in the same process could clobber each other's
// entry. Cross-replica races are left to the periodic reconcile.
const mailboxLocks = new Map<string, Promise<unknown>>();
async function withMailboxLock<T>(mailboxId: string, fn: () => Promise<T>): Promise<T> {
  const previous = mailboxLocks.get(mailboxId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.catch(() => undefined);
  mailboxLocks.set(mailboxId, settled);
  try {
    return await run;
  } finally {
    if (mailboxLocks.get(mailboxId) === settled) mailboxLocks.delete(mailboxId);
  }
}

interface MailboxContext {
  readonly mailbox: typeof mailboxes.$inferSelect;
  readonly emailDomain: typeof emailDomains.$inferSelect;
  readonly domainName: string;
}

async function loadMailboxContext(
  db: Database,
  tenantId: string,
  mailboxId: string,
): Promise<MailboxContext> {
  const [mailbox] = await db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.tenantId, tenantId)));
  if (!mailbox) {
    throw new ApiError('MAILBOX_NOT_FOUND', `Mailbox '${mailboxId}' not found`, 404);
  }
  const [emailDomain] = await db
    .select()
    .from(emailDomains)
    .where(eq(emailDomains.id, mailbox.emailDomainId));
  if (!emailDomain) {
    throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', 'Email domain for mailbox not found', 404);
  }
  const [domain] = await db
    .select({ domainName: domains.domainName })
    .from(domains)
    .where(eq(domains.id, emailDomain.domainId));
  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', 'Parent domain not found for email domain', 404);
  }
  return { mailbox, emailDomain, domainName: domain.domainName.toLowerCase() };
}

/**
 * Desired Stalwart alias map for a mailbox = ALL its DB rows, disabled
 * ones included with `enabled:false` (the entry reserves the address
 * server-side and Stalwart enforces the off state for both directions).
 * A disabled/suspended mailbox forces EVERY entry off — suspension
 * disables incoming and outgoing mail for the aliases too (operator
 * decision 2026-08-26); the rows keep the tenant's intent for
 * reactivation. Every push path derives the map through this one
 * function so the shape can never diverge between
 * create/update/delete/reconcile/lifecycle.
 */
export async function desiredAliasesForMailbox(
  db: Database,
  mailboxId: string,
  stalwartDomainId: string,
  /** `mailboxes.status === 'active'` for the owning mailbox. */
  mailboxActive: boolean,
): Promise<DesiredAccountAlias[]> {
  const rows = await db
    .select()
    .from(mailboxAliases)
    .where(eq(mailboxAliases.mailboxId, mailboxId));
  return rows.map((r) => ({
    localPart: r.localPart,
    stalwartDomainId,
    enabled: mailboxActive && r.enabled === 1,
  }));
}

/**
 * Cross-table address availability: mailboxes, mailing-list aliases and
 * mailbox aliases all occupy one namespace on the mail server. Stalwart's
 * primaryKeyViolation is the backstop; these checks give clean 409s.
 */
async function assertAddressAvailable(db: Database, fullAddress: string): Promise<void> {
  const [asMailbox] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.fullAddress, fullAddress));
  if (asMailbox) {
    throw new ApiError('DUPLICATE_ENTRY', `Address '${fullAddress}' is already used by a mailbox`, 409);
  }
  const [asListAlias] = await db
    .select({ id: emailAliases.id })
    .from(emailAliases)
    .where(eq(emailAliases.sourceAddress, fullAddress));
  if (asListAlias) {
    throw new ApiError('DUPLICATE_ENTRY', `Address '${fullAddress}' is already used by a mailing list`, 409);
  }
  const [asAlias] = await db
    .select({ id: mailboxAliases.id })
    .from(mailboxAliases)
    .where(eq(mailboxAliases.fullAddress, fullAddress));
  if (asAlias) {
    throw new ApiError('DUPLICATE_ENTRY', `Alias '${fullAddress}' already exists`, 409);
  }
}

export async function createMailboxAlias(
  db: Database,
  tenantId: string,
  mailboxId: string,
  input: CreateMailboxAliasInput,
) {
  return withMailboxLock(mailboxId, async () => {
    const { mailbox, emailDomain, domainName } = await loadMailboxContext(db, tenantId, mailboxId);
    const localPart = input.local_part.toLowerCase();
    const fullAddress = `${localPart}@${domainName}`;

    const existing = await db
      .select({ id: mailboxAliases.id })
      .from(mailboxAliases)
      .where(eq(mailboxAliases.mailboxId, mailboxId));
    if (existing.length >= MAX_ALIASES_PER_MAILBOX) {
      throw new ApiError(
        'MAILBOX_ALIAS_LIMIT_REACHED',
        `A mailbox can carry at most ${MAX_ALIASES_PER_MAILBOX} aliases`,
        409,
        { limit: MAX_ALIASES_PER_MAILBOX, current: existing.length },
        'Remove an unused alias first',
      );
    }

    await assertAddressAvailable(db, fullAddress);

    // Push the whole desired map (existing enabled rows + the new alias)
    // FIRST — fail-visible, mirroring the mailing-list create. A mailbox
    // not provisioned to Stalwart yet stores the row unprovisioned; the
    // reconcile converges once principals-sync backfills the principal.
    const accountId = await getCachedPrincipalsAccountId();
    const canPush = Boolean(accountId && mailbox.stalwartPrincipalId && emailDomain.stalwartDomainId);
    const mailboxActive = mailbox.status === 'active';
    if (canPush) {
      const desired = await desiredAliasesForMailbox(db, mailboxId, emailDomain.stalwartDomainId as string, mailboxActive);
      // On a disabled/suspended mailbox the new entry is pushed OFF (and
      // no identity is created) — the row records intent; reactivation
      // turns it on.
      desired.push({ localPart, stalwartDomainId: emailDomain.stalwartDomainId as string, enabled: mailboxActive });
      try {
        await setAccountAliases({
          accountId: accountId as string,
          principalId: mailbox.stalwartPrincipalId as string,
          aliases: desired,
        });
        if (mailboxActive) {
          await ensureIdentityForAddress({
            principalId: mailbox.stalwartPrincipalId as string,
            address: fullAddress,
          });
        }
      } catch (err) {
        // Compensating re-push without the new alias — no live address
        // without a platform row (identity removal rides best-effort).
        const rollback = await desiredAliasesForMailbox(db, mailboxId, emailDomain.stalwartDomainId as string, mailbox.status === 'active');
        await setAccountAliases({
          accountId: accountId as string,
          principalId: mailbox.stalwartPrincipalId as string,
          aliases: rollback,
        }).catch(() => undefined);
        await destroyIdentitiesForAddress({
          principalId: mailbox.stalwartPrincipalId as string,
          address: fullAddress,
        }).catch(() => undefined);
        throw mailServerError('provisioning', err);
      }
    } else {
      log.warn({ mailboxId, fullAddress },
        'createMailboxAlias: mailbox/domain not provisioned to Stalwart yet — alias stored unprovisioned (reconcile converges)');
    }

    const id = crypto.randomUUID();
    try {
      await db.insert(mailboxAliases).values({
        id,
        mailboxId,
        emailDomainId: mailbox.emailDomainId,
        tenantId,
        localPart,
        fullAddress,
        enabled: 1,
      });
    } catch (dbErr) {
      if (canPush) {
        const rollback = await desiredAliasesForMailbox(db, mailboxId, emailDomain.stalwartDomainId as string, mailbox.status === 'active');
        await setAccountAliases({
          accountId: accountId as string,
          principalId: mailbox.stalwartPrincipalId as string,
          aliases: rollback,
        }).catch((cleanupErr) => {
          log.warn({ fullAddress, err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) },
            'compensating alias-map re-push failed for orphan alias entry (reconcile sweeps)');
        });
        await destroyIdentitiesForAddress({
          principalId: mailbox.stalwartPrincipalId as string,
          address: fullAddress,
        }).catch(() => undefined);
      }
      throw dbErr;
    }

    const [created] = await db.select().from(mailboxAliases).where(eq(mailboxAliases.id, id));
    return created;
  });
}

export async function listMailboxAliases(
  db: Database,
  tenantId: string,
  filters: { mailboxId?: string; emailDomainId?: string } = {},
) {
  const conditions = [eq(mailboxAliases.tenantId, tenantId)];
  if (filters.mailboxId) conditions.push(eq(mailboxAliases.mailboxId, filters.mailboxId));
  if (filters.emailDomainId) conditions.push(eq(mailboxAliases.emailDomainId, filters.emailDomainId));
  return db.select().from(mailboxAliases).where(and(...conditions));
}

export async function updateMailboxAlias(
  db: Database,
  tenantId: string,
  aliasId: string,
  input: UpdateMailboxAliasInput,
) {
  // Pre-lock read resolves the mailboxId for the lock key only.
  const [preLock] = await db
    .select({ id: mailboxAliases.id, mailboxId: mailboxAliases.mailboxId })
    .from(mailboxAliases)
    .where(and(eq(mailboxAliases.id, aliasId), eq(mailboxAliases.tenantId, tenantId)));
  if (!preLock) throw aliasNotFound(aliasId);

  return withMailboxLock(preLock.mailboxId, async () => {
    // Re-read INSIDE the lock — a concurrent PATCH that queued ahead of
    // this one may have flipped the row already, and a no-op decision
    // against the stale pre-lock snapshot would silently skip the push
    // (review 2026-08-25 HIGH).
    const [alias] = await db
      .select()
      .from(mailboxAliases)
      .where(and(eq(mailboxAliases.id, aliasId), eq(mailboxAliases.tenantId, tenantId)));
    if (!alias) throw aliasNotFound(aliasId);
    const desiredEnabled = input.enabled;
    if ((alias.enabled === 1) === desiredEnabled) {
      return alias; // no-op
    }

    const { mailbox, emailDomain } = await loadMailboxContext(db, tenantId, alias.mailboxId);
    const accountId = await getCachedPrincipalsAccountId();
    const canPush = Boolean(accountId && mailbox.stalwartPrincipalId && emailDomain.stalwartDomainId);

    const mailboxActive = mailbox.status === 'active';
    if (canPush) {
      // Whole desired map with this row's entry flipped. On a disabled/
      // suspended mailbox the SERVER entry stays off regardless of the
      // requested flag (the DB row records intent for reactivation).
      const effectiveEnabled = desiredEnabled && mailboxActive;
      const desired: DesiredAccountAlias[] = (
        await desiredAliasesForMailbox(db, alias.mailboxId, emailDomain.stalwartDomainId as string, mailboxActive)
      ).map((d) =>
        d.localPart === alias.localPart ? { ...d, enabled: effectiveEnabled } : d,
      );
      try {
        await setAccountAliases({
          accountId: accountId as string,
          principalId: mailbox.stalwartPrincipalId as string,
          aliases: desired,
        });
        if (effectiveEnabled) {
          await ensureIdentityForAddress({
            principalId: mailbox.stalwartPrincipalId as string,
            address: alias.fullAddress,
          });
        } else {
          // A lingering identity would offer an unusable From option in
          // webmail (submission rejects it) — remove it with the alias.
          await destroyIdentitiesForAddress({
            principalId: mailbox.stalwartPrincipalId as string,
            address: alias.fullAddress,
          });
        }
      } catch (err) {
        throw mailServerError('update', err);
      }
    }

    await db
      .update(mailboxAliases)
      .set({ enabled: desiredEnabled ? 1 : 0 })
      .where(eq(mailboxAliases.id, aliasId));

    const [updated] = await db.select().from(mailboxAliases).where(eq(mailboxAliases.id, aliasId));
    return updated;
  });
}

export async function deleteMailboxAlias(db: Database, tenantId: string, aliasId: string) {
  const [alias] = await db
    .select()
    .from(mailboxAliases)
    .where(and(eq(mailboxAliases.id, aliasId), eq(mailboxAliases.tenantId, tenantId)));
  if (!alias) throw aliasNotFound(aliasId);

  return withMailboxLock(alias.mailboxId, async () => {
    // Best-effort push of the map without this alias (+ identity destroy) —
    // mirrors deleteMailbox/deleteAlias. A transient failure here leaves an
    // entry the periodic reconcile removes on its next sweep (whole-map
    // convergence), so nothing is stranded invisibly.
    const [mailbox] = await db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.id, alias.mailboxId));
    const [emailDomain] = mailbox
      ? await db.select().from(emailDomains).where(eq(emailDomains.id, mailbox.emailDomainId))
      : [undefined];
    const accountId = await getCachedPrincipalsAccountId();
    if (accountId && mailbox?.stalwartPrincipalId && emailDomain?.stalwartDomainId) {
      const desired = (await desiredAliasesForMailbox(db, alias.mailboxId, emailDomain.stalwartDomainId, mailbox.status === 'active'))
        .filter((d) => d.localPart !== alias.localPart);
      await setAccountAliases({
        accountId,
        principalId: mailbox.stalwartPrincipalId,
        aliases: desired,
      }).catch((err) => {
        log.warn({ aliasId, fullAddress: alias.fullAddress, err: err instanceof Error ? err.message : String(err) },
          'deleteMailboxAlias: alias-map push failed (row deleted anyway; reconcile sweeps the entry)');
      });
      await destroyIdentitiesForAddress({
        principalId: mailbox.stalwartPrincipalId,
        address: alias.fullAddress,
      }).catch((err) => {
        log.warn({ aliasId, fullAddress: alias.fullAddress, err: err instanceof Error ? err.message : String(err) },
          'deleteMailboxAlias: identity destroy failed (reconcile sweeps)');
      });
    }

    await db.delete(mailboxAliases).where(eq(mailboxAliases.id, aliasId));
  });
}
