import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ServerCrash, Mail } from 'lucide-react';
import { useOutageImpact } from '@/hooks/use-outage-impact';
import AffectedTenantsModal from './AffectedTenantsModal';

/**
 * "A node is down" — on every admin page.
 *
 * The 2026-09-11 drill found the outage was only visible on the Cluster Nodes
 * page; the dashboard an operator actually lands on rendered "Platform:
 * Healthy — 4 / 4 services healthy" throughout. This banner is mounted in the
 * layout so no page can hide an outage.
 *
 * Deliberately NOT dismissible: a node being offline is not an advisory.
 */
export default function NodeOutageBanner() {
  const [showTenants, setShowTenants] = useState(false);
  const { data } = useOutageImpact();
  const impact = data?.data;

  if (!impact) return null;

  // A failed cluster read must say so rather than render nothing, which
  // would be indistinguishable from a healthy cluster.
  if (impact.readError) {
    return (
      <div
        data-testid="node-outage-read-error"
        className="mx-4 mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 lg:mx-6 lg:mt-6 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
      >
        <strong>Cluster health unknown.</strong> {impact.readError}
      </div>
    );
  }

  if (impact.nodesDown.length === 0) return null;

  const names = impact.nodesDown.map((n) => n.name);
  const plural = names.length > 1;

  return (
    <>
      <div
        data-testid="node-outage-banner"
        className="mx-4 mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 lg:mx-6 lg:mt-6 dark:border-red-800 dark:bg-red-900/30"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2 text-sm text-red-900 dark:text-red-200">
            <ServerCrash size={16} className="shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />
            <span>
              <strong>{plural ? 'Nodes offline' : 'Node offline'}</strong>
              {' — '}
              <span className="font-mono font-medium">{names.join(', ')}</span>
            </span>
          </div>

          {impact.mailAffected && (
            <span
              data-testid="node-outage-mail-pill"
              className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-800 dark:bg-red-800/50 dark:text-red-200"
            >
              <Mail size={12} aria-hidden="true" /> Mail server affected
            </span>
          )}

          {impact.affectedTenantCount > 0 && (
            <button
              type="button"
              onClick={() => setShowTenants(true)}
              data-testid="node-outage-tenants-pill"
              className="inline-flex items-center gap-1 rounded-full bg-red-600 px-3 py-0.5 text-xs font-semibold text-white transition-colors hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 dark:bg-red-700 dark:hover:bg-red-600"
            >
              {impact.affectedTenantCount} tenant{impact.affectedTenantCount === 1 ? '' : 's'} affected
            </button>
          )}

          {impact.affectedTenantCount === 0 && (
            <span className="text-xs text-red-800 dark:text-red-300">
              No tenant impact detected
            </span>
          )}

          <Link
            to="/cluster/nodes"
            className="ml-auto text-sm font-medium text-red-900 underline dark:text-red-200"
          >
            View nodes
          </Link>
        </div>
      </div>

      {showTenants && (
        <AffectedTenantsModal impact={impact} onClose={() => setShowTenants(false)} />
      )}
    </>
  );
}
