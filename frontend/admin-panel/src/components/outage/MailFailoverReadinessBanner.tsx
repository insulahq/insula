import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MailWarning, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';

interface Readiness {
  readonly systemTier: 'local' | 'ha';
  readonly autoFailoverEnabled: boolean;
  readonly candidateCount: number;
  readonly shouldWarn: boolean;
  readonly reasons: readonly string[];
}

/**
 * "The platform is in HA mode, but mail cannot fail over."
 *
 * Enabling mail failover stays a deliberate operator decision — it can
 * destroy and recreate the mail PVC, so the platform must never switch it on
 * by itself. What it CAN do is stop the gap being invisible.
 *
 * The 2026-09-11 drill found staging in exactly this state: HA mode, three
 * server nodes, auto-failover off and no secondary/tertiary configured. When
 * the mail node was killed nothing happened at all — `dr-watcher` returns
 * immediately when auto-failover is off, without even marking the state
 * degraded — and mail stayed down until an operator noticed and drove a
 * manual recovery.
 *
 * Dismissible, unlike the node-outage banner: this is a standing
 * configuration warning, not a live incident.
 */
export default function MailFailoverReadinessBanner() {
  const [dismissed, setDismissed] = useState(false);
  const { data } = useQuery({
    queryKey: ['mail', 'failover-readiness'],
    queryFn: () => apiFetch<{ data: Readiness }>('/api/v1/admin/mail/failover-readiness'),
    // Configuration, not live state — a slow poll is plenty.
    refetchInterval: 5 * 60_000,
    retry: false,
  });

  const r = data?.data;
  if (!r?.shouldWarn || dismissed) return null;

  return (
    <div
      data-testid="mail-failover-readiness-banner"
      className="mx-4 mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 lg:mx-6 lg:mt-6 dark:border-amber-700 dark:bg-amber-900/30"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-2 text-sm text-amber-900 dark:text-amber-200">
          <MailWarning size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <span>
            <strong>Mail cannot fail over.</strong>{' '}
            The platform is in HA mode but {r.reasons.join(' and ')}. If the mail
            server&rsquo;s node goes offline, mail stays down until someone recovers it by hand.
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            to="/email/operations"
            className="text-sm font-medium text-amber-900 underline dark:text-amber-200"
          >
            Configure
          </Link>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss mail failover warning"
            data-testid="mail-failover-readiness-dismiss"
            className="rounded-md p-1 text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-800"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
