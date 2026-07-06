/**
 * Ensure Stalwart principals exist for a set of mailbox addresses
 * before invoking jmap-restore.py.
 *
 * Why: jmap-restore.py uses Stalwart master-user proxy auth
 * (`<addr>%<master>`); if the target address's principal was deleted
 * in Stalwart between backup and restore, auth fails with
 * `unauthorized` and no messages can be imported.
 *
 * Recovery semantics (3 cases):
 *   1. Principal EXISTS in Stalwart → nothing to do. Common case for
 *      "I want to restore the last week's mail into my mailbox".
 *   2. Principal MISSING in Stalwart but the platform DB `mailboxes`
 *      row is intact → recreate the Stalwart principal from DB metadata
 *      with a freshly-generated secret (the user's real password
 *      lives separately in Stalwart's secret store, which the
 *      master-user proxy doesn't need anyway — operators can rotate
 *      the user-facing password via the normal flow afterwards).
 *   3. Both the Stalwart principal AND the platform DB row are gone →
 *      this means the mailbox was fully deleted at both layers.
 *      Restoring it requires recreating the DB row first via a
 *      `config-tables` cart item with the `mailboxes` table selected.
 *      We throw `MAILBOX_ROW_MISSING` with a remediation message so
 *      the operator UI can guide them.
 *
 * Why we don't auto-include the mailbox DB row in this executor:
 *   The platform DB row carries cross-tenant constraints (tenantId
 *   FK, soft-delete state, lifecycle flags) that belong to the
 *   `config-tables` executor's transactional scope. Mixing concerns
 *   here would mean two executors writing to the same table without
 *   a clear ordering contract — the `config-tables` → `mailboxes-by-
 *   address` ordering in the cart is the contract.
 */

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import {
  mailboxes as mailboxesTable,
  emailDomains as emailDomainsTable,
  domains as domainsTable,
} from '../../../db/schema.js';
import {
  accountSet,
  createDomain,
  findDomainByName,
  findMailboxByEmail,
  getJmapSession,
  updatePrincipal,
} from '../../stalwart-jmap/client.js';
import { ApiError } from '../../../shared/errors.js';

type EnsureOutcome =
  | { status: 'existing'; address: string }
  | { status: 'recreated'; address: string; stalwartPrincipalId: string }
  | { status: 'failed'; address: string; reason: string };

export interface EnsureStalwartPrincipalsArgs {
  app: FastifyInstance;
  addresses: readonly string[];
  /**
   * Optional override for Stalwart's HTTP base URL — useful for tests.
   * Production reads from STALWART_JMAP_URL env (set in platform-api
   * Deployment). Pass undefined to use the default resolution.
   */
  jmapBaseUrl?: string;
}

export interface EnsureStalwartPrincipalsResult {
  outcomes: ReadonlyArray<EnsureOutcome>;
  recreated: number;
}

/**
 * Generate a strong random secret for the Stalwart principal.
 * Used ONLY as a placeholder password — the operator must rotate it
 * via the normal user-facing flow before the user logs in directly.
 * The master-user proxy auth (used by jmap-restore.py and admin
 * webmail) does NOT consult this secret.
 */
function generatePrincipalSecret(): string {
  // 32 bytes → 256-bit entropy. base64url-encoded for safe Stalwart
  // ingestion (no padding chars that confuse some shell paths).
  return randomBytes(32).toString('base64url');
}

