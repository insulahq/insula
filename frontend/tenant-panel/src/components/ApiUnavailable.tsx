import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, ServerCrash } from 'lucide-react';

interface ApiUnavailableProps {
  /** Failed probes so far — shown so the wait does not look frozen. */
  readonly attempts: number;
  /** Epoch ms of the first probe, for the elapsed counter. */
  readonly since: number;
  readonly onRetry: () => void;
  /** "admin panel" / "tenant panel" — only used in the copy. */
  readonly panelLabel: string;
}

/** After this long the wait stops looking routine and gets an explanation. */
const SLOW_HINT_AFTER_MS = 60_000;

/**
 * Shown on the login page instead of a password form when the platform API is
 * not reachable — typically the ~2-3 minutes after a node reboot, during which
 * the panel pod is Ready long before platform-api is. Without this the
 * operator gets a form that looks fine and fails only on submit.
 */
export default function ApiUnavailable({ attempts, since, onRetry, panelLabel }: ApiUnavailableProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const elapsedMs = Math.max(0, now - since);
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const elapsedLabel = elapsedSec < 60
    ? `${elapsedSec}s`
    : `${Math.floor(elapsedSec / 60)}m ${String(elapsedSec % 60).padStart(2, '0')}s`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-linear-to-br from-brand-500 to-accent-500 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-800 p-8 shadow-xl" data-testid="api-unavailable">
        <div className="mb-6 flex flex-col items-center">
          <img src="/insula-mark.svg" alt="Insula" className="h-14 w-14" />
          <h1 className="mt-4 text-xl font-bold text-gray-900 dark:text-gray-100">Insula</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Sign in to {panelLabel}</p>
        </div>

        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-4 text-sm text-amber-900 dark:text-amber-100">
          <div className="flex items-center gap-2 font-medium">
            <ServerCrash size={16} aria-hidden="true" />
            <span>Waiting for the platform API…</span>
          </div>
          <p className="mt-2 text-amber-800 dark:text-amber-200">
            Sign-in is unavailable until the API responds. This page retries on
            its own and will show the sign-in form the moment it does.
          </p>
          <p className="mt-3 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300" data-testid="api-unavailable-elapsed">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            <span>
              Waiting {elapsedLabel} · {attempts} {attempts === 1 ? 'attempt' : 'attempts'}
            </span>
          </p>
          {elapsedMs >= SLOW_HINT_AFTER_MS && (
            <p className="mt-3 border-t border-amber-200 dark:border-amber-800 pt-3 text-xs text-amber-800 dark:text-amber-200" data-testid="api-unavailable-hint">
              Still waiting. After a node restart the API typically takes two to
              three minutes longer than this page to come up. If it persists,
              check that the <code className="font-mono">platform-api</code> pod
              is Running and that its database is reachable.
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onRetry}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
          data-testid="api-unavailable-retry"
        >
          <RefreshCw size={16} aria-hidden="true" /> Retry now
        </button>
      </div>
    </div>
  );
}
