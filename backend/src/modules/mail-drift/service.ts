/**
 * Mail drift surface — operator-facing service.
 *
 * The principals-sync reconciler detects when platform DB rows reference
 * Stalwart entries that no longer exist (typically caused by a failed
 * mail-stack failover prior to the 2026-05-27 silent-loss fix). This
 * module exposes the drift list and two remediation actions: dismiss
 * (accepted loss) and recreate-empty (last-resort destructive action).
 *
 * The third remediation — restore-from-snapshot — is intentionally NOT
 * implemented here. It requires a whole-stack Stalwart snapshot-restore
 * wizard that doesn't exist yet (per-Domain or per-mailbox restore from
 * snapshot is also infeasible because Stalwart's RocksDB doesn't allow
 * partial-data import without a full datastore replace). Operators who
 * want to preserve DKIM keys + mailbox contents must use the
 * mail-stack-consolidate.sh or HA failback workflow out-of-band.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { mailDriftItems, emailDomains, mailboxes, domains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { MailDriftItem, MailDriftKind } from '@k8s-hosting/api-contracts';

/** Default page size for the operator list view. */
const LIST_LIMIT = 100;

export async function listDriftItems(db: Database): Promise<{
  items: MailDriftItem[];
  hasActive: boolean;
}> {
  const rows = await db
    .select()
    .from(mailDriftItems)
    .orderBy(desc(mailDriftItems.firstDetectedAt))
    .limit(LIST_LIMIT);

  const items: MailDriftItem[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind as MailDriftKind,
    expectedName: r.expectedName,
    expectedStalwartId: r.expectedStalwartId,
    platformRowId: r.platformRowId,
    firstDetectedAt: r.firstDetectedAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolvedVia: (r.resolvedVia as MailDriftItem['resolvedVia']) ?? null,
    notes: r.notes,
  }));

  const hasActive = items.some((i) => i.resolvedAt === null);
  return { items, hasActive };
}

async function getActiveById(db: Database, id: string): Promise<MailDriftItem> {
  const [row] = await db
    .select()
    .from(mailDriftItems)
    .where(and(eq(mailDriftItems.id, id), isNull(mailDriftItems.resolvedAt)));
  if (!row) {
    throw new ApiError(
      'DRIFT_ITEM_NOT_FOUND',
      `Drift item ${id} not found or already resolved`,
      404,
    );
  }
  return {
    id: row.id,
    kind: row.kind as MailDriftKind,
    expectedName: row.expectedName,
    expectedStalwartId: row.expectedStalwartId,
    platformRowId: row.platformRowId,
    firstDetectedAt: row.firstDetectedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedVia: (row.resolvedVia as MailDriftItem['resolvedVia']) ?? null,
    notes: row.notes,
  };
}

export async function dismissDriftItem(db: Database, id: string, operatorNote?: string): Promise<MailDriftItem> {
  // Verify exists + still active.
  await getActiveById(db, id);

  await db
    .update(mailDriftItems)
    .set({
      resolvedAt: sql`now()`,
      resolvedVia: 'dismissed',
      notes: operatorNote ?? null,
    })
    .where(eq(mailDriftItems.id, id));

  // Re-read for the response.
  const [updated] = await db
    .select()
    .from(mailDriftItems)
    .where(eq(mailDriftItems.id, id));
  return {
    id: updated.id,
    kind: updated.kind as MailDriftKind,
    expectedName: updated.expectedName,
    expectedStalwartId: updated.expectedStalwartId,
    platformRowId: updated.platformRowId,
    firstDetectedAt: updated.firstDetectedAt.toISOString(),
    lastSeenAt: updated.lastSeenAt.toISOString(),
    resolvedAt: updated.resolvedAt?.toISOString() ?? null,
    resolvedVia: (updated.resolvedVia as MailDriftItem['resolvedVia']) ?? null,
    notes: updated.notes,
  };
}

/**
 * Recreate the missing Stalwart entry empty (last-resort). Operator MUST
 * type the expected_name as confirmation; the route handler enforces this
 * and passes the matched value in `confirmName`. We re-check here as a
 * server-side backstop.
 *
 * Returns the updated drift item + the newly-allocated Stalwart ID +
 * an operator-facing follow-up note (publish DKIM at registrar for
 * domain recreations; advise tenant about empty mailbox for mailbox
 * recreations).
 */
