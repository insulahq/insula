import { TENANT_PLACEMENT_FILTER, type TenantListFilters } from '@insula/api-contracts';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import { useNodeLabel } from '@/hooks/use-node-labels';
import { usePlans } from '@/hooks/use-plans';

/** What the Tenants list can be filtered by — one field at a time. */
export type TenantFilterField = 'status' | 'placement' | 'tier' | 'plan';

export interface TenantFilter {
  readonly field: TenantFilterField | '';
  /** '' until a value is chosen: the field alone filters nothing. */
  readonly value: string;
}

export const NO_TENANT_FILTER: TenantFilter = { field: '', value: '' };

const FIELD_LABELS: Readonly<Record<TenantFilterField, string>> = {
  status: 'Status',
  placement: 'Placement',
  tier: 'Tier',
  plan: 'Plan',
};

interface FilterOption {
  readonly value: string;
  readonly label: string;
}

const STATUS_OPTIONS: readonly FilterOption[] = [
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'pending', label: 'Pending' },
  { value: 'archived', label: 'Archived' },
];

const TIER_OPTIONS: readonly FilterOption[] = [
  { value: 'local', label: 'Local' },
  { value: 'ha', label: 'HA' },
];

/** The API filters a chosen field and value stand for; empty until both are set. Pure. */
export function filtersOf(filter: TenantFilter): TenantListFilters {
  return filter.field && filter.value ? { [filter.field]: filter.value } : {};
}

/** The values a field can take on this platform: its nodes and plans, not every imaginable one. */
function useFilterOptions(field: TenantFilterField | ''): { readonly options: readonly FilterOption[]; readonly loading: boolean } {
  const nodes = useClusterNodes();
  const plans = usePlans();
  const nodeLabel = useNodeLabel();
  switch (field) {
    case 'status':
      return { options: STATUS_OPTIONS, loading: false };
    case 'tier':
      return { options: TIER_OPTIONS, loading: false };
    case 'placement': {
      const nodeOptions = (nodes.data?.data ?? [])
        .map((n) => {
          const label = nodeLabel(n.name);
          return { value: n.name, label: label === n.name ? label : `${label} (${n.name})` };
        })
        .sort((a, b) => a.label.localeCompare(b.label));
      return {
        options: [
          { value: TENANT_PLACEMENT_FILTER.auto, label: 'Auto (no pin)' },
          { value: TENANT_PLACEMENT_FILTER.misplaced, label: 'Not where it belongs' },
          ...nodeOptions,
        ],
        loading: nodes.isLoading,
      };
    }
    case 'plan':
      return {
        options: (plans.data?.data ?? [])
          .map((p) => ({ value: p.id, label: p.name }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        loading: plans.isLoading,
      };
    default:
      return { options: [], loading: false };
  }
}

const SELECT_CLASS = 'rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-8 text-sm text-gray-900 '
  + 'focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50 '
  + 'dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100';

/**
 * The Tenants list's "Filter by": a field, then one of its values. Changing the
 * field clears the value, so a status never stays applied as a plan.
 */
export default function TenantListFilter({ filter, onChange }: {
  readonly filter: TenantFilter;
  readonly onChange: (next: TenantFilter) => void;
}) {
  const { options, loading } = useFilterOptions(filter.field);
  return (
    <div className="flex items-center gap-2" data-testid="tenant-filter">
      <label className="sr-only" htmlFor="tenant-filter-field">Filter by</label>
      <select
        id="tenant-filter-field"
        value={filter.field}
        onChange={(e) => onChange({ field: e.target.value as TenantFilterField | '', value: '' })}
        className={SELECT_CLASS}
        data-testid="tenant-filter-field"
      >
        <option value="">Filter by…</option>
        {(Object.keys(FIELD_LABELS) as TenantFilterField[]).map((f) => (
          <option key={f} value={f}>{FIELD_LABELS[f]}</option>
        ))}
      </select>
      <label className="sr-only" htmlFor="tenant-filter-value">{filter.field ? FIELD_LABELS[filter.field] : 'Value'}</label>
      <select
        id="tenant-filter-value"
        value={filter.value}
        onChange={(e) => onChange({ ...filter, value: e.target.value })}
        disabled={!filter.field || loading}
        className={SELECT_CLASS}
        data-testid="tenant-filter-value"
      >
        <option value="">{filter.field ? (loading ? 'Loading…' : `Any ${FIELD_LABELS[filter.field].toLowerCase()}`) : 'Choose a field first'}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
