/**
 * Email aliases — REAL since 2026-08 (ROADMAP R28 remainder).
 *
 * An alias is an address with no inbox that delivers to 1..20
 * destinations (local mailboxes or external addresses). It is backed by
 * a Stalwart MailingList (source address = list address, destinations =
 * recipients; fan-out verified live on v0.16.16, including across
 * domains). The platform DB is authoritative:
 *   - create/update/delete push to Stalwart FAIL-VISIBLY (a DB row that
 *     claims forwarding the mail server doesn't do is exactly the
 *     DB-only-fiction failure mode this replaces);
 *   - `enabled: false` destroys the Stalwart list (the DB row keeps the
 *     configuration); re-enabling recreates it;
 *   - the boot reconcile (aliases-reconcile.ts) converges drift and
 *     back-fills aliases created while the domain was unprovisioned.
 */
import { eq, and } from 'drizzle-orm';
import { emailAliases, emailDomains, mailboxes, domains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { mailLogger } from '../../shared/mail-logger.js';
import { getCachedPrincipalsAccountId, JmapError } from '../stalwart-jmap/client.js';
import {
  createMailingList,
  updateMailingListRecipients,
  destroyMailingList,
} from '../stalwart-jmap/mailing-lists.js';
import type { Database } from '../../db/index.js';
import type { CreateEmailAliasInput, UpdateEmailAliasInput } from '@insula/api-contracts';

const log = mailLogger().child({ module: 'email-aliases' });

function aliasNotFound(id: string): ApiError {
  return new ApiError('EMAIL_ALIAS_NOT_FOUND', `Email alias '${id}' not found`, 404);
}

function mailServerError(op: string, err: unknown): ApiError {
  return new ApiError(
    'MAIL_SERVER_ERROR',
    `Alias ${op} failed at the mail server: ${err instanceof Error ? err.message : String(err)}`,
    502,
    {},
    'Check Stalwart JMAP API reachability and logs, then retry',
  );
}

/**
 * Normalise destinations (trim, lowercase, dedupe) and reject a
 * destination equal to the alias itself — a guaranteed delivery loop.
 */
export function normalizeAliasDestinations(
  destinations: readonly string[],
  sourceAddress: string,
): string[] {
  const source = sourceAddress.toLowerCase();
  const normalized = [...new Set(destinations.map((d) => d.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'An alias needs at least one destination address',
      400,
    );
  }
  if (normalized.includes(source)) {
    throw new ApiError(
      'ALIAS_SELF_TARGET',
      'An alias cannot deliver to its own address',
      422,
      { address: sourceAddress },
      'Remove the alias’s own address from the destinations',
    );
  }
  return normalized;
}

export async function createAlias(
  db: Database,
  tenantId: string,
  emailDomainId: string,
  input: CreateEmailAliasInput,
) {
  // Verify emailDomain exists and belongs to tenant
  const [emailDomain] = await db
    .select()
    .from(emailDomains)
    .where(and(eq(emailDomains.id, emailDomainId), eq(emailDomains.tenantId, tenantId)));

  if (!emailDomain) {
    throw new ApiError('EMAIL_DOMAIN_NOT_FOUND', `Email domain '${emailDomainId}' not found`, 404);
  }

  // Get the parent domain to verify source_address domain matches
  const [parentDomain] = await db
    .select()
    .from(domains)
    .where(eq(domains.id, emailDomain.domainId));

  if (!parentDomain) {
    throw new ApiError('DOMAIN_NOT_FOUND', 'Parent domain not found for email domain', 404);
  }

  const sourceAddress = input.source_address.toLowerCase();
  const [localPart, sourceDomain] = sourceAddress.split('@');
  if (!localPart || sourceDomain !== parentDomain.domainName.toLowerCase()) {
    throw new ApiError(
      'DOMAIN_MISMATCH',
      `Source address domain '${sourceDomain ?? ''}' does not match email domain '${parentDomain.domainName}'`,
      400,
    );
  }

  const destinations = normalizeAliasDestinations(input.destination_addresses, sourceAddress);

  // Check source_address not already taken as alias
  const [existingAlias] = await db
    .select()
    .from(emailAliases)
    .where(eq(emailAliases.sourceAddress, sourceAddress));

  if (existingAlias) {
    throw new ApiError('DUPLICATE_ENTRY', `Alias '${sourceAddress}' already exists`, 409);
  }

  // Check source_address not already taken as mailbox
  const [existingMailbox] = await db
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.fullAddress, sourceAddress));

  if (existingMailbox) {
    throw new ApiError('DUPLICATE_ENTRY', `Address '${sourceAddress}' is already used by a mailbox`, 409);
  }

  // Provision the Stalwart MailingList FIRST (JMAP-first, mirroring
  // createMailbox) so no DB row ever claims an alias the mail server
  // doesn't implement. If the email domain has no Stalwart id yet
  // (orphan/pre-provision), store the row unprovisioned — the boot
  // reconcile creates the list once the domain exists.
  let stalwartListId: string | null = null;
  const accountId = await getCachedPrincipalsAccountId();
  if (accountId && emailDomain.stalwartDomainId) {
    try {
      stalwartListId = await createMailingList({
        accountId,
        localPart,
        stalwartDomainId: emailDomain.stalwartDomainId,
        destinations,
      });
    } catch (err) {
      throw mailServerError('provisioning', err);
    }
  } else if (accountId && !emailDomain.stalwartDomainId) {
    log.warn({ emailDomainId, sourceAddress },
      'createAlias: email_domain has no stalwartDomainId — alias stored unprovisioned (boot reconcile converges)');
  }

  const id = crypto.randomUUID();
  try {
    await db.insert(emailAliases).values({
      id,
      emailDomainId,
      tenantId,
      sourceAddress,
      destinationAddresses: destinations,
      enabled: 1,
      stalwartListId,
    });
  } catch (dbErr) {
    // Compensating destroy — no orphan list without a platform row.
    if (stalwartListId && accountId) {
      await destroyMailingList({ accountId, listId: stalwartListId }).catch((cleanupErr) => {
        log.warn({ stalwartListId, err: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) },
          'compensating MailingList destroy failed for orphan list');
      });
    }
    throw dbErr;
  }

  const [created] = await db.select().from(emailAliases).where(eq(emailAliases.id, id));
  return created;
}

