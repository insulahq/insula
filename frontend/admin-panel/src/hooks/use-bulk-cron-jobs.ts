import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BulkIdResult } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import { outcomeFromIdResult, type BulkItemOutcome, type BulkRunItem } from '@/lib/bulk-run';

/**
 * Per-cron-job steps for the Tenants → Cron Jobs bulk bar. Each sends ONE id
 * through the existing bulk endpoint, so server behaviour is unchanged;
 * `useBulkRun` sequences them and invalidates once at the end.
 */

export type CronJobBulkAction = 'enable' | 'disable' | 'delete';

const SUCCESS_DETAIL: Readonly<Record<CronJobBulkAction, string>> = {
  enable: 'Enabled',
  disable: 'Disabled',
  delete: 'Deleted',
};

export async function runCronJobBulkItem(action: CronJobBulkAction, item: BulkRunItem): Promise<BulkItemOutcome> {
  const res = await apiFetch<{ data: BulkIdResult }>('/api/v1/admin/cron-jobs/bulk', {
    method: 'POST',
    body: JSON.stringify({ cron_job_ids: [item.id], action }),
  });
  return outcomeFromIdResult(res.data, item.id, SUCCESS_DETAIL[action]);
}

export function useInvalidateCronJobQueries(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['cron-jobs'] });
  }, [queryClient]);
}
