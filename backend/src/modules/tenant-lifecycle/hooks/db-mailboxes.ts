import { eq } from 'drizzle-orm';
import { mailboxes } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

/**
 * mailboxes-status hook.
 *
 *   - active     → status='active' + restore the full mail state from
 *                  the DB (permissions re-enabled, forwarding/auto-reply
 *                  Sieve re-pushed, alias map re-enabled)
 *   - suspended  → status='disabled' + FULL mail shutdown per mailbox
 *                  (operator decision 2026-08-26: suspension disables
 *                  the primary account AND its aliases for incoming and
 *                  outgoing mail until reactivation):
 *                    · `authenticate` permission disabled — no
 *                      submission/IMAP/POP3/ManageSieve/webmail login
 *                      ("550 5.7.1 not authorized"; probed live)
 *                    · ereject Sieve script — ALL inbound bounced with a
 *                      neutral DSN (nothing stored, sender is informed)
 *                    · alias map pushed all-off — alias RCPT 550 too.
 *                  Alias rows and send-as identities keep the tenant's
 *                  configuration for reactivation.
 *   - archived   → destroy the Stalwart account principals FIRST, then
 *                  DELETE FROM mailboxes (2026-08-25 drift audit: rows
 *                  used to be deleted with the principals left alive —
 *                  live invisible mailboxes no reconcile could ever see
 *                  because the platform row was gone. Destroy-first +
 *                  retry mirrors the email-aliases archive ordering; the
 *                  tenant bundle taken before archive is the recovery
 *                  path for mail data.)
 *   - restored   → status='active' + restore the full mail state
 *
 * Stalwart-side failures return `retry` (2-min hook scheduler re-runs);
 * for `archived` the row delete only happens AFTER the destroys
 * succeeded, so the retry still sees the rows.
 *
 * blocking=abort: Stalwart's `stalwart.*` views read this state
 * directly; a stale row keeps a deleted tenant's mail flowing.
 */
async function runImpl(ctx: HookCtx): Promise<HookResult> {
  switch (ctx.transition) {
    case 'archived': {
      const stalwart = await destroyTenantPrincipals(ctx);
      if (!stalwart.ok) {
        return { status: 'retry', detail: `archive blocked on Stalwart principal destroy: ${stalwart.detail}` };
      }
      await ctx.db.delete(mailboxes).where(eq(mailboxes.tenantId, ctx.tenantId));
      return { status: 'ok', detail: `archived: deleted mailboxes (${stalwart.detail})` };
    }
    case 'suspended': {
      await ctx.db.update(mailboxes)
        .set({ status: 'disabled' })
        .where(eq(mailboxes.tenantId, ctx.tenantId));
      const stalwart = await pushTenantMailState(ctx, 'suspended');
      if (!stalwart.ok) return { status: 'retry', detail: `status=disabled set; mail shutdown pending: ${stalwart.detail}` };
      return { status: 'ok', detail: `set status=disabled (${stalwart.detail})` };
    }
    case 'active':
    case 'restored': {
      await ctx.db.update(mailboxes)
        .set({ status: 'active' })
        .where(eq(mailboxes.tenantId, ctx.tenantId));
      const stalwart = await pushTenantMailState(ctx, 'live');
      if (!stalwart.ok) return { status: 'retry', detail: `status=active set; mail restore pending: ${stalwart.detail}` };
      return { status: 'ok', detail: `set status=active (${stalwart.detail})` };
    }
    default:
      // 'deleted' is not in `transitions` so this branch is unreachable
      // unless the subscribed-transitions list is widened by mistake.
      return { status: 'noop', detail: `unhandled transition '${ctx.transition}'` };
  }
}

/**
 * Destroy every Stalwart account principal backing this tenant's
 * mailboxes (spam-training samples purged first — BlobLink::Temporary
 * refs survive a principal destroy). `notFound` = already gone = ok.
 * Unreachable Stalwart is only ok when no row references a principal.
 */
