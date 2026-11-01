import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BulkTenantResult, MigrateToWorkerResult, SubscriptionResponse, TenantMoveOperation } from '@insula/api-contracts';
import { apiFetch, ApiError } from '@/lib/api-client';
import { plural, type BulkItemOutcome, type BulkRunItem } from '@/lib/bulk-run';
import type { BulkOpResponse } from '@/hooks/use-lifecycle';

/**
 * Per-tenant steps for the Tenants list bulk bar. Each sends ONE id through
 * the existing bulk endpoint (same cascade, same SYSTEM-tenant guard), then
 * reads back the lifecycle transition it dispatched: the endpoint counts a
 * tenant as succeeded once the transition ran, even when some of its hooks
 * failed and were queued for retry.
 */

export type TenantBulkAction = 'suspend' | 'reactivate' | 'delete';

const DONE: Readonly<Record<TenantBulkAction, string>> = {
  suspend: 'Suspended',
  reactivate: 'Reactivated',
  delete: 'Deleted',
};

export async function runTenantBulkItem(action: TenantBulkAction, item: BulkRunItem): Promise<BulkItemOutcome> {
  const res = action === 'delete'
    ? await apiFetch<{ data: BulkTenantResult }>('/api/v1/admin/tenants/bulk', {
      method: 'DELETE',
      body: JSON.stringify({ tenant_ids: [item.id] }),
    })
    : await apiFetch<{ data: BulkTenantResult }>('/api/v1/admin/tenants/bulk', {
      method: 'POST',
      body: JSON.stringify({ tenant_ids: [item.id], action }),
    });

  const failure = res.data.failed.find((f) => f.id === item.id);
  if (failure) return { status: 'failed', detail: failure.error ?? 'The API reported a failure without a reason.' };
  if (!res.data.succeeded.some((s) => s.id === item.id)) {
    return { status: 'failed', detail: 'The API returned no result for this tenant.' };
  }
  return readTransition(DONE[action], res.data.bulkOpId);
}

async function readTransition(done: string, bulkOpId: string): Promise<BulkItemOutcome> {
  let progress: BulkOpResponse;
  try {
    const res = await apiFetch<{ data: BulkOpResponse }>(
      `/api/v1/admin/lifecycle/bulk-ops/${encodeURIComponent(bulkOpId)}`,
    );
    progress = res.data;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'succeeded', detail: `${done}. Lifecycle hook results could not be read: ${reason}` };
  }
  return describeTransition(done, progress);
}

export function describeTransition(done: string, progress: BulkOpResponse): BulkItemOutcome {
  const transition = progress.transitions[0];
  if (!transition) return { status: 'succeeded', detail: `${done}. No lifecycle transition was recorded.` };

  const runs = progress.hookRuns[transition.id] ?? [];
  const ok = runs.filter((r) => r.state === 'ok' || r.state === 'noop').length;
  const failed = runs.filter((r) => r.state === 'failed');
  const pending = runs.filter((r) => r.state === 'pending' || r.state === 'running').length;
  const lines = failed.map((r) => {
    const err = r.lastError;
    const reason = err ? `${err.title}${err.detail ? ` — ${err.detail}` : ''}` : 'failed';
    return `${r.hookName} (attempt ${r.attempts}/${r.maxAttempts}): ${reason}`;
  });

  switch (transition.state) {
    case 'completed':
      return { status: 'succeeded', detail: `${done} — ${plural(ok, 'lifecycle hook')} ok` };
    case 'running':
      return { status: 'succeeded', detail: `${done} — ${pending} of ${plural(runs.length, 'lifecycle hook')} still running` };
    case 'failed_blocking':
      return {
        status: 'failed',
        detail: 'A blocking lifecycle hook failed, so the transition stopped part-way.',
        lines,
      };
    case 'failed_partial':
    default:
      return {
        status: 'failed',
        detail: `${failed.length} of ${plural(runs.length, 'lifecycle hook')} failed; failed hooks are retried in the background.`,
        lines,
      };
  }
}

