import { useState, type FormEvent } from 'react';
import { X, Save, Loader2, AlertCircle, CheckCircle, ShieldAlert } from 'lucide-react';
import { useDrainImpact, useUpdateClusterNode } from '@/hooks/use-cluster-nodes';
import MailRoleNotice from '@/components/nodes/MailRoleNotice';
import { nodeTenantHosting, type ClusterNodeResponse, type NodeIngressMode, type NodeTenantHosting } from '@insula/api-contracts';

const INPUT_CLASS =
  'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

const INGRESS_MODE_OPTIONS: ReadonlyArray<{ readonly value: NodeIngressMode; readonly label: string; readonly hint: string }> = [
  {
    value: 'all',
    label: 'ALL INGRESS',
    hint: 'nginx runs here, advertises this node\'s public IP, and can forward to any pod cluster-wide. Default for system servers.',
  },
  {
    value: 'local',
    label: 'LOCAL INGRESS',
    hint: 'nginx runs here but only forwards to pods scheduled on this same node. Cross-node traffic returns 503.',
  },
  {
    value: 'none',
    label: 'NO INGRESS',
    hint: 'No nginx pod here. Workloads still run, but public traffic is served via system servers.',
  },
];

const TENANT_HOSTING_OPTIONS: ReadonlyArray<{ readonly value: NodeTenantHosting; readonly label: string; readonly hint: string }> = [
  {
    value: 'all',
    label: 'ALL TENANTS',
    hint: 'Any tenant may run here, and Auto placement (a new tenant, a drain\'s Auto) may pick this node.',
  },
  {
    value: 'pinned',
    label: 'PINNED TENANTS ONLY',
    hint: 'Only tenants you place here yourself: on create, with Placement → Move, or as a drain target. '
      + 'Auto never picks this node, and Kubernetes runs other tenants\' pods elsewhere whenever another node fits. '
      + 'Local storage tier only — an HA-tier tenant is not held to one node. For a remote server, or one kept for particular customers.',
  },
  {
    value: 'none',
    label: 'NO TENANTS',
    hint: 'No tenant runs here. On a server, a NoSchedule taint keeps tenant pods off; system services tolerate it '
      + 'and keep running and starting here. Servers default to no tenants; workers to all tenants.',
  },
];

interface NodeEditModalProps {
  readonly node: ClusterNodeResponse;
  readonly onClose: () => void;
}

/**
 * Modal-based edit dialog for a single cluster node.
 *
 * Replaces the inline NodeEditForm — the inline form crowded the row
 * and made it impossible to compare values across nodes while editing.
 * The modal also gates the destructive action (server→worker demotion)
 * behind an explicit `force` checkbox shown only when applicable.
 *
 * Fields:
 *  - displayName (alias) — operator-friendly label, falls back to k8s name.
 *  - role — preserved from the legacy form.
 *  - tenant hosting — three-state (all / pinned / none); replaced the
 *    "Can host tenant workloads" switch.
 *  - ingressMode — three-state (all / local / none) — sets the
 *    insula.host/ingress-mode label which the
 *    ingress-nginx DaemonSet's nodeAffinity respects.
 *  - notes — operator free text, surfaced only here.
 */
