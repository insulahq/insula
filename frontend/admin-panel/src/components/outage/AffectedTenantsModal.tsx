import { Link } from 'react-router-dom';
import { X, AlertTriangle, XCircle, Info, HelpCircle } from 'lucide-react';
import type { ClusterOutageImpact, TenantHealthEntry } from '@insula/api-contracts';
import { RECOVERY_ACTIONS } from './recovery-actions';

/**
 * Which tenants an outage is affecting, and what to do about each.
 *
 * Opened from the node-outage banner's tenants pill and from a tenant row's
 * DEGRADED badge. Hosting and mail are listed as separate findings on
 * purpose: a tenant can be fine on one axis and down on the other, and
 * collapsing them hides which half the operator can fix.
 */
interface Props {
  readonly impact: ClusterOutageImpact;
  readonly onClose: () => void;
  /** When set, show only this tenant — the per-row entry point. */
  readonly onlyTenantId?: string;
}

function StateBadge({ state }: { readonly state: TenantHealthEntry['state'] }) {
  const map = {
    down: {
      cls: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
      Icon: XCircle,
      label: 'Down',
    },
    degraded: {
      cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
      Icon: AlertTriangle,
      label: 'Degraded',
    },
    unknown: {
      cls: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
      Icon: HelpCircle,
      label: 'Unknown',
    },
    healthy: {
      cls: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
      Icon: Info,
      label: 'Healthy',
    },
  } as const;
  const { cls, Icon, label } = map[state];
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      <Icon size={12} aria-hidden="true" /> {label}
    </span>
  );
}

function TenantCard({ entry }: { readonly entry: TenantHealthEntry }) {
  return (
    <div
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
      data-testid={`affected-tenant-${entry.tenantId}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Link
          to={`/tenants/${entry.tenantId}`}
          className="font-medium text-gray-900 underline-offset-2 hover:underline dark:text-gray-100"
        >
          {entry.tenantName}
        </Link>
        <StateBadge state={entry.state} />
        {entry.hostingAffected && entry.mailAffected && (
          <span className="rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-300">
            hosting + mail
          </span>
        )}
        <span className="ml-auto font-mono text-xs text-gray-500 dark:text-gray-400">
          {entry.storageTier === 'local' ? 'local tier' : 'HA tier'}
          {entry.pinnedNode ? ` · pinned to ${entry.pinnedNode}` : ''}
        </span>
      </div>

      <ul className="space-y-3">
        {entry.findings.map((f) => {
          const action = RECOVERY_ACTIONS[f.kind];
          const href = action.tenantPath ? `/tenants/${entry.tenantId}` : action.href;
          return (
            <li key={f.kind} className="border-l-2 border-gray-200 pl-3 dark:border-gray-600">
              <p className="text-sm text-gray-800 dark:text-gray-200">{f.detail}</p>
              {f.resources.length > 0 && (
                <p className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400">
                  {f.resources.slice(0, 6).join(', ')}
                  {f.resources.length > 6 ? ` +${f.resources.length - 6} more` : ''}
                </p>
              )}
              <p className="mt-1.5 text-xs text-gray-600 dark:text-gray-400">
                <span className="font-semibold text-gray-700 dark:text-gray-300">
                  {action.selfHealing ? 'Resolves itself: ' : 'Next step: '}
                </span>
                {action.rationale}
              </p>
              {!action.selfHealing && href && (
                <Link
                  to={href}
                  className="mt-1.5 inline-block text-xs font-medium text-blue-700 underline dark:text-blue-400"
                >
                  {action.label} →
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function AffectedTenantsModal({ impact, onClose, onlyTenantId }: Props) {
  const entries = onlyTenantId
    ? impact.affectedTenants.filter((t) => t.tenantId === onlyTenantId)
    : impact.affectedTenants;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Tenants affected by the node outage"
      data-testid="affected-tenants-modal"
    >
      <div className="max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-xl bg-gray-50 shadow-xl dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {onlyTenantId ? 'Tenant health' : 'Affected tenants'}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {impact.nodesDown.length > 0
                ? `${impact.nodesDown.map((n) => n.name).join(', ')} offline`
                : 'No node is currently offline'}
              {' · '}
              {impact.downTenantCount} down, {impact.degradedTenantCount} degraded
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="affected-tenants-close"
            className="rounded-md p-1 text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-3 overflow-y-auto p-5">
          {impact.readError && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
              <strong>Tenant impact could not be determined.</strong> {impact.readError}
              {' '}Treat this as unknown, not healthy — re-check once the cluster responds.
            </div>
          )}
          {!impact.readError && entries.length === 0 && (
            <p className="text-sm text-gray-600 dark:text-gray-300">
              No tenant is currently affected.
            </p>
          )}
          {entries.map((e) => <TenantCard key={e.tenantId} entry={e} />)}
        </div>
      </div>
    </div>
  );
}
