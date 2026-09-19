import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import UpgradesPage from '../pages/platform/UpgradesPage';

let updateAvailable = true;
let role = 'super_admin';
let changelogNotes: string | null = '## Fixed\n- alias drift false positives';
const checkMutate = vi.fn();

vi.mock('../hooks/use-platform-updates', () => ({
  usePlatformVersion: () => ({
    data: { data: {
      currentVersion: '2026.6.2', installed: '2026.6.2', running: '2026.6.2',
      latestVersion: null, latestSource: 'releases', available: '2026.7.0', availableVerifyStatus: 'verified',
      updateAvailable, environment: 'production', imageUpdateStrategy: 'manual', autoUpdate: false,
      pendingVersion: null, lastCheckedAt: null,
    } },
    isLoading: false, isFetching: false, refetch: vi.fn(),
  }),
  useCheckForUpdates: () => ({ mutate: checkMutate, isPending: false }),
  useUpdateSettings: () => ({ mutate: vi.fn(), isPending: false }),
  // Used by ChangelogModal, which the review modal can open.
  usePlatformChangelog: (version: string | undefined) => ({
    data: { data: { version: version ?? '', notes: changelogNotes, source: changelogNotes ? 'release' : 'none', url: 'https://example.test/release' } },
    isLoading: false,
    error: null,
  }),
}));

vi.mock('../hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'sa', role } }) }));

vi.mock('../hooks/use-platform-upgrade', () => ({
  useRollback: () => ({ mutateAsync: vi.fn(async () => ({ data: { ok: false, manifest: null, summary: 'nothing to roll back' } })), isPending: false, error: null }),
  // Used by the review modal when it opens
  usePreflight: () => ({ data: { data: { gates: [{ id: 'cnpg-healthy', label: 'Database (CNPG) healthy', status: 'pass', detail: 'ok' }], ok: true, failures: 0, warnings: 0, environment: 'production' } }, isLoading: false, isFetching: false, refetch: vi.fn() }),
  useHostMigrationsPreview: () => ({ data: { data: { mode: 'observe', willRun: false, note: 'report-only' } }, isLoading: false }),
  useUpgradeApply: () => ({ mutateAsync: vi.fn(async () => ({ data: { action: 'upgrade', target: '2026.7.0', proceed: true, applied: false, summary: 'DRY-RUN', interruption: { singleNode: false, nodeCount: 3, tenantWorkloadsAffected: false, summary: 's', services: [] } } })), isPending: false, error: null }),
  usePostflight: () => ({ data: undefined, isLoading: false, isError: false, failureCount: 0 }),
  useUpgradeProgress: () => ({ data: undefined, isLoading: false, isError: false, failureCount: 0 }),
}));

function renderPage(path = '/platform/updates') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}><UpgradesPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UpgradesPage (consolidated)', () => {
  beforeEach(() => { updateAvailable = true; role = 'super_admin'; changelogNotes = '## Fixed\n- alias drift false positives'; });

  it('version card shows installed + verified available (green) + update badge + small images button', () => {
    renderPage();
    expect(screen.getByTestId('current-version')).toHaveTextContent('2026.6.2');
    const avail = screen.getByTestId('latest-version');
    expect(avail).toHaveTextContent('2026.7.0'); // from `available`, not the null latestVersion
    expect(avail.className).toMatch(/text-green/); // highlighted when an update is available
    expect(screen.getByText('update available')).toBeInTheDocument();
    expect(screen.getByTestId('show-deployed-images-button')).toBeInTheDocument();
  });

  it('shows Run upgrade only when an update is available (super_admin) and it opens the review modal', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('run-upgrade-btn'));
    expect(screen.getByTestId('upgrade-review-modal')).toBeInTheDocument();
    expect(screen.getByTestId('approve-upgrade-btn')).toBeInTheDocument();
  });

  it('hides Run upgrade when no update is available', () => {
    updateAvailable = false;
    renderPage();
    expect(screen.queryByTestId('run-upgrade-btn')).toBeNull();
  });

  it('hides Run upgrade for a non-super_admin', () => {
    role = 'admin';
    renderPage();
    expect(screen.queryByTestId('run-upgrade-btn')).toBeNull();
  });
});

