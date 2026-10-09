import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { X, CheckCircle, Loader2, AlertTriangle, Clock, XCircle, MinusCircle, ExternalLink } from 'lucide-react';
import { usePostflight, useUpgradeProgress, useUpgradeRun, useUpgradeRunById } from '@/hooks/use-platform-upgrade';
import { formatVersion } from '@/lib/format-version';
import UpgradeRunSection, { runPercent, runStatusLine } from '@/components/platform/UpgradeRunSection';

/**
 * The live view of a platform upgrade — rendered as the re-openable Task Center
 * modal (`kind: platform.upgrade`, `target.modal: 'platform-upgrade'`) and as the
 * run's own page (/platform/updates/runs/:id), which survives a reload and is the
 * record of a finished run (ADR-064 §6).
 *
 * The backend task carries `{ version }` in modalProps. This view polls the
 * upgrade RUN (/upgrade/run — nodes first, then the services, then the finish;
 * ADR-064), the LIVE roll-progress endpoint (/upgrade/progress, every 4s) and the
 * post-flight convergence state (/upgrade/postflight) — the same signals the
 * Upgrades page shows — so the operator can close the page and reopen live
 * progress from the Tasks chip. A rollback (or an upgrade started before runs
 * existed) has no run, and shows the services' roll alone.
 */
interface Props {
  readonly version?: string;
  /** Follow this run (the page). Without it: the run in flight, or the one for `version`. */
  readonly runId?: string;
  /** Modal only — the page has no close button. */
  readonly onClose?: () => void;
  readonly asPage?: boolean;
}

const PHASE = {
  pending: { label: 'Queued', cls: 'text-gray-500 dark:text-gray-400' },
  downloading: { label: 'Downloading', cls: 'text-blue-600 dark:text-blue-400' },
  starting: { label: 'Deploying', cls: 'text-blue-600 dark:text-blue-400' },
  ready: { label: 'Ready', cls: 'text-green-700 dark:text-green-400' },
  error: { label: 'Failed', cls: 'text-red-600 dark:text-red-400' },
} as const;

/**
 * The convergence rows. Only platform migrations hold "Done": they run as the
 * new platform-api starts, inside the upgrade. Host migrations do not — the run
 * applies them on the nodes before and after the services, and a node it left
 * out catches up on its hourly timer — so they are shown for what they are
 * (applied / catching up / needs attention) and never hold the modal open.
 */
const CONVERGENCE_GATES = [
  { id: 'migrations-converged', label: 'Platform migrations', holdsDone: true },
  { id: 'host-migrations-converged', label: 'Host migrations', holdsDone: false },
] as const;