async function destroyTenantPrincipals(ctx: HookCtx): Promise<{ ok: boolean; detail: string }> {
  try {
    const { getCachedPrincipalsAccountId, destroyPrincipal, JmapError } = await import('../../stalwart-jmap/client.js');
    const { purgeSpamTrainingSamplesForPrincipal } = await import('../../mail-admin/spam-sample-cleanup.js');
    const rows = await ctx.db
      .select({ id: mailboxes.id, fullAddress: mailboxes.fullAddress, stalwartPrincipalId: mailboxes.stalwartPrincipalId })
      .from(mailboxes)
      .where(eq(mailboxes.tenantId, ctx.tenantId));
    const provisioned = rows.filter((r) => r.stalwartPrincipalId);
    if (provisioned.length === 0) {
      return { ok: true, detail: 'no provisioned principals' };
    }
    const accountId = await getCachedPrincipalsAccountId();
    if (!accountId) {
      return { ok: false, detail: `Stalwart unreachable with ${provisioned.length} principal(s) to destroy` };
    }
    let destroyed = 0;
    for (const row of provisioned) {
      const principalId = row.stalwartPrincipalId as string;
      await purgeSpamTrainingSamplesForPrincipal({ principalId }).catch(() => undefined);
      try {
        await destroyPrincipal({ accountId, id: principalId, baseUrl: process.env.STALWART_MGMT_URL });
      } catch (err) {
        if (!(err instanceof JmapError && err.code === 'notFound')) throw err;
      }
      // Null the id row-by-row so a retry after a mid-loop failure does
      // not re-destroy (idempotence) and the remaining work is visible.
      await ctx.db.update(mailboxes).set({ stalwartPrincipalId: null }).where(eq(mailboxes.id, row.id));
      destroyed += 1;
    }
    return { ok: true, detail: `destroyed ${destroyed} principal(s)` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Push every provisioned mailbox's FULL mail state: `live` = restore
 * from the DB rows (reactivate), `suspended` = full shutdown (access
 * permissions off, ereject script, alias map all-off). Mirrors
 * mail-rules-reconcile's desired-state derivation — keep the two in
 * step.
 */
async function pushTenantMailState(
  ctx: HookCtx,
  mode: 'live' | 'suspended',
): Promise<{ ok: boolean; detail: string }> {
  try {
    const { getCachedPrincipalsAccountId } = await import('../../stalwart-jmap/client.js');
    const { applyMailRules, applyAccountAccessState, ensureSieveInterpreterLimits } = await import('../../stalwart-jmap/sieve.js');
    const { setAccountAliases } = await import('../../stalwart-jmap/account-aliases.js');
    const { desiredAliasesForMailbox } = await import('../../mailbox-aliases/service.js');
    const { emailDomains } = await import('../../../db/schema.js');
    const suspended = mode === 'suspended';
    const rows = await ctx.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.tenantId, ctx.tenantId));
    const provisioned = rows.filter((r) => r.stalwartPrincipalId);
    if (provisioned.length === 0) return { ok: true, detail: 'no provisioned mailboxes' };
    const accountId = await getCachedPrincipalsAccountId();
    if (!accountId) {
      return { ok: false, detail: `Stalwart unreachable with ${provisioned.length} mailbox state(s) to push` };
    }
    if (!suspended && provisioned.some((r) => ((r.forwardingAddresses as string[] | null)?.length ?? 0) > 0)) {
      await ensureSieveInterpreterLimits({ accountId });
    }
    const stalwartDomainByEmailDomainId = new Map<string, string>();
    for (const r of provisioned) {
      if (stalwartDomainByEmailDomainId.has(r.emailDomainId)) continue;
      const [ed] = await ctx.db
        .select({ stalwartDomainId: emailDomains.stalwartDomainId })
        .from(emailDomains)
        .where(eq(emailDomains.id, r.emailDomainId));
      if (ed?.stalwartDomainId) stalwartDomainByEmailDomainId.set(r.emailDomainId, ed.stalwartDomainId);
    }
    let pushed = 0;
    for (const r of provisioned) {
      const mailboxType = r.mailboxType === 'send_only' ? 'send_only' : 'mailbox';
      await applyAccountAccessState({
        accountId,
        principalId: r.stalwartPrincipalId as string,
        mailboxType,
        suspended,
      });
      await applyMailRules({
        principalId: r.stalwartPrincipalId as string,
        mailboxType,
        suspended,
        forwardingAddresses: suspended ? [] : ((r.forwardingAddresses as string[] | null) ?? []),
        autoReply: !suspended && mailboxType === 'mailbox' && r.autoReply === 1 && r.autoReplyBody
          ? { subject: r.autoReplySubject ?? null, body: r.autoReplyBody }
          : null,
      });
      const stalwartDomainId = stalwartDomainByEmailDomainId.get(r.emailDomainId);
      if (stalwartDomainId) {
        const aliasMap = await desiredAliasesForMailbox(ctx.db, r.id, stalwartDomainId, !suspended);
        if (aliasMap.length > 0) {
          await setAccountAliases({
            accountId,
            principalId: r.stalwartPrincipalId as string,
            aliases: aliasMap,
          });
        }
      }
      pushed += 1;
    }
    return { ok: true, detail: `${suspended ? 'shut down' : 'restored'} mail state on ${pushed} mailbox(es)` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export const mailboxesStatusHook: LifecycleHook = {
  name: 'mailboxes-status',
  transitions: ['active', 'suspended', 'archived', 'restored'],
  order: 220,
  blocking: 'abort',
  run: runImpl,
};

let _registered = false;
export function registerMailboxesStatusHook(): void {
  if (_registered) return;
  registerLifecycleHook(mailboxesStatusHook);
  _registered = true;
}
