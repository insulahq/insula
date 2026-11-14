/**
 * Recreate a lost Stalwart User principal from its platform `mailboxes` row.
 *
 * One function for every path that brings a mailbox back after Stalwart lost
 * it: drift repair ("Recreate empty") and the backup-restore principal ensure.
 * Both used to carry their own copy; the drift copy sent an `emails` property
 * that Stalwart 0.16's x:Account schema does not have, so every drift recreate
 * was refused with "Invalid key for object", and it skipped the quota, the
 * suspension and the aliases the restore copy re-applied.
 *
 * The create payload mirrors mailboxes/service.ts:createMailbox exactly: bare
 * local part as `name`, the parent domain's id as `domainId`, a fresh hidden
 * primary credential (ADR-049 generate-and-forget). Everything Stalwart keeps
 * outside that shape is re-applied after the create, best-effort: the quota,
 * the access profile (send-only and suspension in one write), the Sieve mail
 * rules, the aliases and their send-as identities. A step that fails is
 * logged and named in `warnings` so the caller can tell the operator; the
 * boot reconcile and the alias sweep converge it later.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { mailboxes, mailboxAliases } from '../../db/schema.js';
import { accountSet, updatePrincipal, type JmapAccountId } from '../stalwart-jmap/client.js';

/** The `mailboxes` columns a recreate reads. */
export interface RecreatableMailbox {
  readonly id: string;
  readonly fullAddress: string;
  readonly displayName: string | null;
  readonly quotaMb: number;
  readonly status: 'active' | 'disabled';
  readonly mailboxType: 'mailbox' | 'forward_only' | 'send_only';
  readonly forwardingAddresses: readonly string[] | null;
  readonly autoReply: number;
  readonly autoReplySubject: string | null;
  readonly autoReplyBody: string | null;
}

/** Select map for `RecreatableMailbox`, so callers read the same columns. */
export const recreatableMailboxColumns = {
  id: mailboxes.id,
  fullAddress: mailboxes.fullAddress,
  displayName: mailboxes.displayName,
  quotaMb: mailboxes.quotaMb,
  status: mailboxes.status,
  mailboxType: mailboxes.mailboxType,
  forwardingAddresses: mailboxes.forwardingAddresses,
  autoReply: mailboxes.autoReply,
  autoReplySubject: mailboxes.autoReplySubject,
  autoReplyBody: mailboxes.autoReplyBody,
} as const;

export interface RecreateLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export type RecreatePrincipalResult =
  | { readonly ok: true; readonly principalId: string; readonly warnings: readonly string[] }
  | {
    readonly ok: false;
    readonly code: 'PRINCIPAL_CREATE_REJECTED' | 'PRINCIPAL_CREATE_NO_ID';
    readonly reason: string;
    readonly type?: string;
    readonly properties?: unknown;
  };

const CREATE_KEY = 'recreated-mailbox';

export async function recreateMailboxPrincipal(
  db: Database,
  params: {
    readonly accountId: JmapAccountId;
    readonly row: RecreatableMailbox;
    /** Stalwart id of the parent x:Domain. */
    readonly stalwartDomainId: string;
    readonly baseUrl?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly log: RecreateLog;
  },
): Promise<RecreatePrincipalResult> {
  const { accountId, row, stalwartDomainId, baseUrl, env, log } = params;
  const localPart = row.fullAddress.slice(0, row.fullAddress.indexOf('@'));

  const result = await accountSet({
    accountId,
    baseUrl,
    env,
    request: {
      create: {
        [CREATE_KEY]: {
          '@type': 'User',
          name: localPart,
          domainId: stalwartDomainId,
          credentials: {
            '0': {
              '@type': 'Password',
              // 256-bit hidden primary; nobody logs in with it.
              secret: randomBytes(32).toString('base64url'),
              allowedIps: {},
              expiresAt: null,
            },
          },
          ...(row.displayName ? { description: row.displayName } : {}),
        },
      },
    },
  });
  const notCreated = result.notCreated?.[CREATE_KEY];
  if (notCreated) {
    return {
      ok: false,
      code: 'PRINCIPAL_CREATE_REJECTED',
      reason: notCreated.description ?? notCreated.type,
      type: notCreated.type,
      properties: notCreated.properties ?? null,
    };
  }
  const created = result.created?.[CREATE_KEY] as { id?: string } | undefined;
  if (!created?.id) {
    return { ok: false, code: 'PRINCIPAL_CREATE_NO_ID', reason: 'Stalwart returned no id for the new principal' };
  }
  const principalId = created.id;

  // Bind the row first: the principal exists now, whatever the re-applies do,
  // and principals-sync must not see the row as drifting again.
  await db.update(mailboxes).set({ stalwartPrincipalId: principalId }).where(eq(mailboxes.id, row.id));

  const warnings: string[] = [];
  const step = async (what: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      warnings.push(what);
      log.warn({
        mailboxId: row.id,
        address: row.fullAddress,
        principalId,
        err: err instanceof Error ? err.message : String(err),
      }, `mailbox recreate: ${what} re-apply failed (the reconcile converges it)`);
    }
  };

  // Send-only accounts store nothing: no quota (as createMailbox).
  if (row.quotaMb > 0 && row.mailboxType !== 'send_only') {
    await step('quota', () => updatePrincipal({
      accountId,
      id: principalId,
      // Stalwart `quotas.maxDiskQuota` is bytes; the platform stores MB.
      patch: { 'quotas/maxDiskQuota': row.quotaMb * 1024 * 1024 },
      baseUrl,
      env,
    }).then(() => undefined));
  }

  const suspended = row.status === 'disabled';
  const mailboxType = row.mailboxType === 'send_only' ? 'send_only' : 'mailbox';
  const declaresMailRules = mailboxType === 'send_only'
    || (row.forwardingAddresses?.length ?? 0) > 0
    || row.autoReply === 1
    || suspended;
  if (declaresMailRules) {
    await step('mail rules', async () => {
      const { applyMailRules, applyAccountAccessState } = await import('../stalwart-jmap/sieve.js');
      // Send-only and suspension in ONE write: sequential permission
      // patches clobber each other.
      await applyAccountAccessState({ accountId, principalId, mailboxType, suspended, baseUrl, env });
      await applyMailRules({
        principalId,
        mailboxType,
        suspended,
        forwardingAddresses: suspended ? [] : [...(row.forwardingAddresses ?? [])],
        autoReply: !suspended && row.autoReply === 1 && row.autoReplyBody?.trim()
          ? { subject: row.autoReplySubject, body: row.autoReplyBody }
          : null,
        baseUrl,
        env,
      });
    });
  }

  await step('aliases', async () => {
    const aliasRows = await db.select().from(mailboxAliases).where(eq(mailboxAliases.mailboxId, row.id));
    if (aliasRows.length === 0) return;
    const { setAccountAliases, reconcileIdentitiesForAccount } = await import('../stalwart-jmap/account-aliases.js');
    await setAccountAliases({
      accountId,
      principalId,
      aliases: aliasRows.map((a) => ({
        localPart: a.localPart,
        stalwartDomainId,
        // A suspended mailbox has every alias off.
        enabled: !suspended && a.enabled === 1,
      })),
      baseUrl,
      env,
    });
    await reconcileIdentitiesForAccount({
      principalId,
      wantAddresses: aliasRows.filter((a) => a.enabled === 1).map((a) => a.fullAddress),
      dropAddresses: aliasRows.filter((a) => a.enabled !== 1).map((a) => a.fullAddress),
      baseUrl,
      env,
    });
  });

  return { ok: true, principalId, warnings };
}