export default function NodeEditModal({ node, onClose }: NodeEditModalProps) {
  const update = useUpdateClusterNode(node.name);
  const [displayName, setDisplayName] = useState(node.displayName ?? '');
  const [role, setRole] = useState<'server' | 'worker'>(node.role);
  const initialHosting = nodeTenantHosting(node);
  const [tenantHosting, setTenantHosting] = useState<NodeTenantHosting>(initialHosting);
  // Sent only when changed: a drained pinned-only node reads "No tenants", and
  // re-sending that with a note would drop the pinned setting it returns to.
  const hostingChanged = tenantHosting !== initialHosting;
  const [cordoned, setCordoned] = useState(node.cordoned);
  const [ingressMode, setIngressMode] = useState<NodeIngressMode>(node.ingressMode);
  const [notes, setNotes] = useState(node.notes ?? '');
  const [force, setForce] = useState(false);

  const isDemotion = node.role === 'server' && role === 'worker';
  // Cordoning keeps everything running but stops this node taking any NEW
  // pod — including mail failing over to it, or a database instance being
  // rebuilt here. Read what that touches only once the operator switches it on.
  const cordoning = cordoned && !node.cordoned;
  const cordonImpact = useDrainImpact(node.name, cordoning).data?.data;
  const dbInstancesHere = (cordonImpact?.longhornReplicas ?? [])
    .filter((r) => r.isLastReplica && r.postgresInstance)
    .map((r) => `${r.namespace}/${r.postgresInstance?.instance}`);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        // Empty string clears the alias on the server.
        displayName: displayName.trim(),
        role,
        tenantHosting: hostingChanged ? tenantHosting : undefined,
        // An API that predates tenant hosting reads only the boolean.
        canHostTenantWorkloads: hostingChanged ? tenantHosting !== 'none' : undefined,
        cordoned: cordoned !== node.cordoned ? cordoned : undefined,
        ingressMode,
        notes: notes.trim() === '' ? null : notes,
        force: isDemotion && force ? true : undefined,
      });
      onClose();
    } catch {
      // error rendered below from update.error
    }
  };

  const err = update.error as { message?: string } | null;
  const isDemotionBlocked = Boolean(err?.message?.includes('NODE_DEMOTION_BLOCKED'));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="node-edit-modal-title"
      data-testid={`edit-node-${node.name}-modal`}
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-xl bg-white shadow-xl dark:bg-gray-800 max-h-[calc(100vh-4rem)] overflow-y-auto"
        data-testid={`edit-node-${node.name}-form`}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <h2 id="node-edit-modal-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Edit node — <span className="font-mono">{node.name}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="node-display-name">
              Display name (alias)
            </label>
            <input
              id="node-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={63}
              className={INPUT_CLASS}
              placeholder={node.name}
              data-testid="node-display-name-input"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Operator-friendly label shown in the UI. Empty falls back to <span className="font-mono">{node.name}</span>.
              The k8s identity stays the same.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="node-role">Role</label>
            <select
              id="node-role"
              value={role}
              onChange={(e) => setRole(e.target.value as 'server' | 'worker')}
              className={INPUT_CLASS}
            >
              <option value="server">server (runs system workloads)</option>
              <option value="worker">worker (tenants only)</option>
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Demoting a server with system pods still on it requires Force.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="node-tenant-hosting">
              Tenant hosting
            </label>
            <select
              id="node-tenant-hosting"
              value={tenantHosting}
              onChange={(e) => setTenantHosting(e.target.value as NodeTenantHosting)}
              className={INPUT_CLASS}
              data-testid="node-tenant-hosting-select"
            >
              {TENANT_HOSTING_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400" data-testid="node-tenant-hosting-hint">
              {TENANT_HOSTING_OPTIONS.find((o) => o.value === tenantHosting)?.hint}
            </p>
          </div>

          <div className="flex items-start justify-between gap-4 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <div className="flex-1">
              <label
                htmlFor="node-cordon-toggle"
                className="block text-sm font-medium text-gray-900 dark:text-gray-100"
              >
                Cordon (spec.unschedulable)
              </label>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                When ON, the scheduler refuses to place ANY new pod on this node —
                system ones included (a database rebuild, a mail failover);
                existing pods stay running. To keep only tenants off, set
                <strong> Tenant hosting</strong> to No tenants or use
                <strong> Drain Tenants</strong> on the card, which also moves the
                tenants already here.
              </p>
            </div>
            <button
              id="node-cordon-toggle"
              data-testid="node-cordon-toggle"
              type="button"
              role="switch"
              aria-checked={cordoned}
              onClick={() => setCordoned(!cordoned)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 ${
                cordoned ? 'bg-brand-500' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span
                aria-hidden="true"
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                  cordoned ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
          {cordoning && cordonImpact && (
            <div className="space-y-2" data-testid="cordon-impact">
              <MailRoleNotice mailRole={cordonImpact.mailRole} nodeName={node.name} />
              {dbInstancesHere.length > 0 && (
                <div
                  className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300"
                  data-testid="cordon-impact-db"
                >
                  Database instance {dbInstancesHere.join(', ')} keeps running here. If it has to be rebuilt
                  while this node is cordoned, it cannot come back to this node until it is uncordoned.
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="node-ingress-mode">
              Ingress mode
            </label>
            <select
              id="node-ingress-mode"
              value={ingressMode}
              onChange={(e) => setIngressMode(e.target.value as NodeIngressMode)}
              className={INPUT_CLASS}
              data-testid="node-ingress-mode-select"
            >
              {INGRESS_MODE_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {INGRESS_MODE_OPTIONS.find((o) => o.value === ingressMode)?.hint}
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300" htmlFor="node-notes">
              Operator notes
            </label>
            <textarea
              id="node-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={2000}
              className={INPUT_CLASS}
              placeholder="Free text — surfaced only in this admin UI."
            />
          </div>

          {isDemotion && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" />
              <div>
                Demoting a server to worker evicts any system pods still running on it. The API will refuse unless you drain first or set Force.
                <label className="mt-1.5 flex items-center gap-2">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                  <span>Force — bypass the safety check</span>
                </label>
              </div>
            </div>
          )}

          {err && !isDemotionBlocked && (
            <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={12} /> {err.message}
            </p>
          )}
          {isDemotionBlocked && (
            <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
              <AlertCircle size={12} /> Demotion blocked — tick Force to override.
            </p>
          )}

          {update.isSuccess && (
            <p className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle size={12} /> Saved.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={update.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            data-testid={`save-node-${node.name}-button`}
          >
            {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