// ─── Change placement / Change subscription plan ─────────────────────────────
//
// Unlike suspend/reactivate/delete these have no bulk endpoint: each runs the
// SAME per-tenant request the tenant detail page sends — the Placement card's
// "Migrate pods now" and the Subscription card's plan change — one tenant at
// a time through useBulkRun. The row carries what the tenant is on now, so a
// tenant already where it is being sent is skipped without a request: a
// migrate restarts every Deployment (downtime for nothing), and a plan
// "change" to the same plan would email the tenant about nothing.

/** A tenants-table row as the placement / plan runners need it. */
export interface TenantChangeItem extends BulkRunItem {
  readonly planId: string;
  readonly nodeName: string | null;
  /** True when the tenant is NOT on its primary node right now. */
  readonly misplaced: boolean;
}

/** A target as chosen in the confirm modal: its id plus what to call it. */
export interface BulkTarget {
  readonly id: string;
  readonly label: string;
}

/** How a bulk move waits for the background operation that moves a running tenant. */
export interface MoveWait {
  readonly pollMs: number;
  readonly maxMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

const MOVE_WAIT: MoveWait = {
  pollMs: 2_000,
  // A move is about a minute of downtime; the cap is for one that hangs.
  maxMs: 15 * 60_000,
  sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  now: () => Date.now(),
};

/**
 * Re-pin to `target` and move the tenant there (POST …/migrate-to-worker).
 *
 * A running tenant is moved by a background operation, and how it ENDED is the
 * row's outcome — not that it started. The row used to read "stopped, moved and
 * started by a background operation" while the operation finished with "its
 * data has NOT moved" that only its Task Tracker entry showed (production: two
 * of five tenants of one bulk move left their data behind, and the bulk run said
 * nothing). So the row waits for it — the tenants move one after another, as
 * every bulk action runs its rows.
 */
export async function moveTenantToNodeItem(
  item: TenantChangeItem,
  target: BulkTarget,
  wait: MoveWait = MOVE_WAIT,
): Promise<BulkItemOutcome> {
  if (item.nodeName === target.id && !item.misplaced) {
    return { status: 'skipped', detail: `Already on ${target.label}.` };
  }
  const res = await apiFetch<{ data: MigrateToWorkerResult }>(
    `/api/v1/admin/tenants/${encodeURIComponent(item.id)}/migrate-to-worker`,
    { method: 'POST', body: JSON.stringify({ node_name: target.id }) },
  );
  if (!res.data.moveOperationId) return describeMove(res.data, target.label);
  return describeMoveOperation(await waitForMove(res.data.moveOperationId, wait), target.label, wait.maxMs);
}

/** How waiting for a move ended. */
export type MoveWaitResult =
  | { readonly kind: 'finished'; readonly op: TenantMoveOperation }
  /** Still running at the cap. */
  | { readonly kind: 'timed-out' }
  /** The operation cannot be read, and asking again will not change that (signed out, gone). */
  | { readonly kind: 'unreadable'; readonly reason: string };

/** An answer that waiting will not change: signed out, not allowed, no such operation. */
function isPermanent(err: unknown): boolean {
  return err instanceof ApiError && [401, 403, 404].includes(err.status);
}

/**
 * Poll a move's storage operation until it has finished or failed, or `maxMs`
 * has passed. A read that fails for a passing reason is tried again until
 * then; one that will keep failing ends the wait. The move runs on regardless
 * of this tab.
 */
export async function waitForMove(operationId: string, wait: MoveWait = MOVE_WAIT): Promise<MoveWaitResult> {
  const deadline = wait.now() + wait.maxMs;
  for (;;) {
    try {
      const res = await apiFetch<{ data: TenantMoveOperation }>(
        `/api/v1/admin/storage/operations/${encodeURIComponent(operationId)}`,
      );
      if (res.data.state === 'idle' || res.data.state === 'failed') return { kind: 'finished', op: res.data };
    } catch (err) {
      if (isPermanent(err)) return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
    }
    if (wait.now() >= deadline) return { kind: 'timed-out' };
    await wait.sleep(wait.pollMs);
  }
}

/** A finished move operation as a row. A tenant running on the target with its data left behind is not done. */
export function describeMoveOperation(result: MoveWaitResult, targetLabel: string, waitedMs: number): BulkItemOutcome {
  if (result.kind === 'timed-out') {
    const minutes = Math.max(1, Math.round(waitedMs / 60_000));
    return {
      status: 'failed',
      detail: `Still moving to ${targetLabel} after ${plural(minutes, 'minute')}. The move keeps running; `
        + 'follow it in the Task Tracker.',
    };
  }
  if (result.kind === 'unreadable') {
    return {
      status: 'failed',
      detail: `The move to ${targetLabel} started, but how it went cannot be read (${result.reason}). `
        + 'Follow it in the Task Tracker.',
    };
  }
  const { op } = result;
  if (op.state === 'failed') {
    return { status: 'failed', detail: op.lastError ?? `Moving to ${targetLabel} failed, and the operation recorded no reason.` };
  }
  const blocker = op.params?.copyBlocker;
  if (blocker) {
    // Stays selected for "Retry failed": a move to the node it already runs on
    // holds its volume there too.
    return {
      status: 'failed',
      detail: op.progressMessage ?? `Running on ${targetLabel}, but its data has NOT moved: ${blocker.cause} — ${blocker.action}.`,
    };
  }
  return { status: 'succeeded', detail: op.progressMessage ?? `Moved to ${targetLabel}.` };
}

/**
 * What one migrate-to-worker did without a background operation (a tenant that
 * was stopped, or already running on the target), in the same terms as the
 * Placement card's note. A background move is `describeMoveOperation`.
 */
export function describeMove(result: MigrateToWorkerResult, targetLabel: string): BulkItemOutcome {
  const { started, error } = result.dataRelocation;
  if (error) {
    // The pin changed but the data did not follow: not done yet, so it stays
    // selected for a retry instead of reading as a success.
    return {
      status: 'failed',
      detail: `Pinned to ${targetLabel}, but the data could not be moved: ${error}`,
    };
  }
  const parts = [`Pinned to ${targetLabel}`];
  if (result.deploymentsRestarted > 0) parts.push(`restarted ${plural(result.deploymentsRestarted, 'deployment')}`);
  if (started.length > 0) parts.push(`moving ${plural(started.length, 'volume')}`);
  return { status: 'succeeded', detail: `${parts.join(' — ')}.` };
}

/** Set the hosting plan (PATCH …/subscription), as the Subscription card does. */
export async function changeTenantPlanItem(
  item: TenantChangeItem,
  target: BulkTarget,
  notifyTenant: boolean,
): Promise<BulkItemOutcome> {
  if (item.planId === target.id) {
    return { status: 'skipped', detail: `Already on ${target.label}.` };
  }
  const res = await apiFetch<{ data: SubscriptionResponse }>(
    `/api/v1/tenants/${encodeURIComponent(item.id)}/subscription`,
    { method: 'PATCH', body: JSON.stringify({ plan_id: target.id, notify_tenant: notifyTenant }) },
  );
  return describePlanChange(res.data, target);
}

export function describePlanChange(result: SubscriptionResponse, target: BulkTarget): BulkItemOutcome {
  // Read back what the API now says the plan is, rather than trusting the 200.
  if (result.plan?.id !== target.id) {
    return {
      status: 'failed',
      detail: `The API accepted the change but reports the plan as ${result.plan?.name ?? 'none'}.`,
    };
  }
  return { status: 'succeeded', detail: `Plan set to ${result.plan.name}.` };
}

export function useInvalidateTenantQueries(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['tenants'] });
    // A placement or plan change also moves what these derive from.
    void queryClient.invalidateQueries({ queryKey: ['tenant-placement'] });
    void queryClient.invalidateQueries({ queryKey: ['tenant-issues'] });
    void queryClient.invalidateQueries({ queryKey: ['subscription'] });
  }, [queryClient]);
}