export default function UpgradeProgressView({ version, runId, onClose, asPage = false }: Props) {
  const latestQ = useUpgradeRun(runId === undefined);
  const byIdQ = useUpgradeRunById(runId);
  const runQ = runId === undefined ? latestQ : byIdQ;
  const latestRun = runId === undefined ? (latestQ.data?.data.run ?? null) : null;
  // The run this view follows: the one asked for; else the one in flight, or the
  // one for this version.
  const run = runId !== undefined
    ? (byIdQ.data?.data ?? null)
    : latestRun && (latestRun.status === 'running' || (version !== undefined && latestRun.toVersion === version))
      ? latestRun : null;
  // The services' live signals belong to the run in flight — not to a finished
  // run opened from the history.
  const live = runId === undefined || run?.status === 'running';
  // A finished run's page does not poll the cluster's live state.
  const postQ = usePostflight(live);
  const post = live ? postQ.data?.data : undefined;
  // Active (poll) while an upgrade is pending/reconciling; once idle the roll is done.
  const pending = post?.pendingVersion ?? null;
  const active = live && (!!pending || post?.phase === 'reconciling' || run?.step === 'update-services');
  const progQ = useUpgradeProgress(active);
  const prog = live ? progQ.data?.data : undefined;

  // Formatted only when it IS a version: the fallback is prose, and
  // "v the new version" is worse than no prefix at all. `targetTag` arrives
  // already prefixed (it is a git tag), which formatVersion tolerates.
  const targetVersion = version ?? run?.toVersion ?? pending ?? prog?.targetTag ?? null;
  const target = targetVersion ? formatVersion(targetVersion) : 'the new version';
  const stuck = (!run || run.step === 'update-services') && post?.verdict === 'abort-recommended';
  // The roll is physically DONE when every version-managed Deployment is on the
  // target image (the live /progress signal — refreshes ~4s), even before the
  // post-flight reconciler clears `pending_update_version` on its slower 2-min
  // tick. Fall back to the post-flight 'healthy'/'idle' verdict when there's no
  // live progress data. Without this the modal shows "Rolling…" for up to 2 min
  // after the upgrade has actually finished.
  const rolled = !!prog && prog.total > 0 && prog.atTarget >= prog.total && (prog.percent ?? 0) >= 100;
  const converged = !active && (post?.phase === 'healthy' || post?.phase === 'idle');
  // …but ROLLED IS NOT DONE. Images are only the part Flux can see: platform
  // migrations run after the new pod is serving, and host migrations converge
  // per node. `rolled || converged` reported 100% Done the moment the last
  // Deployment hit its tag — which is exactly what three clusters showed on
  // while their migration registry sat halted at 0008.
  //
  // Absent gates keep the old behaviour rather than hanging the modal open on
  // missing data: only a gate that EXISTS, holds `done`, and is not passing does.
  const convergencePending = CONVERGENCE_GATES.some(({ id, holdsDone }) => {
    if (!holdsDone) return false;
    const g = post?.gates?.find((x) => x.id === id);
    return g !== undefined && g.status !== 'pass';
  });
  // With a run, the run decides: it ends only after the nodes finished too.
  const done = run ? run.status === 'succeeded' : (!stuck && !convergencePending && (rolled || converged));
  const runFailed = run?.status === 'failed';
  // Cancelled before the services changed, or a rollback took over: an outcome, not a fault.
  const runStopped = run?.status === 'cancelled' || run?.status === 'rolled-back';
  // The services' live roll belongs to the run in flight only — a finished run's
  // page must not borrow the percentage of another upgrade the tab watched.
  const percent = run ? runPercent(run, live ? (prog?.percent ?? null) : null) : done ? 100 : (prog?.percent ?? (active ? 0 : 100));
  // Connection is flaky mid-roll (admin-panel + platform-api pods restart).
  // failureCount rises on each failed poll and resets on the next success →
  // a live "reconnecting" hint so the modal never looks frozen.
  const reconnecting = live && (active || run?.status === 'running') && !done && !stuck
    && (postQ.failureCount > 0 || progQ.failureCount > 0 || runQ.failureCount > 0);

  // When the roll completes, refresh the version spine so the dashboard badge +
  // update banner drop the just-superseded "update available" immediately, instead
  // of waiting out usePlatformVersion's 60s staleTime / 5-min poll.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (done && live) {
      queryClient.invalidateQueries({ queryKey: ['platform-version'] });
      queryClient.invalidateQueries({ queryKey: ['upgrade-postflight'] });
    }
  }, [done, live, queryClient]);

  const card = (
      <div className={asPage
        ? 'w-full rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800'
        : 'w-full max-w-lg rounded-lg bg-white dark:bg-gray-800 shadow-xl'} data-testid="upgrade-progress-view">
        <div className="flex items-center justify-between gap-2 border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Platform upgrade {run?.fromVersion ? <>{formatVersion(run.fromVersion)} </> : null}→ {target}
          </h2>
          <div className="flex items-center gap-1">
            {/* The run's own page: it survives a reload and stays as the record. */}
            {!asPage && run && (
              <Link
                to={`/platform/updates/runs/${run.id}`}
                onClick={onClose}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                data-testid="upgrade-run-page-link"
              >
                <ExternalLink size={13} /> Open page
              </Link>
            )}
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded-md p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <X size={18} />
              </button>
            )}
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Status line */}
          <div className="flex items-center gap-2 text-sm">
            {run && runStopped ? (
              <><MinusCircle size={16} className="flex-shrink-0 text-gray-500 dark:text-gray-400" /><span className="text-gray-700 dark:text-gray-300" data-testid="upgrade-run-status">{runStatusLine(run, target)}</span></>
            ) : run && runFailed ? (
              <><XCircle size={16} className="flex-shrink-0 text-red-600 dark:text-red-400" /><span className="text-red-700 dark:text-red-300" data-testid="upgrade-run-status">{runStatusLine(run, target)}</span></>
            ) : run && done ? (
              <><CheckCircle size={16} className="text-green-600 dark:text-green-400" /><span className="font-medium text-green-700 dark:text-green-300" data-testid="upgrade-run-status">{runStatusLine(run, target)}</span></>
            ) : done ? (
              <><CheckCircle size={16} className="text-green-600 dark:text-green-400" /><span className="font-medium text-green-700 dark:text-green-300">Done — all services are running {target}.</span></>
            ) : stuck ? (
              <><AlertTriangle size={16} className="text-amber-600 dark:text-amber-400" /><span className="text-amber-700 dark:text-amber-300">Not converging after {post?.consecutiveFailures} checks — consider rolling back below.</span></>
            ) : run ? (
              <><Loader2 size={16} className="flex-shrink-0 animate-spin text-blue-600 dark:text-blue-400" /><span className="text-gray-700 dark:text-gray-300" data-testid="upgrade-run-status">{runStatusLine(run, target)}</span></>
            ) : (
              <><Loader2 size={16} className="animate-spin text-blue-600 dark:text-blue-400" /><span className="text-gray-700 dark:text-gray-300">Rolling services to {target}…</span></>
            )}
          </div>

          {/* Progress bar */}
          <div>
            <div className="mb-1 flex justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>{prog && !run ? `${prog.atTarget}/${prog.total} · ${percent}%` : `${percent}%`}</span>
              {post?.lastCheckedAt && <span>checked {new Date(post.lastCheckedAt).toLocaleTimeString()}</span>}
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className={`h-full rounded-full transition-all ${done ? 'bg-green-500' : runFailed ? 'bg-red-500' : runStopped ? 'bg-gray-400 dark:bg-gray-500' : stuck ? 'bg-amber-500' : 'bg-blue-500'}`}
                style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
              />
            </div>
          </div>

          {run && <UpgradeRunSection run={run} />}

          {/* Per-component checklist with phase (Queued → Downloading → Deploying → Ready).
              Not while a run is still updating the nodes: nothing has rolled yet. */}
          {prog?.deployments && prog.deployments.length > 0 && run?.step !== 'prepare-nodes' && (
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

          {/* Convergence rows — the half of an upgrade Flux cannot see.
              Images rolling is not the upgrade finishing: platform migrations
              land seconds after the new pod starts. Host migrations are applied
              by the run on each node; a node it left out catches up on its
              hourly timer — so "catching up" is shown neutrally, never as a
              fault. Red/amber only
              for a real problem (a stuck platform migration, or a node whose
              host migrations failed). */}
          {CONVERGENCE_GATES.map(({ id, label, holdsDone }) => {
            const g = post?.gates?.find((x) => x.id === id);
            if (!g) return null; // not reported
            const ok = g.status === 'pass';
            const catchingUp = !ok && !holdsDone && g.scheduled === true;
            const attention = !ok && !holdsDone && !catchingUp;
            // `stuck` is the streak-based "this is not moving" signal — the only
            // thing that turns a pending platform-migration gate red.
            const failed = !ok && holdsDone && stuck;
            const state = ok
              ? { text: 'Applied', cls: PHASE.ready.cls, icon: <CheckCircle size={13} className="text-green-600 dark:text-green-400" /> }
              : catchingUp
                ? { text: 'Catching up', cls: 'text-gray-600 dark:text-gray-300', icon: <Clock size={13} className="text-gray-500 dark:text-gray-400" /> }
                : attention
                  ? { text: 'Needs attention', cls: 'text-amber-700 dark:text-amber-300', icon: <AlertTriangle size={13} className="text-amber-500" /> }
                  : failed
                    ? { text: 'Stalled', cls: PHASE.error.cls, icon: <AlertTriangle size={13} className="text-red-500" /> }
                    : { text: 'Converging', cls: PHASE.starting.cls, icon: <Loader2 size={13} className="animate-spin text-blue-500" /> };
            return (
              <div key={id} className="text-sm" data-testid={`convergence-${id}`}>
                <div className="flex items-center justify-between">
                  <span className="text-gray-700 dark:text-gray-300">{label}</span>
                  <span className="flex items-center gap-1.5 text-xs">
                    {state.icon}
                    <span className={`font-medium ${state.cls}`} data-testid={`convergence-${id}-state`}>{state.text}</span>
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400" data-testid={`convergence-${id}-detail`}>{g.detail}</p>
              </div>
            );
          })}

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
        {done && live && (
          <div className="flex items-center justify-between gap-3 border-t border-gray-200 dark:border-gray-700 px-5 py-3">
            <span className="text-xs text-gray-500 dark:text-gray-400">The admin panel was upgraded — reload to load its new version.</span>
            <button type="button" onClick={() => window.location.reload()} className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 whitespace-nowrap">Reload admin panel</button>
          </div>
        )}
      </div>
  );

  if (asPage) return card;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      {card}
    </div>
  );
}
