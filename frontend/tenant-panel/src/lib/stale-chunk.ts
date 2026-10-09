/**
 * A route chunk that no longer exists.
 *
 * Every route is code-split (App.tsx, React.lazy) and Vite names each chunk by
 * its content hash. When the panel is redeployed — every platform upgrade rolls
 * it — a tab that still runs the previous build asks for chunk files the new
 * image does not serve, and the lazy import rejects. That is not a crash: a full
 * load of the same URL fetches the new index.html, which names the new files.
 */

/** Chrome / Firefox / Safari wording for a failed dynamic import, and Vite's CSS preload. */
const STALE_CHUNK_RE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

const RELOAD_AT_KEY = 'insula:stale-chunk-reload-at';

/** A second failure this soon after reloading is an outage, not a new build — stop reloading. */
export const STALE_CHUNK_RELOAD_GUARD_MS = 30_000;

export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return STALE_CHUNK_RE.test(message);
}

export interface ReloadDeps {
  readonly now: () => number;
  /** When this page was loaded (epoch ms) — tells a reload this page started from one an earlier page did. */
  readonly pageLoadedAt: number;
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  readonly reload: () => void;
}

function browserDeps(): ReloadDeps {
  let storage: ReloadDeps['storage'] = null;
  try { storage = window.sessionStorage; } catch { storage = null; }
  return { now: () => Date.now(), pageLoadedAt: performance.timeOrigin, storage, reload: () => window.location.reload() };
}

/**
 * Load the current URL again, once. True when a reload is under way — started
 * now, or already by this page (the same failure can arrive twice: Vite's
 * preload event and the error boundary). False — and nothing done — when an
 * earlier page reloaded within the guard window (the new build failed too), or
 * it cannot remember that it did (no sessionStorage), so a chunk that is really
 * missing never loops the tab.
 */
export function reloadForNewBuild(deps: ReloadDeps = browserDeps()): boolean {
  if (!deps.storage) return false;
  try {
    const raw = deps.storage.getItem(RELOAD_AT_KEY);
    const last = raw === null ? null : Number(raw);
    const now = deps.now();
    if (last !== null && Number.isFinite(last) && now - last < STALE_CHUNK_RELOAD_GUARD_MS) return last >= deps.pageLoadedAt;
    deps.storage.setItem(RELOAD_AT_KEY, String(now));
  } catch {
    return false;
  }
  deps.reload();
  return true;
}
