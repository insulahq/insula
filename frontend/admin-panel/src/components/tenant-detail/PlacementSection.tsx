/**
 * Where this tenant runs, against where it should.
 *
 * One card per node that matters, marked ACTIVE (its pods run there / its
 * volume is attached there), PINNED (its primary node: where it should run
 * and keep its data) and DATA (holds a replica). The two most often confused —
 * active and pinned — differ in shape as well as colour: a solid green card
 * with a dot, a dashed blue outline with a pin. When they differ, the
 * misplaced banner offers the two ways out.
 *
 * Below, the pin and tier controls: saving the pin only records intent;
 * "Save and move pods now" also restarts the pods so they move.
 */
import { useState } from 'react';
import { Database, Loader2, Pin, Rocket, Save } from 'lucide-react';
import clsx from 'clsx';
import type { Tenant } from '@/types/api';
import MigrateResultNote from '@/components/tenants/MigrateResultNote';
import { MisplacedBanner, FailoverList, type PendingAction } from '@/components/tenants/PlacementStatusPanel';
import { useUpdateTenant } from '@/hooks/use-tenants';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import { useWorkerUsageSummary } from '@/hooks/use-worker-usage';
import { useMigrateTenantToWorker } from '@/hooks/use-tenant-migration';
import { useTenantPlacement } from '@/hooks/use-tenant-placement';
import { useNodeLabel } from '@/hooks/use-node-labels';
import { Card, Chip } from './ui';
import { formatAvailability } from './placement-format';

