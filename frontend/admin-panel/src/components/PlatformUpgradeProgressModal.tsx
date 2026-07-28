import { X, CheckCircle, Loader2, AlertTriangle } from 'lucide-react';
import { usePostflight, useUpgradeProgress } from '@/hooks/use-platform-upgrade';

/**
 * Re-openable Task Center progress modal for a platform upgrade
 * (`kind: platform.upgrade`, `target.modal: 'platform-upgrade'`).
 *
 * The backend task carries `{ version }` in modalProps. This modal polls the
 * LIVE roll-progress endpoint (/upgrade/progress, every 4s) + the post-flight
 * convergence state (/upgrade/postflight) — the same signals the Upgrades page
 * shows — so the operator can close the page and reopen live progress from the
 * Tasks chip.
 */
interface Props {
  readonly version?: string;
  readonly onClose: () => void;
}

export default function PlatformUpgradeProgressModal({ version, onClose }: Props) {
  const { data: postRes } = usePostflight(true);
  const post = postRes?.data;
  // Active (poll) while an upgrade is pending/reconciling; once idle the roll is done.
  const pending = post?.pendingVersion ?? null;
  const active = !!pending || post?.phase === 'reconciling';
  const { data: progRes } = useUpgradeProgress(active);
  const prog = progRes?.data;

  const target = version ?? pending ?? prog?.targetTag ?? 'the new version';
  const percent = prog?.percent ?? (active ? 0 : 100);
  const converged = !active && (post?.phase === 'healthy' || post?.phase === 'idle');
  const stuck = post?.verdict === 'abort-recommended';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Platform upgrade → {target}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Status line */}
          <div className="flex items-center gap-2 text-sm">
            {converged ? (
              <><CheckCircle size={16} className="text-green-600 dark:text-green-400" /><span className="text-green-700 dark:text-green-300">Upgraded to {target} — all services converged.</span></>
            ) : stuck ? (
              <><AlertTriangle size={16} className="text-amber-600 dark:text-amber-400" /><span className="text-amber-700 dark:text-amber-300">Not converging after {post?.consecutiveFailures} checks — consider rolling back from Platform → Upgrades.</span></>
            ) : (
              <><Loader2 size={16} className="animate-spin text-blue-600 dark:text-blue-400" /><span className="text-gray-700 dark:text-gray-300">Rolling services to {target}…</span></>
            )}
          </div>

          {/* Progress bar */}
          <div>
            <div className="mb-1 flex justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>{prog ? `${prog.atTarget}/${prog.total} · ${percent}%` : `${percent}%`}</span>
              {post?.lastCheckedAt && <span>checked {new Date(post.lastCheckedAt).toLocaleTimeString()}</span>}
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className={`h-full rounded-full transition-all ${converged ? 'bg-green-500' : stuck ? 'bg-amber-500' : 'bg-blue-500'}`}
                style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
              />
            </div>
          </div>

          {/* Per-service checklist */}
          {prog?.deployments && prog.deployments.length > 0 && (
            <ul className="space-y-1">
              {prog.deployments.map((d) => (
                <li key={d.name} className="flex items-center justify-between text-sm">
                  <span className="text-gray-700 dark:text-gray-300">{d.label}</span>
                  <span className="flex items-center gap-1 text-xs">
                    {d.atTarget ? (
                      <><CheckCircle size={13} className="text-green-600 dark:text-green-400" /><span className="text-green-700 dark:text-green-300">{d.imageTag}</span></>
                    ) : (
                      <><Loader2 size={13} className="animate-spin text-blue-500" /><span className="text-gray-500 dark:text-gray-400">{d.imageTag}</span></>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* Post-flight failing gates (only when stuck) */}
          {stuck && post?.gates?.some((g) => g.status === 'fail') && (
            <ul className="space-y-1 rounded-md bg-amber-50 dark:bg-amber-900/20 p-2">
              {post.gates.filter((g) => g.status === 'fail').map((g) => (
                <li key={g.id} className="text-xs text-amber-800 dark:text-amber-200">{g.label}: {g.detail}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
