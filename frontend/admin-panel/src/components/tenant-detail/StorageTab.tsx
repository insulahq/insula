/**
 * Tenant → Storage & backups: where the tenant runs and keeps its data, its
 * volumes and any storage operation in flight, the platform's backups of it,
 * and its volume snapshots.
 *
 * Placement, volumes and backups are the operator's. Snapshots are something
 * the tenant takes and restores itself, so they are listed here and managed
 * in the tenant panel.
 */
import { Loader2 } from 'lucide-react';
import type { Tenant } from '@/types/api';
import RetainedVolumesCard from '@/components/RetainedVolumesCard';
import OrphanedVolumesAlert from '@/components/OrphanedVolumesAlert';
import { useTenantPlacement } from '@/hooks/use-tenant-placement';
import { useTenantSnapshots } from '@/hooks/use-tenant-snapshots';
import PlacementSection from './PlacementSection';
import { StorageLifecycleCard } from './StorageLifecycleCard';
import { PvcPlacementSection } from './PvcPlacementSection';
import { TenantBundlesSummary, BackupsTab } from './TenantBackups';
import { useTenantBundles } from '@/hooks/use-tenant-bundles';
import { Card, Chip, formatGb } from './ui';
import TenantPanelLink from './TenantPanelLink';
import { tenantPanel } from './tenant-panel-paths';

export default function StorageTab({ tenant, tenantId }: { readonly tenant: Tenant; readonly tenantId: string }) {
  const { data: placementRes } = useTenantPlacement(tenantId);
  const placement = placementRes?.data.placement ?? null;
  const activeNodes = placement ? (placement.attachedNodes.length > 0 ? placement.attachedNodes : placement.workloadNodes) : [];
  const bundlesQuery = useTenantBundles(tenantId);

  return (
    <div className="space-y-6" data-testid="tenant-storage">
      <PlacementSection tenant={tenant} tenantId={tenantId} />

      <StorageLifecycleCard tenantId={tenantId} tenant={tenant}>
        <PvcPlacementSection tenantId={tenantId} pinnedNode={placement?.primaryNode ?? tenant.nodeName ?? null} activeNodes={activeNodes} />
      </StorageLifecycleCard>

      <RetainedVolumesCard tenantId={tenantId} />
      {tenant.kubernetesNamespace && <OrphanedVolumesAlert namespace={tenant.kubernetesNamespace} />}

      <Card title="Backups" testId="tenant-backups">
        <div className="space-y-4">
          <TenantBundlesSummary tenantId={tenantId} />
          <BackupsTab
            bundles={bundlesQuery.data?.data}
            isLoading={bundlesQuery.isLoading}
            error={bundlesQuery.error as Error | null}
            tenantId={tenantId}
          />
        </div>
      </Card>

      <SnapshotsCard tenantId={tenantId} />
    </div>
  );
}

function SnapshotsCard({ tenantId }: { readonly tenantId: string }) {
  const { data, isLoading } = useTenantSnapshots(tenantId);
  const snapshots = [...(data?.data?.snapshots ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <Card
      title={(
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Volume snapshots</h2>
          <span className="text-[13px] text-gray-500 dark:text-gray-400">Fast local restore points on this cluster — not a backup</span>
        </div>
      )}
      actions={<TenantPanelLink tenantId={tenantId} to={tenantPanel.snapshots()} label="Snapshots" variant="button" testId="tp-snapshots">Take or restore a snapshot</TenantPanelLink>}
      bodyClassName="overflow-x-auto"
      testId="tenant-snapshots"
    >
      {isLoading ? (
        <div className="flex items-center gap-2 px-5 py-4 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : snapshots.length === 0 ? (
        <p className="px-5 py-4 text-sm text-gray-600 dark:text-gray-400">No snapshots.</p>
      ) : (
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
              <th scope="col" className="px-5 py-2.5 font-medium">Taken</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Label</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-5 py-2.5 text-right font-medium">Holds</th>
              <th scope="col" className="px-5 py-2.5 font-medium">Expires</th>
            </tr>
          </thead>
          <tbody>
            {snapshots.map((s) => (
              <tr key={s.id} className="border-b border-gray-100 last:border-0 dark:border-gray-700">
                <td className="px-5 py-3 font-medium text-gray-900 dark:text-gray-100">{new Date(s.createdAt).toLocaleString()}</td>
                <td className="px-5 py-3 text-gray-700 dark:text-gray-300">{s.label ?? <span className="text-gray-400">—</span>}</td>
                <td className="px-5 py-3"><Chip tone={s.status === 'ready' ? 'ok' : s.status === 'error' ? 'bad' : 'info'}>{s.status}</Chip></td>
                <td className="px-5 py-3 text-right tabular-nums">{s.dataSizeBytes == null ? <span className="text-gray-400" title="Not measured">—</span> : formatGb(s.dataSizeBytes / 1e9)}</td>
                <td className="px-5 py-3 text-gray-600 dark:text-gray-400">{new Date(s.expiresAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