export async function ensureStalwartPrincipals(
  args: EnsureStalwartPrincipalsArgs,
): Promise<EnsureStalwartPrincipalsResult> {
  const { app, addresses, jmapBaseUrl } = args;
  const outcomes: EnsureOutcome[] = [];
  let recreated = 0;

  if (addresses.length === 0) {
    return { outcomes: [], recreated: 0 };
  }

  // 1. Resolve the principals JMAP account ID once.
  let principalsAccountId: string;
  try {
    const session = await getJmapSession(jmapBaseUrl, process.env);
    const id = session.primaryAccounts['urn:ietf:params:jmap:principals'];
    if (!id) {
      throw new ApiError(
        'STALWART_UNAVAILABLE',
        'Stalwart JMAP session has no principals account — cannot ensure mailbox principals',
        500,
      );
    }
    principalsAccountId = id;
  } catch (err) {
    // Hard failure: without JMAP access we cannot make ANY principal
    // decisions. Surface as a clear restore failure rather than
    // silently calling jmap-restore.py and watching it auth-fail per
    // address.
    throw new ApiError(
      'STALWART_UNAVAILABLE',
      `Stalwart JMAP session failed: ${err instanceof Error ? err.message : String(err)}`,
      503,
    );
  }

  // 2. Pre-fetch all platform DB rows in one query (the addresses
  //    list is at most a few hundred per cart, and the column is
  //    indexed). Saves N+1 queries.
  const dbRows = await app.db
    .select({
      id: mailboxesTable.id,
      fullAddress: mailboxesTable.fullAddress,
      stalwartPrincipalId: mailboxesTable.stalwartPrincipalId,
      displayName: mailboxesTable.displayName,
      quotaMb: mailboxesTable.quotaMb,
    })
    .from(mailboxesTable)
    .where(inArray(mailboxesTable.fullAddress, addresses as string[]));
  const dbByAddress = new Map<string, typeof dbRows[number]>();
  for (const row of dbRows) {
    dbByAddress.set(row.fullAddress.toLowerCase(), row);
  }

  // 2.5. Ensure the Stalwart DOMAIN principal exists for every address's
  //      domain BEFORE creating any mailbox principal.
  //
  //      After a full tenant re-create (DR of a DELETED tenant) the config
  //      restore brought back the `email_domains` row, but nothing recreated
  //      the Stalwart domain principal — and the restored `stalwartDomainId`
  //      is the SOURCE cluster's id, meaningless here. Resolve by NAME (not the
  //      stale id); create if missing; back-fill the row so principals-sync
  //      sees the correct id. Mirrors the domain half of email-domains/
  //      service.ts:enableEmailForDomain (DKIM/DNS are a documented residual
  //      gap — delivery only needs the principal). The resolved id is ALSO
  //      required as the `domainId` on the modern x:Account create below.
  const domainNames = [...new Set(
    addresses
      .map((a) => a.split('@')[1]?.toLowerCase())
      .filter((d): d is string => !!d),
  )];
  const domainIdByName = new Map<string, string>();
  for (const domainName of domainNames) {
    try {
      const existingDomain = await findDomainByName({
        accountId: principalsAccountId,
        domainName,
        baseUrl: jmapBaseUrl,
        env: process.env,
      });
      let stalwartDomainId = existingDomain?.id ?? null;
      if (!stalwartDomainId) {
        const created = await createDomain({
          accountId: principalsAccountId,
          baseUrl: jmapBaseUrl,
          env: process.env,
          input: { type: 'domain', name: domainName },
        });
        stalwartDomainId = created.id ?? null;
        app.log.info(
          { module: 'ensure-stalwart-principals', domainName, stalwartDomainId },
          'recreated deleted Stalwart domain principal for restore',
        );
      }
      if (stalwartDomainId) domainIdByName.set(domainName, stalwartDomainId);
      // Best-effort back-fill of the stale source-cluster id. `email_domains`
      // has no name column — resolve via its parent `domains` row (domainName
      // is globally unique, so this maps to at most one email_domains row).
      if (stalwartDomainId) {
        const [domRow] = await app.db
          .select({ id: domainsTable.id })
          .from(domainsTable)
          .where(eq(domainsTable.domainName, domainName))
          .limit(1);
        if (domRow) {
          await app.db
            .update(emailDomainsTable)
            .set({ stalwartDomainId })
            .where(eq(emailDomainsTable.domainId, domRow.id));
        }
      }
    } catch (err) {
      // Non-fatal here: a missing domain will surface as a per-address
      // mailbox-create failure below with an actionable message. Log so the
      // root cause (domain ensure) is visible in the server logs.
      app.log.warn(
        {
          module: 'ensure-stalwart-principals',
          domainName,
          err: err instanceof Error ? err.message : String(err),
        },
        'Stalwart domain principal ensure failed — mailbox creation may fail',
      );
    }
  }

  // 3. For each address, decide whether to recreate.
  for (const address of addresses) {
    try {
      const existing = await findMailboxByEmail({
        accountId: principalsAccountId,
        email: address,
        baseUrl: jmapBaseUrl,
        env: process.env,
      });
      if (existing) {
        outcomes.push({ status: 'existing', address });
        continue;
      }
      // Stalwart says the principal doesn't exist. Look up DB row.
      const dbRow = dbByAddress.get(address.toLowerCase());
      if (!dbRow) {
        outcomes.push({
          status: 'failed',
          address,
          reason: 'MAILBOX_ROW_MISSING: platform DB has no row for this address either. '
            + 'Add a config-tables(mailboxes) restore item BEFORE the mailboxes-by-address '
            + 'item in this cart to recreate the DB row from the bundle, then re-run.',
        });
        continue;
      }
      // Recreate the principal via the MODERN x:Account/set API. Stalwart 0.16
      // rejects the legacy createMailbox shim (which passes the full address as
      // `name` + `emails`) with "Invalid email local part" — it validates
      // `name` as a bare local-part token and binds the account to its parent
      // via `domainId`. Mirror mailboxes/service.ts:createMailbox exactly
      // (create payload omits quota — unproven shape — quota patched after).
      const stalwartDomainId = domainIdByName.get((address.split('@')[1] ?? '').toLowerCase());
      if (!stalwartDomainId) {
        outcomes.push({
          status: 'failed',
          address,
          reason: `DOMAIN_ENSURE_FAILED: no Stalwart domain principal for '${address.split('@')[1] ?? ''}' — `
            + 'the mail domain could not be (re)created, so the mailbox cannot be bound.',
        });
        continue;
      }
      const localPart = address.split('@')[0] ?? dbRow.fullAddress;
      const secret = generatePrincipalSecret();
      const setResult = await accountSet({
        accountId: principalsAccountId,
        baseUrl: jmapBaseUrl,
        env: process.env,
        request: {
          create: {
            'new-mailbox': {
              '@type': 'User',
              name: localPart,
              domainId: stalwartDomainId,
              credentials: {
                '0': { '@type': 'Password', secret, allowedIps: {}, expiresAt: null },
              },
              ...(dbRow.displayName ? { description: dbRow.displayName } : {}),
            },
          },
        },
      });
      const notCreated = setResult.notCreated?.['new-mailbox'];
      if (notCreated) {
        outcomes.push({
          status: 'failed',
          address,
          reason: `PRINCIPAL_CREATE_REJECTED: ${notCreated.description ?? notCreated.type}`,
        });
        continue;
      }
      const created = setResult.created?.['new-mailbox'] as { id?: string } | undefined;
      if (!created?.id) {
        outcomes.push({
          status: 'failed',
          address,
          reason: 'PRINCIPAL_CREATE_NO_ID: Stalwart returned no id for new principal',
        });
        continue;
      }
      const newPrincipalId = created.id;
      // Apply the stored quota after create (create shape omits it — see
      // mailboxes/service.ts). Best-effort: Stalwart falls back to the
      // tenant/global default if this patch fails.
      if (dbRow.quotaMb && dbRow.quotaMb > 0) {
        try {
          await updatePrincipal({
            accountId: principalsAccountId,
            id: newPrincipalId,
            patch: { 'quotas/maxDiskQuota': dbRow.quotaMb * 1024 * 1024 },
            baseUrl: jmapBaseUrl,
            env: process.env,
          });
        } catch (quotaErr) {
          app.log.warn(
            {
              module: 'ensure-stalwart-principals',
              address,
              err: quotaErr instanceof Error ? quotaErr.message : String(quotaErr),
            },
            'mailbox quota apply failed after principal recreate (non-fatal)',
          );
        }
      }
      // Back-fill the platform DB row's stalwartPrincipalId so the
      // next principals-sync run doesn't see the row as an orphan.
      await app.db
        .update(mailboxesTable)
        .set({ stalwartPrincipalId: newPrincipalId })
        .where(eq(mailboxesTable.id, dbRow.id));
      outcomes.push({ status: 'recreated', address, stalwartPrincipalId: newPrincipalId });
      recreated++;
      app.log.info(
        {
          module: 'ensure-stalwart-principals',
          address,
          stalwartPrincipalId: created.id,
          mailboxId: dbRow.id,
        },
        'recreated deleted Stalwart principal for restore',
      );
    } catch (err) {
      outcomes.push({
        status: 'failed',
        address,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { outcomes, recreated };
}
