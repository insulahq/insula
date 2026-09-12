import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ServerCrash, Mail, AlertTriangle } from 'lucide-react';
import { useOutageImpact } from '@/hooks/use-outage-impact';
import AffectedTenantsModal from './AffectedTenantsModal';
import TimeCell from '@/components/ui/TimeCell';
import DegradedServiceHelp from './DegradedServiceHelp';

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
  //
  // It must also be READABLE. The 2026-09-12 quorum-loss drill put this in
  // front of the operator:
  //
  //   Cluster health unknown. longhorn replicas: fetch failed; nodes:
  //   HTTP-Code: 503 Message: Unknown API Status Code! Body: "{\"kind\":
  //   \"Status\",\"metadata\":{}, ... Headers: {"content-length":"124", ...
  //
  // — honest, and close to unreadable. The operator's first question during an
  // incident is "what can I no longer trust?", not "what did the Kubernetes
  // client library return?". So lead with the consequence and keep the raw
  // text available but out of the way.
  if (impact.readError) {
    return (
      <div
        data-testid="node-outage-read-error"
        className="mx-4 mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 lg:mx-6 lg:mt-6 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
      >
        <p className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <span>
            <strong>Cluster health cannot be determined.</strong>{' '}
            The platform could not read the cluster, so tenant health and service
            availability on this page are <strong>unknown rather than healthy</strong>.
            Tenants already running are unaffected by this — their sites keep serving without
            the control plane.
            {impact.nodesAsOf && impact.nodesDown.length > 0 && (
              <>
                {' '}Last recorded state, from{' '}
                <TimeCell iso={impact.nodesAsOf} mode="age" />:{' '}
                <strong>{impact.nodesDown.map((n) => n.name).join(', ')}</strong>
                {impact.nodesDown.length > 1 ? ' were' : ' was'} offline. That reading is
                from the platform&rsquo;s own records, not the cluster, so it may have moved on.
              </>
            )}
            {impact.nodesAsOf && impact.nodesDown.length === 0 && (
              <>
                {' '}The last recorded state, from{' '}
                <TimeCell iso={impact.nodesAsOf} mode="age" />, had every node online.
              </>
            )}
          </span>
        </p>
        <details className="mt-2">
          <summary
            data-testid="node-outage-read-error-details"
            className="cursor-pointer text-xs font-medium underline underline-offset-2"
          >
            Technical detail
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-amber-100 p-2 text-xs dark:bg-amber-900/50">
            {impact.readError}
          </pre>
        </details>
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

          {/*
            Say what IS broken before saying what isn't. The 2026-09-11 worker
            drill produced "No tenant impact detected" — true, and badly
            incomplete: backups were unreachable for the whole outage because
            their Service had no ready endpoint. A node on which no tenant runs
            can still take a platform service with it.
          */}
          {/*
            The remediation used to live in an HTML `title` tooltip — hover-only,
            invisible on touch and to keyboard users, unannounced by screen
            readers. This is the one failure in the outage set with NO automatic
            recovery, so "it will not fix itself, here is what to do" has to be
            reachable, not hovered.
          */}
          <DegradedServiceHelp services={impact.degradedServices} nodesDown={impact.nodesDown} />

          {impact.affectedTenantCount === 0 && impact.degradedServices.length === 0 && (
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
