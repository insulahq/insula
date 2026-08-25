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
 *   - active     → status='active' + re-push the platform mail rules
 *                  (forwarding/auto-reply Sieve) from the DB state
 *   - suspended  → status='disabled' + STRIP forwarding/auto-reply from
 *                  the mail server (2026-08-25 drift audit: the Sieve
 *                  script used to keep forwarding a suspended tenant's
 *                  mail — an AUTOMATIC outbound action on behalf of a
 *                  tenant the platform says is off. Inbound mail keeps
 *                  being STORED, so nothing is lost across a suspension;
 *                  send-only accounts keep their ereject bounce.
 *                  Deliberately NOT stripped: mailbox aliases and their
 *                  send-as identities. Suspension does not disable the
 *                  account's authenticated sending at all (the primary
 *                  address can still submit), so revoking only the alias
 *                  identities would be security theater — if suspension
 *                  should block sending, that's an account-permission
 *                  change to make for primary+aliases together.)
 *   - archived   → destroy the Stalwart account principals FIRST, then
 *                  DELETE FROM mailboxes (2026-08-25 drift audit: rows
 *                  used to be deleted with the principals left alive —
 *                  live invisible mailboxes no reconcile could ever see
 *                  because the platform row was gone. Destroy-first +
 *                  retry mirrors the email-aliases archive ordering; the
 *                  tenant bundle taken before archive is the recovery
 *                  path for mail data.)
 *   - restored   → status='active' + re-push mail rules
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
      const stalwart = await pushTenantMailRules(ctx, 'stripped');
      if (!stalwart.ok) return { status: 'retry', detail: `status=disabled set; rules strip pending: ${stalwart.detail}` };
      return { status: 'ok', detail: `set status=disabled (${stalwart.detail})` };
    }
    case 'active':
    case 'restored': {
      await ctx.db.update(mailboxes)
        .set({ status: 'active' })
        .where(eq(mailboxes.tenantId, ctx.tenantId));
      const stalwart = await pushTenantMailRules(ctx, 'live');
      if (!stalwart.ok) return { status: 'retry', detail: `status=active set; rules re-push pending: ${stalwart.detail}` };
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
 * Push every rules-bearing mailbox's Sieve state: `live` = from the DB
 * row (reactivate), `stripped` = forwarding/auto-reply off (suspend;
 * send-only keeps its ereject). Mirrors mail-rules-reconcile's desired-
 * state derivation — keep the two in step.
 */
async function pushTenantMailRules(
  ctx: HookCtx,
  mode: 'live' | 'stripped',
): Promise<{ ok: boolean; detail: string }> {
  try {
    const { getCachedPrincipalsAccountId } = await import('../../stalwart-jmap/client.js');
    const { applyMailRules, ensureSieveInterpreterLimits } = await import('../../stalwart-jmap/sieve.js');
    const rows = await ctx.db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.tenantId, ctx.tenantId));
    const relevant = rows.filter((r) =>
      r.stalwartPrincipalId &&
      (r.mailboxType === 'send_only' ||
        ((r.forwardingAddresses as string[] | null)?.length ?? 0) > 0 ||
        r.autoReply === 1),
    );
    if (relevant.length === 0) return { ok: true, detail: 'no rules-bearing mailboxes' };
    const accountId = await getCachedPrincipalsAccountId();
    if (!accountId) {
      return { ok: false, detail: `Stalwart unreachable with ${relevant.length} mailbox rule set(s) to push` };
    }
    if (mode === 'live' && relevant.some((r) => ((r.forwardingAddresses as string[] | null)?.length ?? 0) > 0)) {
      await ensureSieveInterpreterLimits({ accountId });
    }
    let pushed = 0;
    for (const r of relevant) {
      const mailboxType = r.mailboxType === 'send_only' ? 'send_only' : 'mailbox';
      const forwarding = mode === 'live' ? ((r.forwardingAddresses as string[] | null) ?? []) : [];
      const autoReply = mode === 'live' && mailboxType === 'mailbox' && r.autoReply === 1 && r.autoReplyBody
        ? { subject: r.autoReplySubject ?? null, body: r.autoReplyBody }
        : null;
      await applyMailRules({
        principalId: r.stalwartPrincipalId as string,
        mailboxType,
        forwardingAddresses: forwarding,
        autoReply,
      });
      pushed += 1;
    }
    return { ok: true, detail: `${mode === 'live' ? 're-pushed' : 'stripped'} rules on ${pushed} mailbox(es)` };
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