export default function PlacementSection({ tenant, tenantId }: { readonly tenant: Tenant; readonly tenantId: string }) {
  const { data: placementRes, isLoading } = useTenantPlacement(tenantId);
  const placement = placementRes?.data.placement ?? null;
  const failovers = placementRes?.data.failovers ?? [];
  const { data: nodesRes } = useClusterNodes();
  const { data: usageRes } = useWorkerUsageSummary();
  const update = useUpdateTenant(tenantId);
  const migrate = useMigrateTenantToWorker(tenantId);
  const nodeLabel = useNodeLabel();
  const [pending, setPending] = useState<PendingAction>(null);
  const [pinTarget, setPinTarget] = useState<string>(tenant.nodeName ?? '');
  const [tierTarget, setTierTarget] = useState<'local' | 'ha'>(tenant.storageTier ?? 'local');

  const nodes = (nodesRes?.data ?? []).filter((n) => n.canHostTenantWorkloads);
  const usageByName = new Map((usageRes?.data ?? []).map((u) => [u.name, u]));
  const active = placement ? (placement.workloadNodes.length > 0 ? placement.workloadNodes : placement.attachedNodes) : [];
  const pinned = placement?.primaryNode ?? tenant.nodeName ?? null;
  const dataNodes = placement?.dataNodes ?? [];
  const misplaced = placement?.status === 'misplaced';
  const hasChanges = (pinTarget || null) !== (tenant.nodeName ?? null) || tierTarget !== (tenant.storageTier ?? 'local');

  // Nodes this tenant touches first, then the rest of the tenant-capable ones.
  const involved = (name: string) => active.includes(name) || name === pinned || dataNodes.includes(name);
  const cards = [
    ...nodes.filter((n) => involved(n.name)),
    ...nodes.filter((n) => !involved(n.name)),
  ];
  // A node the placement names that the node list does not (removed, or the
  // list not loaded yet) still gets its card.
  for (const name of [...active, ...(pinned ? [pinned] : []), ...dataNodes]) {
    if (!cards.some((n) => n.name === name)) cards.unshift({ name, cordoned: false } as (typeof nodes)[number]);
  }

  const runPending = async () => {
    if (!pending) return;
    try {
      await migrate.mutateAsync(pending.node);
      setPending(null);
    } catch { /* surfaced via migrate.error */ }
  };
  const save = async (move: boolean) => {
    try {
      await update.mutateAsync({ node_name: pinTarget === '' ? null : pinTarget, storage_tier: tierTarget });
      if (move && pinTarget) await migrate.mutateAsync(pinTarget);
    } catch { /* surfaced via update.error / migrate.error */ }
  };
  const actionError = (update.error ?? migrate.error) as { message?: string } | null;

  return (
    <Card
      id="placement"
      title={(
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Placement</h2>
          {misplaced ? <Chip tone="warn">Away from pinned node</Chip> : placement?.status === 'placed' ? <Chip tone="ok">On its pinned node</Chip> : null}
        </div>
      )}
      actions={(
        <span className="flex flex-wrap gap-3.5 text-xs text-gray-600 dark:text-gray-400">
          <span className="inline-flex items-center gap-1.5"><ActiveBadge />where its pods run now</span>
          <span className="inline-flex items-center gap-1.5"><PinnedBadge />where it should run and keep its data</span>
          <span className="inline-flex items-center gap-1.5"><DataBadge />holds a copy of its data</span>
        </span>
      )}
      testId="placement-section"
    >
      <div className="space-y-4">
        {isLoading && (
          <p className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400"><Loader2 size={12} className="animate-spin" /> Checking where this tenant runs…</p>
        )}
        {!isLoading && (!placement || placement.status === 'unknown') && (
          <p className="text-xs text-gray-500 dark:text-gray-400">Where this tenant runs has not been observed yet.</p>
        )}

        {misplaced && placement && (
          <MisplacedBanner
            placement={placement}
            pending={pending}
            busy={migrate.isPending}
            onChoose={setPending}
            onConfirm={runPending}
            onCancel={() => setPending(null)}
          />
        )}

        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3.5" data-testid="placement-nodes">
          {cards.map((n) => {
            const isActive = active.includes(n.name);
            const isPinned = n.name === pinned;
            const holdsData = dataNodes.includes(n.name);
            const usage = usageByName.get(n.name);
            return (
              <div
                key={n.name}
                className={clsx(
                  'min-w-0 rounded-xl p-3.5',
                  isActive
                    ? 'border-2 border-green-500 bg-green-50 dark:border-green-600 dark:bg-green-900/20'
                    : isPinned
                      ? 'border-2 border-dashed border-brand-500 dark:border-brand-400'
                      : 'border border-gray-200 dark:border-gray-700',
                  !isActive && !isPinned && !holdsData && 'opacity-80',
                )}
                data-testid={`placement-node-${n.name}`}
                data-active={isActive || undefined}
                data-pinned={isPinned || undefined}
              >
                <div className="flex flex-wrap gap-1.5">
                  {isActive && <ActiveBadge />}
                  {isPinned && <PinnedBadge />}
                  {holdsData && <DataBadge />}
                  {!isActive && !isPinned && !holdsData && <Chip>Not used</Chip>}
                </div>
                <div className="mt-1.5 text-base font-bold text-gray-900 dark:text-gray-100">{nodeLabel(n.name)}</div>
                <ul className="mt-1.5 space-y-0.5 text-[13px] text-gray-700 dark:text-gray-300">
                  {isActive && <li>{placement?.workloadNodes.includes(n.name) ? 'Its pods run here' : 'Its volume is attached here'}</li>}
                  {holdsData && <li>Holds a replica of its data</li>}
                  {isPinned && !isActive && active.length > 0 && <li className="text-amber-700 dark:text-amber-400">Pinned here, but it runs elsewhere now</li>}
                  {isPinned && active.length === 0 && <li>Nothing runs now: no pod, no attached volume</li>}
                  {isActive && !holdsData && dataNodes.length > 0 && <li className="text-amber-700 dark:text-amber-400">Reads its data over the network</li>}
                  {n.cordoned && <li className="text-amber-700 dark:text-amber-400">Cordoned: no new pods are scheduled here</li>}
                  {usage && <li className="text-xs text-gray-500 dark:text-gray-400">{formatAvailability(usage).replace(/^ — /, '')}</li>}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-1 items-end gap-3 border-t border-gray-200 pt-4 sm:grid-cols-[1fr_1fr_auto] dark:border-gray-700">
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 dark:text-gray-300">Pinned node</span>
            <select
              value={pinTarget}
              onChange={(e) => setPinTarget(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              data-testid="placement-worker-select"
            >
              <option value="">Auto: the scheduler picks by free capacity</option>
              {nodes.map((n) => (
                <option key={n.name} value={n.name}>{nodeLabel(n.name)}{n.cordoned ? ' (cordoned)' : ''}{formatAvailability(usageByName.get(n.name))}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-gray-700 dark:text-gray-300">Storage tier</span>
            <select
              value={tierTarget}
              onChange={(e) => setTierTarget(e.target.value as 'local' | 'ha')}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              data-testid="placement-tier-select"
            >
              <option value="local">Local: 1 replica, restore from backup if the node is lost</option>
              <option value="ha" disabled={nodes.length < 3 && (tenant.storageTier ?? 'local') !== 'ha'}>
                HA: 2 replicas, automatic failover in 30–90 s, 2× storage
                {nodes.length < 3 && (tenant.storageTier ?? 'local') !== 'ha' ? ` (needs 3 tenant nodes; the cluster has ${nodes.length})` : ''}
              </option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => save(false)}
              disabled={!hasChanges || update.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              title="Records where the tenant should run; running pods move at their next restart"
              data-testid="placement-save-button"
            >
              {update.isPending && !migrate.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save pin
            </button>
            <button
              type="button"
              onClick={() => save(true)}
              disabled={!pinTarget || update.isPending || migrate.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              title={!pinTarget ? 'Pick a node first' : 'Saves the pin AND restarts the pods so they move now'}
              data-testid="placement-migrate-button"
            >
              {migrate.isPending ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
              Save and move pods now
            </button>
          </div>
        </div>
        {tierTarget !== (tenant.storageTier ?? 'local') && (
          <p className="text-xs text-brand-700 dark:text-brand-300">Tier changes apply live; the replica rebuild runs in the background.</p>
        )}
        {actionError && <p className="text-xs text-red-600 dark:text-red-400" data-testid="placement-action-error">{actionError.message ?? 'The placement change failed.'}</p>}
        {migrate.isSuccess && migrate.data && <MigrateResultNote result={migrate.data.data} />}
        {failovers.length > 0 && <FailoverList failovers={failovers} />}
      </div>
    </Card>
  );
}

function ActiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-700 px-2 py-0.5 text-[11px] font-semibold text-white dark:bg-green-600">
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />ACTIVE
    </span>
  );
}

function DataBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-blue-600 px-2 py-0.5 text-[11px] font-semibold text-white dark:bg-blue-500" data-testid="data-badge">
      <Database size={10} aria-hidden="true" />DATA
    </span>
  );
}

function PinnedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-brand-500 px-2 py-0.5 text-[11px] font-semibold text-brand-700 dark:border-brand-400 dark:text-brand-300">
      <Pin size={10} aria-hidden="true" />PINNED
    </span>
  );
}
