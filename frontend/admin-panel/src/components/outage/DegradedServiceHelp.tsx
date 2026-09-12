import { useState } from 'react';
import { PlugZap, X } from 'lucide-react';
import type { ClusterOutageImpact } from '@insula/api-contracts';

interface Props {
  readonly services: ClusterOutageImpact['degradedServices'];
  readonly nodesDown: ClusterOutageImpact['nodesDown'];
}

/**
 * "Backups unavailable" — and what the operator is supposed to do about it.
 *
 * The pill used to carry its remediation in an HTML `title` tooltip: hover-only,
 * invisible on touch, invisible to keyboard users, unannounced by screen
 * readers, and easy to miss entirely. So the platform named the broken thing and
 * effectively did not say that it will never fix itself.
 *
 * That matters more here than for the other outage surfaces, because this is the
 * one failure in the set that has NO automatic recovery. A leader-elected
 * singleton whose node loses only its kubelet keeps renewing its lease from a
 * perfectly healthy process, while Kubernetes marks its endpoint not-ready
 * because the node is unmanageable. The standby cannot take over — the lease is
 * legitimately held — so the service stays unreachable until a human intervenes.
 * Measured on staging: 5m37s, ending only when the node came back.
 */
export default function DegradedServiceHelp({ services, nodesDown }: Props) {
  const [open, setOpen] = useState(false);
  if (services.length === 0) return null;

  const labels = services.map((s) => s.label).join(', ');
  const nodeNames = nodesDown.map((n) => n.name);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="node-outage-services-pill"
        className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-800 underline decoration-dotted underline-offset-2 transition-colors hover:bg-red-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 dark:bg-red-800/50 dark:text-red-200 dark:hover:bg-red-800/70"
      >
        <PlugZap size={12} aria-hidden="true" />
        {labels} unavailable — what to do
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`${labels} unavailable`}
          data-testid="degraded-service-help"
        >
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5 shadow-xl dark:bg-gray-900">
            <div className="flex items-start justify-between gap-4">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {labels} unavailable
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                data-testid="degraded-service-help-close"
                className="rounded-md p-1 text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700"
              >
                <X size={18} />
              </button>
            </div>

            <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
              This service has no reachable instance while{' '}
              {nodeNames.length > 0
                ? <strong>{nodeNames.join(', ')}</strong>
                : 'a node'}{' '}
              {nodeNames.length > 1 ? 'are' : 'is'} offline.
            </p>

            <p
              data-testid="degraded-service-no-self-heal"
              className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
            >
              <strong>This will not recover on its own.</strong> A second copy of the service
              is running, but it cannot take over: the copy on the offline node is still
              alive and still holds the lock that decides which one is in charge. Only one
              may run at a time, so the healthy copy waits. It will keep waiting until the
              offline node is dealt with.
            </p>

            <h3 className="mt-4 text-sm font-semibold text-gray-900 dark:text-gray-100">
              What to do, in order
            </h3>
            <ol
              data-testid="degraded-service-steps"
              className="mt-2 list-decimal space-y-2 pl-5 text-sm text-gray-700 dark:text-gray-300"
            >
              <li>
                <strong>Try to bring the node back first.</strong> Usually the machine is
                still running and only its cluster agent has stopped — a full disk and a
                crashed agent are the common causes. Restarting the agent restores this
                service immediately, because the copy running there was healthy all along.
              </li>
              <li>
                <strong>If the machine cannot be recovered, power it off.</strong> That stops
                the copy holding the lock, and the healthy copy takes over within seconds.
                The machine can be brought back normally afterwards.
              </li>
              <li>
                <strong>Only remove the node from the cluster if you are decommissioning
                it.</strong> That also releases the lock, but takes around a minute and a
                half — and it drops the machine from the cluster firewall, so it can no
                longer reach the cluster to rejoin. Bringing it back then needs it enrolled
                again as a new node.
              </li>
            </ol>

            <p
              data-testid="degraded-service-delete-warning"
              className="mt-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200"
            >
              <strong>Do not remove the node just to clear this.</strong> On a machine you
              intend to keep, removing it strands the machine outside the cluster and turns a
              few-minute problem into a re-enrolment. Prefer step 1, then step 2.
            </p>

            <p className="mt-3 text-xs text-gray-600 dark:text-gray-400">
              Tenants are not affected by this. Their sites keep serving throughout — what
              stops is this platform service.
            </p>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
