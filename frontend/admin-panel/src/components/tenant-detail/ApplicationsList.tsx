/**
 * The tenant's applications, read-only, with the controls that are the
 * platform's to decide: whether a custom container may run as root, and —
 * for a database instance — repairing the platform's own administrator login
 * when it has been lost (the admin notification "Platform lost its login to a
 * tenant database" points here).
 *
 * Starting, stopping, restarting and deleting are the tenant panel's
 * (Applications → Installed); a failing application's error is shown here so
 * the operator sees it without leaving the page.
 */
import { useState } from 'react';
import { Loader2, Wrench } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import ErrorPanel from '@/components/ErrorPanel';
import NodeName from '@/components/nodes/NodeName';
import {
  useAllDeployments,
  useRepairDatabaseAccess,
  useSetCustomDeploymentAllowRoot,
  type Deployment,
} from '@/hooks/use-deployments';
import { useAuth } from '@/hooks/use-auth';
import { describeDeploymentError } from '@/lib/describe-deployment-error';
import TenantPanelLink from './TenantPanelLink';
import RepairDatabaseAccessDialog from './RepairDatabaseAccessDialog';
import { tenantPanel } from './tenant-panel-paths';

/** The repair endpoint's roles (requireRole('super_admin', 'admin')). */
const REPAIR_ROLES: ReadonlySet<string> = new Set(['super_admin', 'admin']);
/** The platform checks its login only on running instances, so only those (or a failing one) can need a repair. */
const REPAIRABLE_STATUSES: ReadonlySet<string> = new Set(['running', 'failed']);

export default function ApplicationsList({ tenantId, deployments }: {
  readonly tenantId: string;
  readonly deployments: readonly Deployment[];
}) {
  const setAllowRoot = useSetCustomDeploymentAllowRoot(tenantId);
  const repair = useRepairDatabaseAccess();
  const role = useAuth((s) => s.user?.role);
  const canRepair = role !== undefined && REPAIR_ROLES.has(role);
  const [repairTarget, setRepairTarget] = useState<Deployment | null>(null);
  const [repairedId, setRepairedId] = useState<string | null>(null);
  // The tenant's deployment rows carry no catalog type; the admin list joins it.
  const { data: typed } = useAllDeployments({ tenantId, limit: 100 });
  const catalogTypeById = new Map((typed?.data ?? []).map((r) => [r.id, r.catalogEntryType]));
  const accessModeById = new Map((typed?.data ?? []).map((r) => [r.id, r.databaseAccessMode ?? null]));

  const openRepair = (d: Deployment) => {
    repair.reset();
    setRepairTarget(d);
  };
  const confirmRepair = () => {
    if (!repairTarget) return;
    const id = repairTarget.id;
    repair.mutate(id, {
      onSuccess: () => {
        setRepairTarget(null);
        setRepairedId(id);
      },
    });
  };

  const shown = deployments.filter((d) => d.status !== 'deleted');
  if (shown.length === 0) return null;
  return (
    <div className="overflow-x-auto" data-testid="applications-list">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
            <th scope="col" className="px-5 py-2.5 font-medium">Application</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Type</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Runs on</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Status</th>
            <th scope="col" className="px-5 py-2.5"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {shown.map((d) => {
            const envelope = d.lastError?.trim() ? describeDeploymentError(d.lastError) : null;
            const catalogType = catalogTypeById.get(d.id) ?? null;
            // Only where the platform lost its login: the API refuses the rest (409).
            const repairable = canRepair && catalogType === 'database' && REPAIRABLE_STATUSES.has(d.status)
              && accessModeById.get(d.id) === 'locked';
            return (
              <tr key={d.id} className="border-b border-gray-100 align-top last:border-0 dark:border-gray-700" data-testid={`application-${d.id}`}>
                <td className="px-5 py-3">
                  <div className="font-medium text-gray-900 dark:text-gray-100">{d.name}</div>
                  {envelope && (
                    <div className="mt-1.5 max-w-xl">
                      <ErrorPanel error={envelope} severity={d.status === 'failed' ? 'error' : 'warn'} compact />
                    </div>
                  )}
                  {repairedId === d.id && (
                    <p className="mt-1.5 text-xs text-green-700 dark:text-green-400" data-testid={`repair-db-access-started-${d.id}`}>
                      Repair started — the database restarts once, and the platform checks its login again shortly after.
                    </p>
                  )}
                </td>
                <td className="px-5 py-3 text-gray-600 dark:text-gray-400">
                  {catalogType ?? d.type}
                  {d.source === 'custom' && <span className="ml-1.5 rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">custom</span>}
                </td>
                <td className="px-5 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                  {d.currentNodeName ? <NodeName name={d.currentNodeName} /> : <span className="text-gray-400">—</span>}
                </td>
                <td className="px-5 py-3"><StatusBadge status={d.status as Parameters<typeof StatusBadge>[0]['status']} /></td>
                <td className="px-5 py-3">
                  <div className="flex items-center justify-end gap-3">
                    {d.source === 'custom' && (
                      <button
                        type="button"
                        onClick={() => {
                          const next = !d.customSpec?.allowRoot;
                          if (next && !window.confirm(`Grant allowRoot on "${d.name}"? The container will run as uid 0. Only do this for trusted images.`)) return;
                          setAllowRoot.mutate({ deploymentId: d.id, allowRoot: next });
                        }}
                        disabled={setAllowRoot.isPending}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                          d.customSpec?.allowRoot
                            ? 'border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-700 dark:bg-orange-900/20 dark:text-orange-400 dark:hover:bg-orange-900/40'
                            : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'
                        }`}
                        title={d.customSpec?.allowRoot ? 'allowRoot is ON — click to revoke root access' : 'allowRoot is OFF — click to grant root access (super_admin only)'}
                        data-testid={`allow-root-${d.id}`}
                      >
                        {setAllowRoot.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                        {d.customSpec?.allowRoot ? 'Root ON' : 'Root OFF'}
                      </button>
                    )}
                    {repairable && (
                      <button
                        type="button"
                        onClick={() => openRepair(d)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-400 dark:hover:bg-amber-900/40"
                        title="Restore the platform's administrator login to this database (restarts it once)"
                        data-testid={`repair-db-access-${d.id}`}
                      >
                        <Wrench size={12} aria-hidden="true" />
                        Repair database access
                      </button>
                    )}
                    <TenantPanelLink tenantId={tenantId} to={tenantPanel.applications()} label="Applications → Installed">Manage</TenantPanelLink>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {repairTarget && (
        <RepairDatabaseAccessDialog
          deploymentName={repairTarget.name}
          pending={repair.isPending}
          error={repair.isError ? repair.error : null}
          onConfirm={confirmRepair}
          onCancel={() => setRepairTarget(null)}
        />
      )}
    </div>
  );
}
