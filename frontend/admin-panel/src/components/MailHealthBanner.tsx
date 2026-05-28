import { useState } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  RefreshCw,
  ChevronRight,
} from 'lucide-react';
import MailHealthDetailsModal from './MailHealthDetailsModal';
import { useMailHealth, useRefreshMailHealth } from '@/hooks/use-mail-health';
import type {
  MailHealthResponse,
} from '@k8s-hosting/api-contracts';

/**
 * Live mail-server health banner.
 *
 * Replaces the cosmetic MailServerStatusTile that just echoed
 * system_settings without verifying state. This one actually calls
 * /admin/mail/health (real probes: pod readiness + JMAP HTTP probe;
 * RocksDB/cert/TCP shipping as `not_implemented` until Phase 3b).
 *
 * Visual:
 *   - One-line summary on top: green/red dot + "Mail server: OK" /
 *     "Mail server: DEGRADED — <reason>" + Refresh + drill-down chevron.
 *   - Expanded: per-component table (pod | jmap | rocksdb | cert | tcp)
 *     with status, key facts, and any error message.
 *
 * 2026-05-14 streamline: this banner is the top section of the
 * EmailManagement page. Future phases collapse the other ad-hoc tiles
 * (placement, port-exposure) into drill-downs reachable from this
 * banner.
 */
export default function MailHealthBanner() {
  const { data, isLoading, isError, error } = useMailHealth();
  const refresh = useRefreshMailHealth();
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 size={14} className="animate-spin" /> Probing mail-server health…
      </div>
    );
  }

  if (isError || !data?.data) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 flex items-start gap-2 text-sm text-red-700 dark:text-red-300">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="font-medium">Health probe failed</div>
          <div className="text-xs opacity-80">
            {error instanceof Error ? error.message : 'Could not reach /admin/mail/health.'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="rounded-md border border-red-300 dark:border-red-700 px-2 py-0.5 text-xs disabled:opacity-50"
        >
          <RefreshCw size={11} className={refresh.isPending ? 'animate-spin' : undefined} /> Retry
        </button>
      </div>
    );
  }

  const r = data.data;
  // 2026-05-28 UX: the card is now compact + click-anywhere. The whole
  // card opens the details modal. The Re-check button is a sibling
  // outside the click-zone so it doesn't double-trigger. No more
  // expand/collapse disclosure — operators wanted one path to detail.
  return (
    <>
      <div
        className={`rounded-xl border shadow-sm ${
          r.healthy
            ? 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
            : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20'
        }`}
      >
        <div className="w-full flex items-center gap-3 px-4 py-3">
          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer"
            data-testid="mail-health-banner"
            title="Open full probe details (deliverability, DNSBL, banner, cert SAN)"
          >
            {r.healthy
              ? <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
              : <AlertTriangle size={18} className="text-red-500 shrink-0" />}
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {r.healthy ? 'Mail server: OK' : 'Mail server: DEGRADED'}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {summaryLine(r)}
              </div>
            </div>
            <ChevronRight size={14} className="text-gray-400 shrink-0" />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); refresh.mutate(); }}
            disabled={refresh.isPending}
            className="rounded-md border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 shrink-0"
            data-testid="mail-health-refresh"
            title="Bypass 30s cache and probe again"
          >
            <RefreshCw size={11} className={refresh.isPending ? 'animate-spin inline mr-1' : 'inline mr-1'} />
            Re-check
          </button>
        </div>
      </div>
      {detailsOpen && <MailHealthDetailsModal onClose={() => setDetailsOpen(false)} />}
    </>
  );
}


function summaryLine(r: MailHealthResponse): string {
  const node = r.components.pod.node;
  const where = node ? `on ${node}` : '(node unknown — pod not Running)';
  if (r.healthy) {
    return `Pod ready ${where} • JMAP ${r.components.jmap.durationMs ?? '?'}ms • all checks passing`;
  }
  // Deliverability was missing from this chain pre-fix, so a healthy-pod
  // + healthy-jmap + unhealthy-deliverability response (the common
  // "DNSBL hit" or "PTR mismatch" case) fell through to the literal
  // "unknown" and the operator's banner just said "unknown" with no
  // detail. Now we surface deliverability's specific error.
  const failureReason =
    !r.components.pod.healthy ? r.components.pod.error :
    !r.components.jmap.healthy ? r.components.jmap.error :
    !r.components.rocksdb.healthy ? r.components.rocksdb.error :
    !r.components.cert.healthy ? r.components.cert.error :
    !r.components.tcp.healthy ? r.components.tcp.error :
    (r.components.deliverability && !r.components.deliverability.healthy)
      ? r.components.deliverability.error
      : null;
  return failureReason
    ? `Pod ready ${where} — ${failureReason}`
    : `Pod ready ${where} — one or more checks failing (click for details)`;
}

/**
 * Short relative-time label tuned for cache-window labelling on the
 * mail-health surface (second-level resolution for "X seconds ago"
 * because operators care whether the probe is 5s or 25s into a 30s
 * cache window). Exported so MailHealthDetailsModal can reuse without
 * duplicating the formula.
 */
export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}

