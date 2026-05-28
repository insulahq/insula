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
    await emitEvent(ctx.db, {
      categoryId,
      scope: { kind: 'tenant', tenantId: ctx.tenantId },
      tenantId: ctx.tenantId,
      suppressTenantNotification: ctx.suppressTenantNotification === true,
      variables: {
        tenantId: ctx.tenantId,
        platformName: 'Hosting Platform',
      },
    });
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
