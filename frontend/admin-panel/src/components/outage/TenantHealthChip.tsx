import { useState } from 'react';
import { AlertTriangle, XCircle, HelpCircle } from 'lucide-react';
import { useOutageImpact } from '@/hooks/use-outage-impact';
import AffectedTenantsModal from './AffectedTenantsModal';

/**
 * Per-tenant health, in the tenant list.
 *
 * `tenants.status` is a LIFECYCLE field (pending / active / suspended) — it
 * says nothing about whether the tenant is actually serving. Before the
 * 2026-09-11 drill there was no availability signal in the list at all, so a
 * tenant whose only volume replica had been stranded on a dead node still
 * read "Active".
 *
 * Renders nothing when the tenant is healthy, so the list stays quiet in
 * normal operation. Clicking opens the same modal the outage banner uses,
 * scoped to this tenant.
 *
 * Shares `useOutageImpact`'s query key with the global banner, so react-query
 * serves it from cache — a 100-row list costs zero extra requests.
 */
export default function TenantHealthChip({ tenantId }: { readonly tenantId: string }) {
  const [open, setOpen] = useState(false);
  const { data } = useOutageImpact();
  const impact = data?.data;
  const entry = impact?.affectedTenants.find((t) => t.tenantId === tenantId);

  if (!impact || !entry) return null;

  const style = {
    down: {
      cls: 'bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300 dark:hover:bg-red-900/60',
      Icon: XCircle,
      label: 'Down',
    },
    degraded: {
      cls: 'bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-900/60',
      Icon: AlertTriangle,
      label: 'Degraded',
    },
    unknown: {
      cls: 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700',
      Icon: HelpCircle,
      label: 'Unknown',
    },
    healthy: { cls: '', Icon: HelpCircle, label: '' },
  }[entry.state];

  if (!style.label) return null;
  const { cls, Icon, label } = style;

  return (
    <>
      <button
        type="button"
        data-testid={`tenant-health-${tenantId}`}
        title="Show what is degraded and how to recover"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ${cls}`}
      >
        <Icon size={12} aria-hidden="true" /> {label}
      </button>
      {open && (
        <div onClick={(e) => e.stopPropagation()} role="presentation">
          <AffectedTenantsModal
            impact={impact}
            onlyTenantId={tenantId}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}