/**
 * "Check for updates" used to call refetch() on the version query, which only
 * re-reads what the hourly poller CronJob last wrote to the DB — and with a 60s
 * staleTime, repeated clicks often did not even reach the network. A release
 * published since the last tick was therefore invisible no matter how many
 * times the operator clicked. Reported, ~90s after v2026.8.2 was
 * published: the 23:42 poll ran before the release existed, next tick an hour
 * away, and the button could not close that gap.
 */
describe('UpgradesPage — Check for updates actually polls', () => {
  beforeEach(() => { checkMutate.mockClear(); });

  it('issues a real poll instead of only re-reading cached state', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('check-updates-btn'));
    expect(checkMutate).toHaveBeenCalledTimes(1);
  });

  it('polls again on every click — the gap it closes can be seconds wide', () => {
    renderPage();
    const btn = screen.getByTestId('check-updates-btn');
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(checkMutate).toHaveBeenCalledTimes(2);
  });

  // ── Banner hand-off: ?review=1 opens the review modal on arrival ───────────
});


// Own top-level describe with its own state reset. Nested inside another
// describe these shared module-level fixtures (`role`, `updateAvailable`)
// carried over from whichever test ran last, and the modal silently never
// opened — the negative assertions still passed, which is exactly how that
// kind of leak hides.
describe('UpgradesPage — review hand-off + changelog', () => {
  beforeEach(() => {
    updateAvailable = true;
    role = 'super_admin';
    changelogNotes = '## Fixed\n- alias drift false positives';
  });

  describe('?review=1 hand-off from the update banner', () => {
    it('opens the review modal directly for a super_admin', async () => {
      renderPage('/platform/updates?review=1');
      expect(await screen.findByTestId('approve-upgrade-btn')).toBeInTheDocument();
    });

    it('does NOT open it for a non-super_admin, whose apply would be refused', () => {
      role = 'admin';
      renderPage('/platform/updates?review=1');
      expect(screen.queryByTestId('approve-upgrade-btn')).toBeNull();
    });

    it('does NOT open it when no update is available', () => {
      updateAvailable = false;
      renderPage('/platform/updates?review=1');
      expect(screen.queryByTestId('approve-upgrade-btn')).toBeNull();
    });

    it('stays closed without the param', () => {
      renderPage();
      expect(screen.queryByTestId('approve-upgrade-btn')).toBeNull();
    });
  });

  // ── Changelog step inside the review modal ─────────────────────────────────
  describe('Review changelog', () => {
    it('offers the changelog BEFORE the approve action, in DOM order', async () => {
      renderPage('/platform/updates?review=1');
      const review = await screen.findByTestId('review-changelog-btn');
      const approve = screen.getByTestId('approve-upgrade-btn');
      // Node.compareDocumentPosition: 4 === FOLLOWING, i.e. approve comes after.
      expect(review.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('shows the release notes for the resolved target and can approve from there', async () => {
      renderPage('/platform/updates?review=1');
      fireEvent.click(await screen.findByTestId('review-changelog-btn'));
      expect(await screen.findByTestId('changelog-body')).toHaveTextContent('alias drift false positives');
      // The changelog modal carries its own approve so reading is not a detour.
      expect(screen.getByTestId('changelog-approve-upgrade-btn')).toBeEnabled();
      expect(screen.getByTestId('changelog-cancel-btn')).toBeInTheDocument();
    });

    it('says so plainly when a version has no published notes', async () => {
      changelogNotes = null;
      renderPage('/platform/updates?review=1');
      fireEvent.click(await screen.findByTestId('review-changelog-btn'));
      expect(await screen.findByTestId('changelog-body')).toHaveTextContent(/No release notes/i);
    });
  });
});
