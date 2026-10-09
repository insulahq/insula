/**
 * An upgrade rolls the admin panel while the operator's tab still runs the
 * previous build. The progress modal's "Open page" link (and any other
 * navigation) then asks for a route chunk the new image does not serve. That
 * must load the new build — not read as a crash — and must never loop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';
import { isStaleChunkError, reloadForNewBuild, STALE_CHUNK_RELOAD_GUARD_MS, type ReloadDeps } from '@/lib/stale-chunk';

function memoryStorage(): NonNullable<ReloadDeps['storage']> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
}

describe('isStaleChunkError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://admin.example.test/assets/UpgradeRunPage-abc123.js',
    'error loading dynamically imported module: https://admin.example.test/assets/x.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/index-abc.css',
  ])('recognises %s', (msg) => {
    expect(isStaleChunkError(new Error(msg))).toBe(true);
  });

  it('does not take an ordinary render error for a new build', () => {
    expect(isStaleChunkError(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
  });
});

describe('reloadForNewBuild', () => {
  it('reloads once; the page that reload brought refuses inside the guard window, then reloads again after it', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    let t = 1_000_000;
    let loadedAt = t - 5_000;
    const deps = () => ({ now: () => t, pageLoadedAt: loadedAt, storage, reload });
    expect(reloadForNewBuild(deps())).toBe(true);
    loadedAt = t + 300; // the reloaded page
    t += STALE_CHUNK_RELOAD_GUARD_MS - 1;
    expect(reloadForNewBuild(deps())).toBe(false);
    t += 2;
    expect(reloadForNewBuild(deps())).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('the same failure reported twice by one page (Vite\'s preload hook, then the boundary) is one reload, still under way', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadForNewBuild({ now: () => 50_000, pageLoadedAt: 40_000, storage, reload })).toBe(true);
    expect(reloadForNewBuild({ now: () => 50_020, pageLoadedAt: 40_000, storage, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('"never reloaded" is not "reloaded at time 0" — the first reload happens whatever the clock reads', () => {
    const reload = vi.fn();
    expect(reloadForNewBuild({ now: () => 5_000, pageLoadedAt: 4_000, storage: memoryStorage(), reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads when it cannot remember having reloaded (no sessionStorage)', () => {
    const reload = vi.fn();
    expect(reloadForNewBuild({ now: () => 1, pageLoadedAt: 0, storage: null, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('never reloads when the storage throws', () => {
    const reload = vi.fn();
    const storage = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => {} };
    expect(reloadForNewBuild({ now: () => 1, pageLoadedAt: 0, storage, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('ErrorBoundary and a route chunk of the previous build', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

  const missingChunk = () => lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module: https://admin.example.test/assets/UpgradeRunPage-old.js')));

  it('loads the new build and says so, instead of "Something went wrong"', async () => {
    const onStaleChunk = vi.fn(() => true);
    const Page = missingChunk();
    render(<ErrorBoundary onStaleChunk={onStaleChunk}><Suspense fallback={null}><Page /></Suspense></ErrorBoundary>);
    const notice = await screen.findByTestId('stale-build-notice');
    expect(notice).toHaveTextContent('The admin panel was updated');
    expect(notice).toHaveTextContent('Loading the new version…');
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    expect(onStaleChunk).toHaveBeenCalledTimes(1);
  });

  it('when the reload was refused (it just happened), asks the operator to reload instead of looping', async () => {
    const Page = missingChunk();
    render(<ErrorBoundary onStaleChunk={() => false}><Suspense fallback={null}><Page /></Suspense></ErrorBoundary>);
    const notice = await screen.findByTestId('stale-build-notice');
    expect(notice).toHaveTextContent('could not load the new one. Reload the page to load it.');
    expect(screen.getByRole('button', { name: 'Reload Page' })).toBeInTheDocument();
  });

  it('a real render error is still a crash, and does not reload', async () => {
    const onStaleChunk = vi.fn(() => true);
    const Broken = () => { throw new Error("Cannot read properties of undefined (reading 'map')"); };
    render(<ErrorBoundary onStaleChunk={onStaleChunk}><Broken /></ErrorBoundary>);
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(onStaleChunk).not.toHaveBeenCalled();
  });
});
