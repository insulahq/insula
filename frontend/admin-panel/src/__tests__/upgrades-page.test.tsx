import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import UpgradesPage from '../pages/platform/UpgradesPage';

let updateAvailable = true;
let role = 'super_admin';
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

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><UpgradesPage /></MemoryRouter></QueryClientProvider>);
}

describe('UpgradesPage (consolidated)', () => {
  beforeEach(() => { updateAvailable = true; role = 'super_admin'; });

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
 * times the operator clicked. Reported 2026-08-03, ~90s after v2026.8.2 was
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
});
