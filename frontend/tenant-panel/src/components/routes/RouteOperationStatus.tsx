import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';

/** A route change the server is still working on. */
export interface RouteOperation {
  readonly kind: 'add' | 'update' | 'remove';
  readonly hostname: string;
}

/** How the last removal ended — said once, until the next change starts. */
export interface RouteRemovalResult {
  readonly hostname: string;
  /** Set when the route is gone but some of its DNS records are still published. */
  readonly dnsWarning: string | null;
}

const DOING: Record<RouteOperation['kind'], (hostname: string) => string> = {
  add: (h) => `Adding ${h} — creating its ingress rule and publishing its DNS records…`,
  update: (h) => `Updating ${h} — applying the change to its ingress rule…`,
  remove: (h) => `Removing ${h} — withdrawing its DNS records and updating the ingress…`,
};

/**
 * What a route change is doing while the request runs, and how a removal
 * ended. A removal waits on the DNS server, and one that does not answer kept
 * the request open for most of a minute with nothing on the page moving — so
 * the operator clicked again.
 */
export default function RouteOperationStatus({ pending, removal }: {
  readonly pending: RouteOperation | null;
  readonly removal: RouteRemovalResult | null;
}) {
  if (pending) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300"
        data-testid="route-operation-pending"
      >
        <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin" aria-hidden="true" />
        <div>
          <p className="font-medium">{DOING[pending.kind](pending.hostname)}</p>
          <p className="mt-0.5 text-xs">
            This usually takes a few seconds. When the DNS server is slow to answer it can take up to a minute.
          </p>
        </div>
      </div>
    );
  }
  if (removal?.dnsWarning) {
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
        data-testid="route-operation-warning"
      >
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p>{removal.dnsWarning}</p>
      </div>
    );
  }
  if (removal) {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400"
        data-testid="route-operation-done"
      >
        <CheckCircle2 size={16} aria-hidden="true" /> Removed {removal.hostname}.
      </p>
    );
  }
  return null;
}