export async function recreateDriftItemEmpty(
  db: Database,
  id: string,
  confirmName: string,
): Promise<{
  item: MailDriftItem;
  newStalwartId: string;
  followUp: string;
}> {
  const item = await getActiveById(db, id);
  if (confirmName !== item.expectedName) {
    throw new ApiError(
      'CONFIRM_NAME_MISMATCH',
      `Confirmation token did not match. Expected '${item.expectedName}'.`,
      400,
    );
  }

  // Lazy-load JMAP client. `getDomainJmapAccountId` is local to the
  // email-domains service (cached singleton); we duplicate the minimal
  // session lookup here to keep mail-drift independent.
  //
  // NB: `accountSet` is the modern Stalwart 0.16 API that takes
  // `domainId` + bare local-part `name`. The legacy `createMailbox`
  // shim that passes the full address as `name` + `emails` is rejected
  // by Stalwart 0.16 with "Invalid email local part" because the
  // server validates `name` as a local-part token, not a full address.
  // We call `accountSet` directly here to match `mailboxes/service.ts`.
  const {
    getJmapSession,
    createDomain: jmapCreateDomain,
    accountSet,
  } = await import('../stalwart-jmap/client.js');
  const baseUrl = process.env.STALWART_MGMT_URL;
  const session = await getJmapSession(baseUrl, process.env);
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:principals'];
  if (!accountId) {
    throw new ApiError(
      'STALWART_UNREACHABLE',
      'Stalwart admin account ID could not be resolved (mail stack down?)',
      503,
    );
  }

  let newStalwartId: string;
  let followUp: string;
  if (item.kind === 'domain') {
    // Verify the platform email_domain row still exists.
    const [edRow] = await db
      .select({ id: emailDomains.id, domainId: emailDomains.domainId })
      .from(emailDomains)
      .where(eq(emailDomains.id, item.platformRowId));
    if (!edRow) {
      throw new ApiError(
        'PLATFORM_ROW_GONE',
        `Platform email_domains row ${item.platformRowId} no longer exists — dismiss this drift item instead`,
        409,
      );
    }
    // Confirm the platform Domain hostname matches the drift item.
    const [dRow] = await db
      .select({ domainName: domains.domainName })
      .from(domains)
      .where(eq(domains.id, edRow.domainId));
    if (!dRow || dRow.domainName.toLowerCase() !== item.expectedName.toLowerCase()) {
      throw new ApiError(
        'PLATFORM_HOSTNAME_MISMATCH',
        `Platform hostname has diverged from drift record — re-run the principals-sync reconciler before retrying`,
        409,
      );
    }

    const created = await jmapCreateDomain({
      accountId,
      input: { type: 'domain', name: item.expectedName },
      baseUrl,
    });
    if (!created.id) {
      throw new ApiError(
        'STALWART_CREATE_NO_ID',
        `Stalwart accepted the create call but returned no id — refusing to update platform DB`,
        502,
      );
    }
    newStalwartId = created.id;
    await db
      .update(emailDomains)
      .set({ stalwartDomainId: newStalwartId })
      .where(eq(emailDomains.id, edRow.id));
    followUp =
      `Stalwart Domain '${item.expectedName}' was recreated EMPTY. ` +
      `Stalwart generated NEW DKIM keys for this Domain — the previous ` +
      `keys are unrecoverable. The tenant's DNS at their registrar still ` +
      `lists the OLD DKIM TXT records, so any mail signed with the new ` +
      `keys WILL fail DMARC at receivers. REPUBLISH the DKIM TXT records ` +
      `(visible in Admin UI → Email → Domain → DKIM tab) before the ` +
      `tenant relies on outbound mail. The mail-DNS provisioner will ` +
      `surface the new records automatically on its next reconcile tick.`;
  } else {
    // mailbox kind
    const [mbRow] = await db
      .select({
        id: mailboxes.id,
        fullAddress: mailboxes.fullAddress,
        passwordHash: mailboxes.passwordHash,
        emailDomainId: mailboxes.emailDomainId,
      })
      .from(mailboxes)
      .where(eq(mailboxes.id, item.platformRowId));
    if (!mbRow) {
      throw new ApiError(
        'PLATFORM_ROW_GONE',
        `Platform mailboxes row ${item.platformRowId} no longer exists — dismiss this drift item instead`,
        409,
      );
    }
    if (mbRow.fullAddress.toLowerCase() !== item.expectedName.toLowerCase()) {
      throw new ApiError(
        'PLATFORM_ADDRESS_MISMATCH',
        `Platform mailbox address has diverged from drift record — re-run the principals-sync reconciler before retrying`,
        409,
      );
    }
    if (!mbRow.passwordHash) {
      throw new ApiError(
        'MAILBOX_PASSWORD_HASH_MISSING',
        `Mailbox ${mbRow.fullAddress} has no stored password hash — cannot recreate without password reset`,
        409,
      );
    }

    // Resolve the parent Domain's Stalwart ID — `x:Account/set` needs
    // `domainId` to bind the User to a domain, and rejects payloads
    // that pass `emails` without it. If the parent domain itself is
    // also drifting (no current stalwartDomainId), recreate the domain
    // first before retrying this mailbox.
    const [parentDomain] = await db
      .select({
        id: emailDomains.id,
        stalwartDomainId: emailDomains.stalwartDomainId,
      })
      .from(emailDomains)
      .where(eq(emailDomains.id, mbRow.emailDomainId));
    if (!parentDomain) {
      throw new ApiError(
        'PARENT_DOMAIN_GONE',
        `Mailbox ${mbRow.fullAddress} references email_domains row ${mbRow.emailDomainId} which no longer exists`,
        409,
      );
    }
    if (!parentDomain.stalwartDomainId) {
      throw new ApiError(
        'PARENT_DOMAIN_NOT_IN_STALWART',
        `Mailbox ${mbRow.fullAddress}: its parent Domain has no Stalwart entry. Recreate the Domain drift item first, then retry this mailbox.`,
        409,
      );
    }

    // Split fullAddress into local-part + domain. The platform-DB
    // mailboxes.full_address column is unique-indexed in canonical
    // lowercase, so `@` is always present exactly once.
    const atIdx = mbRow.fullAddress.indexOf('@');
    if (atIdx <= 0) {
      throw new ApiError(
        'MAILBOX_ADDRESS_MALFORMED',
        `Mailbox ${mbRow.fullAddress} has no local-part — cannot recreate`,
        409,
      );
    }
    const localPart = mbRow.fullAddress.slice(0, atIdx);

    const result = await accountSet({
      accountId,
      baseUrl,
      request: {
        create: {
          'recreated-mailbox': {
            '@type': 'User',
            name: localPart,
            domainId: parentDomain.stalwartDomainId,
            emails: [mbRow.fullAddress],
            credentials: {
              '0': {
                '@type': 'Password',
                secret: mbRow.passwordHash,
                allowedIps: {},
                expiresAt: null,
              },
            },
          },
        },
      },
    });
    const notCreated = result.notCreated?.['recreated-mailbox'];
    if (notCreated) {
      throw new ApiError(
        'STALWART_CREATE_REJECTED',
        `Stalwart x:Account/set rejected recreate: ${notCreated.description ?? notCreated.type}`,
        502,
        { type: notCreated.type, properties: notCreated.properties ?? null },
      );
    }
    const created = result.created?.['recreated-mailbox'] as { id?: string } | undefined;
    if (!created?.id) {
      throw new ApiError(
        'STALWART_CREATE_NO_ID',
        `Stalwart accepted the create call but returned no id — refusing to update platform DB`,
        502,
      );
    }
    newStalwartId = created.id;
    await db
      .update(mailboxes)
      .set({ stalwartPrincipalId: newStalwartId })
      .where(eq(mailboxes.id, mbRow.id));
    followUp =
      `Stalwart mailbox principal for '${item.expectedName}' was recreated ` +
      `EMPTY. The previous Maildir is unrecoverable from Stalwart. ` +
      `If a tenant-bundle backup snapshot covers this mailbox, you can ` +
      `restore messages via Admin UI → Tenants → <tenant> → Backups → ` +
      `Restore (mailbox subset). Otherwise the messages are permanently lost.`;
  }

  // Mark drift resolved.
  await db
    .update(mailDriftItems)
    .set({
      resolvedAt: sql`now()`,
      resolvedVia: 'recreated',
      notes: followUp,
    })
    .where(eq(mailDriftItems.id, id));

  // Re-read for the response.
  const [updated] = await db
    .select()
    .from(mailDriftItems)
    .where(eq(mailDriftItems.id, id));
  return {
    item: {
      id: updated.id,
      kind: updated.kind as MailDriftKind,
      expectedName: updated.expectedName,
      expectedStalwartId: updated.expectedStalwartId,
      platformRowId: updated.platformRowId,
      firstDetectedAt: updated.firstDetectedAt.toISOString(),
      lastSeenAt: updated.lastSeenAt.toISOString(),
      resolvedAt: updated.resolvedAt?.toISOString() ?? null,
      resolvedVia: (updated.resolvedVia as MailDriftItem['resolvedVia']) ?? null,
      notes: updated.notes,
    },
    newStalwartId,
    followUp,
  };
}
