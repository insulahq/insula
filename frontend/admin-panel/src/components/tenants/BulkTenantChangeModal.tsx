import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import { useNodeLabel } from '@/hooks/use-node-labels';
import { usePlans } from '@/hooks/use-plans';
import { useSystemInfo } from '@/hooks/use-system-info';
import { formatCurrency } from '@/lib/format-currency';
import { plural } from '@/lib/bulk-run';
import type { BulkTarget } from '@/hooks/use-bulk-tenants';

export type TenantChangeKind = 'placement' | 'plan';

interface BulkTenantChangeModalProps {
  readonly kind: TenantChangeKind;
  /** How many tenants the change will run against. */
  readonly count: number;
  readonly onCancel: () => void;
  /** `notifyTenant` is only meaningful for a plan change. */
  readonly onConfirm: (target: BulkTarget, notifyTenant: boolean) => void;
}

const COPY: Readonly<Record<TenantChangeKind, { title: string; label: string; body: string }>> = {
  placement: {
    title: 'Change placement of',
    label: 'Target node',
    body: 'Each tenant is re-pinned to this node and moved there, one at a time — the same move as the '
      + 'Placement card’s “Migrate pods now”. Running workloads restart (a tenant running on another node '
      + 'is stopped, moved and started: about a minute of downtime). Tenants already on the node are skipped.',
  },
  plan: {
    title: 'Change subscription plan of',
    label: 'New plan',
    body: 'Each tenant is moved to this hosting plan, one at a time — the same change as the Subscription '
      + 'card on the tenant page. Tenants already on the plan are skipped.',
  },
};

/**
 * Confirm step for the Tenants list's "Change placement" / "Change plan" bulk
 * actions: pick the target, then confirm. Styled like the list's other bulk
 * confirm dialog; the run itself is the shared BulkRunModal.
 */
export default function BulkTenantChangeModal({ kind, count, onCancel, onConfirm }: BulkTenantChangeModalProps) {
  const [targetId, setTargetId] = useState('');
  const [notifyTenant, setNotifyTenant] = useState(true);
  const options = useTargetOptions(kind);
  const copy = COPY[kind];
  const target = options.items.find((o) => o.id === targetId) ?? null;

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4 dark:bg-black/70" onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-change-title"
        onClick={(e) => e.stopPropagation()}
        data-testid={`bulk-change-${kind}-modal`}
      >
        <h3 id="bulk-change-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {copy.title} {plural(count, 'tenant')}?
        </h3>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{copy.body}</p>

        <label htmlFor="bulk-change-target" className="mt-4 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {copy.label}
        </label>
        {options.loading ? (
          <div className="mt-1 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : (
          <select
            id="bulk-change-target"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            data-testid="bulk-change-target"
          >
            <option value="">Choose…</option>
            {options.items.map((o) => (
              <option key={o.id} value={o.id}>{o.optionText}</option>
            ))}
          </select>
        )}
        {!options.loading && options.items.length === 0 && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            {kind === 'placement' ? 'No node can host tenant workloads.' : 'No hosting plans exist yet.'}
          </p>
        )}

        {kind === 'plan' && (
          <label className="mt-4 flex items-start gap-2.5 rounded-lg bg-gray-50 p-3 dark:bg-gray-700/40">
            <input
              type="checkbox"
              checked={notifyTenant}
              onChange={(e) => setNotifyTenant(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 dark:border-gray-600 dark:bg-gray-800"
              data-testid="bulk-change-notify"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Email each tenant about this change
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                Untick when it does not concern them — correcting a batch that was set wrongly.
              </span>
            </span>
          </label>
        )}

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => target && onConfirm({ id: target.id, label: target.label }, notifyTenant)}
            disabled={!target || count === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-600 disabled:opacity-50 dark:bg-brand-600 dark:hover:bg-brand-500"
            data-testid="bulk-confirm"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

interface TargetOption {
  readonly id: string;
  readonly label: string;
  readonly optionText: string;
}

function useTargetOptions(kind: TenantChangeKind): { readonly items: readonly TargetOption[]; readonly loading: boolean } {
  const nodes = useClusterNodes();
  const plans = usePlans();
  const { data: sysInfo } = useSystemInfo();
  const nodeLabel = useNodeLabel();

  if (kind === 'placement') {
    const items = (nodes.data?.data ?? [])
      .filter((n) => n.canHostTenantWorkloads)
      .map((n) => {
        const label = nodeLabel(n.name);
        return { id: n.name, label, optionText: label === n.name ? label : `${label} (${n.name})` };
      });
    return { items, loading: nodes.isLoading };
  }

  const currency = sysInfo?.currency ?? 'USD';
  const items = (plans.data?.data ?? []).map((p) => ({
    id: p.id,
    label: p.name,
    optionText: `${p.name} — ${formatCurrency(p.monthlyPriceUsd, currency)}/mo`,
  }));
  return { items, loading: plans.isLoading };
}
