import { Link } from 'react-router-dom';
import type { ReactElement } from 'react';
import { CheckCircle, Loader2, MinusCircle, XCircle, History } from 'lucide-react';
import type { UpgradeRun } from '@insula/api-contracts';
import { useUpgradeRuns } from '@/hooks/use-platform-upgrade';
import { formatVersion } from '@/lib/format-version';

/**
 * The last upgrade runs (ADR-064 §6), newest first — each links to its page,
 * which keeps the per-node outcome and the message it ended with.
 */
const STATUS: Record<UpgradeRun['status'], { text: string; cls: string; icon: ReactElement }> = {
  running: { text: 'Running', cls: 'text-blue-600 dark:text-blue-400', icon: <Loader2 size={13} className="animate-spin text-blue-500" /> },
  succeeded: { text: 'Succeeded', cls: 'text-green-700 dark:text-green-400', icon: <CheckCircle size={13} className="text-green-600 dark:text-green-400" /> },
  failed: { text: 'Failed', cls: 'text-red-600 dark:text-red-400', icon: <XCircle size={13} className="text-red-500" /> },
  cancelled: { text: 'Cancelled', cls: 'text-gray-600 dark:text-gray-300', icon: <MinusCircle size={13} className="text-gray-500 dark:text-gray-400" /> },
  'rolled-back': { text: 'Rolled back', cls: 'text-gray-600 dark:text-gray-300', icon: <MinusCircle size={13} className="text-gray-500 dark:text-gray-400" /> },
};

function duration(run: UpgradeRun): string | null {
  if (!run.finishedAt) return null;
  const s = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

export default function UpgradeHistoryCard({ className = '' }: { readonly className?: string }) {
  const q = useUpgradeRuns(10);
  const runs = q.data?.data ?? [];
  if (!q.isLoading && runs.length === 0) return null;
  return (
    <div className={className} data-testid="upgrade-history">
      <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
        <History size={15} className="text-gray-500 dark:text-gray-400" /> Upgrade history
      </h2>
      {q.isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-700">
          {runs.map((r) => {
            const st = STATUS[r.status];
            const d = duration(r);
            return (
              <li key={r.id} className="py-2" data-testid={`upgrade-history-${r.id}`}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <Link to={`/platform/updates/runs/${r.id}`} className="font-mono text-blue-700 hover:underline dark:text-blue-400">
                    {r.fromVersion ? `${formatVersion(r.fromVersion)} → ` : ''}{formatVersion(r.toVersion)}
                  </Link>
                  <span className={`flex items-center gap-1 text-xs font-medium ${st.cls}`}>{st.icon}{st.text}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {new Date(r.startedAt).toLocaleString()}{d ? ` · ${d}` : ''}{r.mode === 'auto' ? ' · automatic' : ''}
                    {r.excludedNodes.length > 0 ? ` · without ${r.excludedNodes.join(', ')}` : ''}
                  </span>
                </div>
                {r.message && r.status !== 'succeeded' && (
                  <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-300">{r.message}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
