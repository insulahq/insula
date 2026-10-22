import { Database, Loader2 } from 'lucide-react';
import type { StandbyReport } from '@insula/api-contracts';
import { useMailStandbyReports } from '@/hooks/use-mail-standby-reports';
import NodeName from '@/components/nodes/NodeName';

/**
 * Standby data freshness, and a standby that is still being prepared.
 *
 * Reads the per-node reports posted by mail-stack-standby-replicate (one row
 * per node that is a standby NOW, with the last copy's size, file count, sync
 * duration and age). Traffic-light by age vs the DaemonSet's 5-min cadence:
 *   <10 min = green (fresh, FAST PATH would use it)
 *   <30 min = amber (stale but usable; investigate)
 *   else    = red (broken)
 *
 * A node that has just become a standby — the operator moved the standby to it
 * — copies the whole mail store before it reports anything. It is listed as
 * preparing, and MailStandbyPreparingNotice says so at the top of the card,
 * rather than the node being missing or the old standby lingering in red.
 *
 * Renders nothing when there is no standby (mail HA not configured).
 */

function elapsed(since: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  return min < 120 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * The standbys still making their first copy, as a notice. Nothing when none.
 * A first copy that stalled (its copier not running, or past six hours) is no
 * longer "in progress": it is red in the list below and fails the health check.
 */
export function MailStandbyPreparingNotice() {
  const { data } = useMailStandbyReports();
  const preparing = (data?.data.preparing ?? []).filter((p) => (p.state ?? 'preparing') === 'preparing');
  if (preparing.length === 0) return null;
  return (
    <div
      className="rounded-lg border border-sky-300 bg-sky-50 px-4 py-3 text-sm dark:border-sky-700 dark:bg-sky-900/25"
      data-testid="mail-standby-preparing-notice"
    >
      <div className="flex items-start gap-2">
        <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-sky-600 dark:text-sky-400" aria-hidden="true" />
        <div className="flex-1 text-sky-900 dark:text-sky-100">
          <div className="font-medium">
            {preparing.length === 1 ? 'Preparing the standby on ' : 'Preparing the standbys on '}
            {preparing.map((p, i) => (
              <span key={p.node}>{i > 0 && ', '}<NodeName name={p.node} /></span>
            ))}
          </div>
          <div className="mt-0.5 text-xs text-sky-800 dark:text-sky-200">
            A new standby copies the whole mail store before its first report; that can take from minutes
            to hours, depending on the store and the link. Mail keeps running meanwhile. Until the copy
            finishes, a failover to {preparing.length === 1 ? 'it' : 'them'} restores from the newest backup instead.
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MailStandbyFreshness() {
  const { data, isLoading, isError } = useMailStandbyReports();
  const reports = data?.data.reports ?? [];
  const preparing = data?.data.preparing ?? [];

  if (isLoading || isError) return null;
  if (reports.length === 0 && preparing.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-gray-200 dark:border-gray-700 pt-4">
      <div className="flex items-center gap-2">
        <Database size={13} className="text-gray-500 dark:text-gray-400" />
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Standby data freshness
        </div>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Pre-staged mail data on standby-labelled nodes. FAST PATH on failover
        uses this instead of pulling from the active node.
      </p>
      <div className="space-y-1.5">
        {preparing.map((p) => <PreparingRow key={p.node} node={p.node} since={p.since} state={p.state ?? 'preparing'} />)}
        {reports.map((r) => <StandbyRow key={r.node} report={r} />)}
      </div>
    </div>
  );
}

type FirstCopyState = 'preparing' | 'not_running' | 'overdue';

function PreparingRow({ node, since, state }: { readonly node: string; readonly since: string; readonly state: FirstCopyState }) {
  if (state !== 'preparing') {
    return (
      <div
        className="flex items-center gap-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs"
        data-testid={`mail-standby-preparing-${node}`}
        data-state={state}
      >
        <div className="w-2 h-2 rounded-full shrink-0 bg-red-500" />
        <code className="font-mono font-medium text-gray-900 dark:text-gray-100 flex-1 truncate">
          <NodeName name={node} />
        </code>
        <span className="font-medium text-red-700 dark:text-red-300">
          {state === 'not_running'
            ? `first copy not started — its copier is not running (standby for ${elapsed(since)})`
            : `first copy not finished after ${elapsed(since)}`}
        </span>
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-900/20 px-3 py-2 text-xs"
      data-testid={`mail-standby-preparing-${node}`}
      data-state={state}
    >
      <Loader2 size={10} className="shrink-0 animate-spin text-sky-600 dark:text-sky-400" aria-hidden="true" />
      <code className="font-mono font-medium text-gray-900 dark:text-gray-100 flex-1 truncate">
        <NodeName name={node} />
      </code>
      <span className="font-medium text-sky-700 dark:text-sky-300">
        first copy in progress — standby for {elapsed(since)}
      </span>
    </div>
  );
}

function StandbyRow({ report }: { readonly report: StandbyReport }) {
  const min = Math.floor(report.ageSeconds / 60);
  const sec = report.ageSeconds % 60;
  const ageStr = min === 0 ? `${sec}s` : `${min}m ${sec}s`;

  // 5-min DaemonSet cadence → green band covers the normal case
  // (~2x cadence to account for one missed iteration).
  const dotCls =
    report.ageSeconds < 600
      ? 'bg-green-500'
      : report.ageSeconds < 1800
      ? 'bg-amber-500'
      : 'bg-red-500';

  const sizeMiB = (report.sizeBytes / 1024 / 1024).toFixed(1);

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2 text-xs"
      data-testid={`mail-standby-row-${report.node}`}
    >
      <div className={`w-2 h-2 rounded-full shrink-0 ${dotCls}`} />
      <code className="font-mono font-medium text-gray-900 dark:text-gray-100 flex-1 truncate">
        <NodeName name={report.node} />
      </code>
      <span className="text-gray-500 dark:text-gray-400">{sizeMiB} MiB</span>
      <span className="text-gray-500 dark:text-gray-400">{report.fileCount} files</span>
      <span className="text-gray-500 dark:text-gray-400">{report.durationSeconds}s rsync</span>
      <span
        className={
          report.ageSeconds < 600
            ? 'text-green-700 dark:text-green-300 font-medium'
            : report.ageSeconds < 1800
            ? 'text-amber-700 dark:text-amber-300 font-medium'
            : 'text-red-700 dark:text-red-300 font-medium'
        }
      >
        {ageStr} ago
      </span>
    </div>
  );
}
