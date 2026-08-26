import { eq } from 'drizzle-orm';
import { emailAliases } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';

/**
 * email-aliases-enable hook.
 *
 *   - active     → enabled=1 + recreate the Stalwart MailingLists
 *   - suspended  → enabled=0 + DESTROY the Stalwart MailingLists (a
 *                  suspended tenant's alias must stop accepting mail
 *                  immediately — before 2026-08 `enabled` was DB-only
 *                  fiction so the flag alone was "enough"; now the
 *                  MailingList is the live delivery path)
 *   - archived   → destroy the MailingLists, then DELETE the rows
 *                  (destroy FIRST: the boot reconcile's orphan
 *                  detection is keyed off email_aliases rows, so a
 *                  row deleted before its list is destroyed leaves an
 *                  invisible forwarder running forever)
 *   - restored   → enabled=1 + recreate (rows restored by the
 *                  storage-lifecycle restore op are that op's
 *                  responsibility; this hook flips + re-provisions)
 *
 * Stalwart-side failures do NOT abort the transition: the retrying
 * hook scheduler + the boot reconcile converge, and the DB flag is
 * the authoritative intent. A `retry` status is returned so the
 * 2-minute hook scheduler re-runs the Stalwart half.
 *
 * blocking=abort: same Stalwart view dependency as mailboxes-status.
 */
async function runImpl(ctx: HookCtx): Promise<HookResult> {
  switch (ctx.transition) {
    case 'archived': {
      const stalwart = await destroyTenantLists(ctx);
      if (!stalwart.ok) {
        // 2026-08-25 drift audit: rows used to be deleted even when the
        // destroy failed — the retry re-run then found no rows, leaving a
        // permanently orphaned live MailingList invisible to the orphan
        // detection (keyed off email_aliases rows). Retry BEFORE deleting
        // so the rows keep pointing at the leftover list.
        return { status: 'retry', detail: `archive blocked on Stalwart list destroy: ${stalwart.detail}` };
      }
      await ctx.db.delete(emailAliases).where(eq(emailAliases.tenantId, ctx.tenantId));
      return { status: 'ok', detail: `archived: deleted email_aliases (${stalwart.detail})` };
    }
    case 'suspended': {
      const stalwart = await destroyTenantLists(ctx);
      await ctx.db.update(emailAliases)
        .set({ enabled: 0 })
        .where(eq(emailAliases.tenantId, ctx.tenantId));
      if (!stalwart.ok) return { status: 'retry', detail: `enabled=0 set; Stalwart destroy pending: ${stalwart.detail}` };
      return { status: 'ok', detail: `set enabled=0 (${stalwart.detail})` };
    }
    case 'active':
    case 'restored': {
      await ctx.db.update(emailAliases)
        .set({ enabled: 1 })
        .where(eq(emailAliases.tenantId, ctx.tenantId));
      const stalwart = await recreateTenantLists(ctx);
      if (!stalwart.ok) return { status: 'retry', detail: `enabled=1 set; Stalwart recreate pending: ${stalwart.detail}` };
      return { status: 'ok', detail: `set enabled=1 (${stalwart.detail})` };
    }
    default:
      return { status: 'noop', detail: `unhandled transition '${ctx.transition}'` };
  }
}

/** Destroy every Stalwart MailingList backing this tenant's aliases. */
async function destroyTenantLists(ctx: HookCtx): Promise<{ ok: boolean; detail: string }> {
  try {
    const { getCachedPrincipalsAccountId } = await import('../../stalwart-jmap/client.js');
    const { destroyMailingList } = await import('../../stalwart-jmap/mailing-lists.js');
    const rows = await ctx.db.select({ id: emailAliases.id, stalwartListId: emailAliases.stalwartListId })
      .from(emailAliases)
      .where(eq(emailAliases.tenantId, ctx.tenantId));
    const provisioned = rows.filter((r) => r.stalwartListId);
    if (provisioned.length === 0) return { ok: true, detail: 'no provisioned lists' };
    const accountId = await getCachedPrincipalsAccountId();
    if (!accountId) {
      // With live list ids an unreachable Stalwart must retry, not proceed.
      return { ok: false, detail: `Stalwart unreachable with ${provisioned.length} list(s) to destroy` };
    }
    let destroyed = 0;
    for (const row of rows) {
      if (!row.stalwartListId) continue;
      await destroyMailingList({ accountId, listId: row.stalwartListId });
      await ctx.db.update(emailAliases).set({ stalwartListId: null }).where(eq(emailAliases.id, row.id));
      destroyed += 1;
    }
    return { ok: true, detail: `destroyed ${destroyed} MailingList(s)` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Recreate lists for this tenant's (now re-enabled) aliases. */
async function recreateTenantLists(ctx: HookCtx): Promise<{ ok: boolean; detail: string }> {
  try {
    const { getCachedPrincipalsAccountId } = await import('../../stalwart-jmap/client.js');
    const { createMailingList } = await import('../../stalwart-jmap/mailing-lists.js');
    const { emailDomains } = await import('../../../db/schema.js');
    const rows = await ctx.db.select().from(emailAliases).where(eq(emailAliases.tenantId, ctx.tenantId));
    if (rows.every((r) => r.stalwartListId)) return { ok: true, detail: 'no lists to recreate' };
    const accountId = await getCachedPrincipalsAccountId();
    if (!accountId) return { ok: true, detail: 'Stalwart unreachable — boot reconcile converges' };
    let created = 0;
    for (const row of rows) {
      if (row.stalwartListId) continue;
      const [ed] = await ctx.db.select({ stalwartDomainId: emailDomains.stalwartDomainId })
        .from(emailDomains)
        .where(eq(emailDomains.id, row.emailDomainId));
      if (!ed?.stalwartDomainId) continue;
      const listId = await createMailingList({
        accountId,
        localPart: row.sourceAddress.split('@')[0],
        stalwartDomainId: ed.stalwartDomainId,
        destinations: (row.destinationAddresses as string[]) ?? [],
      });
      await ctx.db.update(emailAliases).set({ stalwartListId: listId }).where(eq(emailAliases.id, row.id));
      created += 1;
    }
    return { ok: true, detail: `recreated ${created} MailingList(s)` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export const emailAliasesEnableHook: LifecycleHook = {
  name: 'email-aliases-enable',
  transitions: ['active', 'suspended', 'archived', 'restored'],
  order: 230,
  blocking: 'abort',
  run: runImpl,
};

let _registered = false;
export function registerEmailAliasesEnableHook(): void {
  if (_registered) return;
  registerLifecycleHook(emailAliasesEnableHook);
  _registered = true;
}
