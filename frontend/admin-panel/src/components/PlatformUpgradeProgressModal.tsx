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

const PHASE = {
  pending: { label: 'Queued', cls: 'text-gray-500 dark:text-gray-400' },
  downloading: { label: 'Downloading', cls: 'text-blue-600 dark:text-blue-400' },
  starting: { label: 'Deploying', cls: 'text-blue-600 dark:text-blue-400' },
  ready: { label: 'Ready', cls: 'text-green-700 dark:text-green-400' },
  error: { label: 'Failed', cls: 'text-red-600 dark:text-red-400' },
} as const;

export default function PlatformUpgradeProgressModal({ version, onClose }: Props) {
  const postQ = usePostflight(true);
  const post = postQ.data?.data;
  // Active (poll) while an upgrade is pending/reconciling; once idle the roll is done.
  const pending = post?.pendingVersion ?? null;
  const active = !!pending || post?.phase === 'reconciling';
  const progQ = useUpgradeProgress(active);
  const prog = progQ.data?.data;

  const target = version ?? pending ?? prog?.targetTag ?? 'the new version';
  const stuck = post?.verdict === 'abort-recommended';
  // The roll is physically DONE when every version-managed Deployment is on the
  // target image (the live /progress signal — refreshes ~4s), even before the
  // post-flight reconciler clears `pending_update_version` on its slower 2-min
  // tick. Fall back to the post-flight 'healthy'/'idle' verdict when there's no
  // live progress data. Without this the modal shows "Rolling…" for up to 2 min
  // after the upgrade has actually finished.
  const rolled = !!prog && prog.total > 0 && prog.atTarget >= prog.total && (prog.percent ?? 0) >= 100;
  const converged = !active && (post?.phase === 'healthy' || post?.phase === 'idle');
  const done = !stuck && (rolled || converged);
  const percent = done ? 100 : (prog?.percent ?? (active ? 0 : 100));
  // Connection is flaky mid-roll (admin-panel + platform-api pods restart).
  // failureCount rises on each failed poll and resets on the next success →
  // a live "reconnecting" hint so the modal never looks frozen.
  const reconnecting = active && !done && !stuck && (postQ.failureCount > 0 || progQ.failureCount > 0);

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
            {done ? (
              <><CheckCircle size={16} className="text-green-600 dark:text-green-400" /><span className="font-medium text-green-700 dark:text-green-300">Done — all services are running {target}.</span></>
            ) : stuck ? (
              <><AlertTriangle size={16} className="text-amber-600 dark:text-amber-400" /><span className="text-amber-700 dark:text-amber-300">Not converging after {post?.consecutiveFailures} checks — consider rolling back below.</span></>
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
                className={`h-full rounded-full transition-all ${done ? 'bg-green-500' : stuck ? 'bg-amber-500' : 'bg-blue-500'}`}
                style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
              />
            </div>
          </div>

          {/* Per-component checklist with phase (Queued → Downloading → Deploying → Ready) */}
          {prog?.deployments && prog.deployments.length > 0 && (
            <ul className="space-y-1">
              {prog.deployments.map((d) => {
                const ph = PHASE[d.phase ?? (d.atTarget ? 'ready' : 'starting')];
                const isReady = d.atTarget || d.phase === 'ready';
                return (
                  <li key={d.name} className="flex items-center justify-between text-sm">
                    <span className="text-gray-700 dark:text-gray-300">{d.label}</span>
                    <span className="flex items-center gap-1.5 text-xs">
                      {isReady
                        ? <CheckCircle size={13} className="text-green-600 dark:text-green-400" />
                        : d.phase === 'error'
                          ? <AlertTriangle size={13} className="text-red-500" />
                          : <Loader2 size={13} className="animate-spin text-blue-500" />}
                      <span className={`font-medium ${ph.cls}`}>{ph.label}</span>
                      <span className="text-gray-400 dark:text-gray-500 font-mono">{d.imageTag}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Reconnecting hint — the modal keeps polling through the roll. */}
          {reconnecting && (
            <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <Loader2 size={12} className="animate-spin" />
              Reconnecting… the admin panel + API restart during the upgrade; progress resumes automatically.
            </div>
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
        {/* After a completed upgrade the admin panel itself rolled to the new
            version — offer a reload to load its new bundle. The live indicators
            above already refreshed on their own (resilient polling), so this is
            only to pick up new admin-panel UI, not to un-freeze progress. */}
        {done && (
          <div className="flex items-center justify-between gap-3 border-t border-gray-200 dark:border-gray-700 px-5 py-3">
            <span className="text-xs text-gray-500 dark:text-gray-400">The admin panel was upgraded — reload to load its new version.</span>
            <button type="button" onClick={() => window.location.reload()} className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap">Reload admin panel</button>
          </div>
        )}
      </div>
    </div>
  );
}