export async function listAliases(db: Database, tenantId: string, emailDomainId?: string) {
  const conditions = [eq(emailAliases.tenantId, tenantId)];
  if (emailDomainId) {
    conditions.push(eq(emailAliases.emailDomainId, emailDomainId));
  }
  return db.select().from(emailAliases).where(and(...conditions));
}

export async function updateAlias(
  db: Database,
  tenantId: string,
  aliasId: string,
  input: UpdateEmailAliasInput,
) {
  const [alias] = await db
    .select()
    .from(emailAliases)
    .where(and(eq(emailAliases.id, aliasId), eq(emailAliases.tenantId, tenantId)));

  if (!alias) throw aliasNotFound(aliasId);

  const desiredEnabled = input.enabled !== undefined ? input.enabled : alias.enabled === 1;
  const desiredDestinations = input.destination_addresses !== undefined
    ? normalizeAliasDestinations(input.destination_addresses, alias.sourceAddress)
    : (alias.destinationAddresses as string[]);

  // Push the desired state to Stalwart BEFORE the DB write (fail-visible;
  // the DB stays authoritative and the boot reconcile re-pushes on a
  // partial failure).
  let nextListId: string | null = alias.stalwartListId;
  const accountId = await getCachedPrincipalsAccountId();
  const touchesServer =
    input.enabled !== undefined || input.destination_addresses !== undefined;

  if (touchesServer && accountId) {
    try {
      if (!desiredEnabled) {
        // Disable = the address stops existing on the mail server.
        if (alias.stalwartListId) {
          await destroyMailingList({ accountId, listId: alias.stalwartListId });
          nextListId = null;
        }
      } else if (alias.stalwartListId) {
        try {
          await updateMailingListRecipients({
            accountId,
            listId: alias.stalwartListId,
            destinations: desiredDestinations,
          });
        } catch (err) {
          // A restored bundle / rebuilt mail store leaves a STALE foreign
          // list id — self-heal by recreating instead of hard-502ing a
          // routine edit (review 2026-08-24). Any other error propagates.
          const notFound = err instanceof JmapError && err.code === 'notFound';
          if (!notFound) throw err;
          const [emailDomain] = await db
            .select()
            .from(emailDomains)
            .where(eq(emailDomains.id, alias.emailDomainId));
          nextListId = emailDomain?.stalwartDomainId
            ? await createMailingList({
                accountId,
                localPart: alias.sourceAddress.split('@')[0],
                stalwartDomainId: emailDomain.stalwartDomainId,
                destinations: desiredDestinations,
              })
            : null;
          log.warn({ aliasId, staleListId: alias.stalwartListId, recreated: nextListId },
            'updateAlias: stored list id was stale (restore/rebuild) — recreated');
        }
      } else {
        // Re-enable (or first provision after an unprovisioned create).
        const [emailDomain] = await db
          .select()
          .from(emailDomains)
          .where(eq(emailDomains.id, alias.emailDomainId));
        if (emailDomain?.stalwartDomainId) {
          nextListId = await createMailingList({
            accountId,
            localPart: alias.sourceAddress.split('@')[0],
            stalwartDomainId: emailDomain.stalwartDomainId,
            destinations: desiredDestinations,
          });
        } else {
          log.warn({ aliasId, sourceAddress: alias.sourceAddress },
            'updateAlias: email_domain has no stalwartDomainId — stored unprovisioned (boot reconcile converges)');
        }
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw mailServerError('update', err);
    }
  }

  const updateValues: Record<string, unknown> = {};
  if (input.destination_addresses !== undefined) {
    updateValues.destinationAddresses = desiredDestinations;
  }
  if (input.enabled !== undefined) {
    updateValues.enabled = input.enabled ? 1 : 0;
  }
  if (nextListId !== alias.stalwartListId) {
    updateValues.stalwartListId = nextListId;
  }

  if (Object.keys(updateValues).length > 0) {
    await db.update(emailAliases).set(updateValues).where(eq(emailAliases.id, aliasId));
  }

  const [updated] = await db.select().from(emailAliases).where(eq(emailAliases.id, aliasId));
  return updated;
}

export async function deleteAlias(db: Database, tenantId: string, aliasId: string) {
  const [alias] = await db
    .select()
    .from(emailAliases)
    .where(and(eq(emailAliases.id, aliasId), eq(emailAliases.tenantId, tenantId)));

  if (!alias) throw aliasNotFound(aliasId);

  // Best-effort destroy — the boot reconcile logs (never auto-deletes)
  // any orphan list left behind by a transient failure here.
  if (alias.stalwartListId) {
    const accountId = await getCachedPrincipalsAccountId();
    if (accountId) {
      await destroyMailingList({ accountId, listId: alias.stalwartListId }).catch((err) => {
        log.warn({ aliasId, stalwartListId: alias.stalwartListId, err: err instanceof Error ? err.message : String(err) },
          'deleteAlias: MailingList destroy failed (platform row deleted anyway)');
      });
    }
  }

  await db.delete(emailAliases).where(eq(emailAliases.id, aliasId));
}
