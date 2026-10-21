import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useCanManage } from '@/hooks/use-can-manage';
import { useCheckUpdatesBatch, useSetAutoUpdate, useUpdateNowCustomDeployment } from '@/hooks/use-custom-deployments';
import type { Deployment } from '@/types/api';
import { UpdatesPill } from './UpdatesPill';
import { UpgradeTagModal, suggestedUpgradeImage } from './UpgradeTagModal';

/**
 * Updates for a custom application in its details modal: the same check,
 * re-pull and auto-update the Custom Containers tab offers. The Applications
 * page opens every app here, and for a custom one there was nothing — the
 * upgrade card asks the catalog, which has no versions of a custom image and
 * refuses the request.
 */
export function CustomUpdatesCard({ tenantId, deployment }: {
  readonly tenantId: string;
  readonly deployment: Pick<Deployment, 'id' | 'name' | 'customSpec'>;
}) {
  const canManage = useCanManage();
  const queryClient = useQueryClient();
  const updatesQuery = useCheckUpdatesBatch(tenantId, [deployment.id]);
  const updates = updatesQuery.data?.data.results?.[deployment.id];
  const updateNow = useUpdateNowCustomDeployment(tenantId);
  const autoUpdate = useSetAutoUpdate(tenantId);
  const [upgrading, setUpgrading] = useState(false);
  // The modal reads the Applications page's deployment list, not the custom
  // list these mutations refresh.
  const refreshDeployments = () => queryClient.invalidateQueries({ queryKey: ['deployments', tenantId] });

  const services = Object.keys(deployment.customSpec?.services ?? {});
  // A stack has one digest per service, so "the image changed" has no single
  // meaning for it to act on (CustomContainersTab).
  const singleContainer = deployment.customSpec?.sourceMode === 'simple';

  const repull = () => {
    const what = singleContainer ? `"${deployment.name}"` : `all ${services.length} images in "${deployment.name}"`;
    if (!confirm(`Re-pull ${what} at the current tag and restart? The container stops briefly while the new image starts.`)) return;
    updateNow.mutate(deployment.id, { onSettled: refreshDeployments });
  };

  return (
    <div className="mb-6 rounded-lg border border-gray-200 p-4 dark:border-gray-700" data-testid="custom-updates-card">
      <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">Updates</h3>
      <div className="flex flex-wrap items-center gap-3">
        <UpdatesPill
          result={updates}
          loading={updatesQuery.isLoading}
          canManage={canManage}
          onUpgrade={() => setUpgrading(true)}
          onRepull={repull}
        />
        {canManage && (
          <button
            type="button"
            onClick={repull}
            disabled={updateNow.isPending}
            title="Re-pull the current tag and restart"
            data-testid="custom-detail-update-now"
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-blue-400 dark:hover:text-blue-300"
          >
            <RefreshCw size={12} className={updateNow.isPending ? 'animate-spin' : undefined} />
            {updateNow.isPending ? 'Updating…' : 'Update'}
          </button>
        )}
        {canManage && singleContainer && (
          <label
            className="inline-flex cursor-pointer items-center gap-1 text-xs text-gray-600 dark:text-gray-400"
            title="Check hourly and re-pull automatically when this tag is republished. Never changes the tag."
          >
            <input
              type="checkbox"
              checked={deployment.customSpec?.autoUpdate ?? false}
              onChange={(e) => autoUpdate.mutate({ id: deployment.id, enabled: e.target.checked }, { onSettled: refreshDeployments })}
              disabled={autoUpdate.isPending}
              data-testid="custom-detail-auto-update"
              className="h-3 w-3 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800"
            />
            Auto-update
          </label>
        )}
      </div>
      {(updateNow.error ?? autoUpdate.error) && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          {(updateNow.error ?? autoUpdate.error) instanceof Error ? (updateNow.error ?? autoUpdate.error)?.message : 'The update failed'}
        </p>
      )}
      {upgrading && (
        <UpgradeTagModal
          tenantId={tenantId}
          row={deployment}
          suggestedImage={suggestedUpgradeImage(deployment.customSpec, updates)}
          onClose={() => { setUpgrading(false); void refreshDeployments(); }}
        />
      )}
    </div>
  );
}
