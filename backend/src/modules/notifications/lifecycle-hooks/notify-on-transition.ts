/**
 * notify-tenant-on-transition lifecycle hook.
 *
 * Fires after every successful state transition (suspended / restored /
 * archived / deleted) and maps the transition to a notification
 * category. The hook runs at `order: 900` so it's the LAST thing the
 * dispatcher does — by the time we notify, the DB row + the ingress
 * cascade + every external-system cleanup hook have already completed,
 * so the tenant's notification accurately reflects the new state.
 *
 * `blocking: 'continue'` is critical: a notification-side failure
 * (SMTP relay down, template render error, even DB issues on the
 * deliveries table) must NEVER abort the operator's lifecycle action.
 * We swallow exceptions inside `run` and return `noop` so the
 * dispatcher records a clean transition.
 */

import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
  type Transition,
} from '../../tenant-lifecycle/registry/index.js';
import { emitEvent } from '../dispatcher/dispatch.js';

const TRANSITION_TO_CATEGORY: Partial<Record<Transition, string>> = {
  suspended: 'tenant.suspended',
  restored: 'tenant.restored',
  archived: 'tenant.archived',
  deleted: 'tenant.deleted',
};

async function runImpl(ctx: HookCtx): Promise<HookResult> {
  const categoryId = TRANSITION_TO_CATEGORY[ctx.transition];
  if (!categoryId) {
    return { status: 'noop', detail: `transition ${ctx.transition} has no category mapping` };
  }

  try {
    const suppressTenantNotification = ctx.suppressTenantNotification === true;
    const vars = await transitionVariables(ctx).catch(() => fallbackVariables(ctx));
    if (ctx.transition === 'archived') {
      const { notifyTenantArchived } = await import('../events.js');
      const r = await notifyTenantArchived(ctx.db, ctx.tenantId, { keptUntil: vars.keptUntil ?? 'for a limited time' }, { suppressTenantNotification });
      if (!r.ok) throw new Error(r.error ?? 'dispatch failed');
    } else if (ctx.transition === 'restored' || (ctx.transition === 'suspended' && ctx.restoredFromArchive)) {
      // A restore from archive ends suspended (applySuspendedFromArchive): the
      // tenant hears that its account is back, not that it was suspended.
      const { notifyTenantRestored } = await import('../events.js');
      const r = await notifyTenantRestored(ctx.db, ctx.tenantId, { mailboxNote: vars.mailboxNote }, { suppressTenantNotification });
      if (!r.ok) throw new Error(r.error ?? 'dispatch failed');
    } else {
      await emitEvent(ctx.db, {
        categoryId,
        scope: { kind: 'tenant', tenantId: ctx.tenantId },
        tenantId: ctx.tenantId,
        suppressTenantNotification,
        variables: {
          tenantId: ctx.tenantId,
          platformName: 'Hosting Platform',
        },
      });
    }
    return { status: 'ok' };
  } catch (err) {
    // Continue policy: never block a state transition because we
    // couldn't post a notification. Surface the error in the hook
    // result so it shows up in the Lifecycle Hooks UI.
    return {
      status: 'failed',
      detail: err instanceof Error ? err.message : String(err),
      envelope: {
        title: 'Tenant notification dispatch failed',
        detail: 'The state transition completed but the user-facing notification was not delivered.',
        remediation: [
          'Check the Notifications → Deliveries log for the relevant event id.',
          'Verify the default SMTP relay is reachable from the cluster.',
        ],
      },
    };
  }
}

/**
 * What the archive and restore notices say beyond the tenant's name: how long
 * the archive's backup is kept, and that restored mailboxes need new
 * passwords — the mail server never gives a stored password back, so the
 * archive cannot carry one.
 */
async function transitionVariables(ctx: HookCtx): Promise<Record<string, string>> {
  const { and, desc, eq, sql } = await import('drizzle-orm');
  const { mailboxes, storageSnapshots } = await import('../../../db/schema.js');
  if (ctx.transition === 'archived') {
    const [snap] = await ctx.db
      .select({ expiresAt: storageSnapshots.expiresAt })
      .from(storageSnapshots)
      .where(and(eq(storageSnapshots.tenantId, ctx.tenantId), eq(storageSnapshots.kind, 'pre-archive')))
      .orderBy(desc(storageSnapshots.createdAt))
      .limit(1);
    if (!snap) return { keptUntil: 'for a limited time' };
    return {
      keptUntil: snap.expiresAt
        ? `until ${snap.expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}`
        : 'with no end date',
    };
  }
  if (ctx.transition === 'restored' || (ctx.transition === 'suspended' && ctx.restoredFromArchive)) {
    const [row] = await ctx.db.select({ n: sql<number>`count(*)` }).from(mailboxes).where(eq(mailboxes.tenantId, ctx.tenantId));
    return Number(row?.n ?? 0) > 0
      ? { mailboxNote: 'Your mailboxes are back with their mail, but each needs a new password: set one under Email in your control panel.' }
      : {};
  }
  return {};
}

/** What the notices say when the details could not be read: true, if vaguer. */
function fallbackVariables(ctx: HookCtx): Record<string, string> {
  return ctx.transition === 'archived' ? { keptUntil: 'for a limited time' } : {};
}

export const notifyOnTransitionHook: LifecycleHook = {
  name: 'notify-tenant-on-transition',
  // Only the destructive / state-change transitions; `active` covers
  // both pending→active and suspended→active so we skip it here to
  // avoid double-notifying alongside `restored`.
  transitions: ['suspended', 'restored', 'archived', 'deleted'],
  order: 900,
  // Notification failure must never abort the transition.
  blocking: 'continue',
  // No retry budget — the dispatcher itself handles per-channel retries.
  maxAttempts: 1,
  after: [],
  run: runImpl,
};

let _registered = false;
export function registerNotifyOnTransitionHook(): void {
  if (_registered) return;
  registerLifecycleHook(notifyOnTransitionHook);
  _registered = true;
}

/** Test seam: re-arm the registration guard so the hook can be re-registered after registry reset. */
export function _resetNotifyOnTransitionRegistrationForTests(): void {
  _registered = false;
}
