import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BulkTenantResult } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
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

export function useInvalidateTenantQueries(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['tenants'] });
  }, [queryClient]);
}
