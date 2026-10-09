/**
 * A platform upgrade rolls the tenant panel while a tenant's tab still runs the
 * previous build; the next navigation asks for a route chunk the new image does
 * not serve. That must load the new build, not read as a crash — and a scoped
 * widget boundary keeps its quiet fallback instead of reloading the page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';
import { isStaleChunkError, reloadForNewBuild, type ReloadDeps } from '@/lib/stale-chunk';

const STALE = 'Failed to fetch dynamically imported module: https://panel.example.test/assets/Dashboard-old.js';
const missingChunk = () => lazy(() => Promise.reject(new Error(STALE)));

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('stale route chunks in the tenant panel', () => {
  it('recognises the browsers\' wording and nothing else', () => {
    expect(isStaleChunkError(new Error(STALE))).toBe(true);
    expect(isStaleChunkError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isStaleChunkError(new Error('x is undefined'))).toBe(false);
  });

  it('reloads at most once inside the guard window, and not again from the page it brought', () => {
    const m = new Map<string, string>();
    const storage: NonNullable<ReloadDeps['storage']> = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
    const reload = vi.fn();
    // This page reloads once; a second report of the same failure finds it under way.
    expect(reloadForNewBuild({ now: () => 5_000, pageLoadedAt: 1_000, storage, reload })).toBe(true);
    expect(reloadForNewBuild({ now: () => 5_100, pageLoadedAt: 1_000, storage, reload })).toBe(true);
    // The page that reload brought fails too: an outage, not a new build — no second reload.
    expect(reloadForNewBuild({ now: () => 6_000, pageLoadedAt: 5_500, storage, reload })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the app-level boundary loads the new build instead of "Something went wrong"', async () => {
    const onStaleChunk = vi.fn(() => true);
    const Page = missingChunk();
    render(<ErrorBoundary onStaleChunk={onStaleChunk}><Suspense fallback={null}><Page /></Suspense></ErrorBoundary>);
    expect(await screen.findByTestId('stale-build-notice')).toHaveTextContent('Loading the new version…');
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    expect(onStaleChunk).toHaveBeenCalledTimes(1);
  });

  it('a scoped widget boundary shows its fallback and leaves reloading to the page', async () => {
    const onStaleChunk = vi.fn(() => true);
    const Widget = missingChunk();
    render(
      <div>
        <p>rest of the page</p>
        <ErrorBoundary fallback={<span>widget hidden</span>} label="w" onStaleChunk={onStaleChunk}><Suspense fallback={null}><Widget /></Suspense></ErrorBoundary>
      </div>,
    );
    expect(await screen.findByText('widget hidden')).toBeInTheDocument();
    expect(screen.getByText('rest of the page')).toBeInTheDocument();
    expect(onStaleChunk).not.toHaveBeenCalled();
  });
});
