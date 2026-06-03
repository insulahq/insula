import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import UpgradesPage from '../pages/platform/UpgradesPage';

const mockApplyMutateAsync = vi.fn();
let preflightOk = true;

vi.mock('../hooks/use-platform-updates', () => ({
  usePlatformVersion: () => ({ data: { data: { currentVersion: '2026.6.2', latestVersion: '2026.7.0', updateAvailable: true, environment: 'production' } }, isLoading: false }),
}));

vi.mock('../hooks/use-platform-upgrade', () => ({
  usePreflight: () => ({
    data: { data: {
      gates: [
        { id: 'cnpg-healthy', label: 'Database (CNPG) healthy', status: 'pass', detail: 'primary elected' },
        { id: 'disk-headroom', label: 'Disk headroom', status: 'warn', detail: 'unknown' },
      ],
      ok: preflightOk, failures: preflightOk ? 0 : 1, warnings: 1, environment: 'production',
    } },
    isLoading: false, isFetching: false, refetch: vi.fn(),
  }),
  useUpgradeApply: () => ({ mutateAsync: mockApplyMutateAsync, isPending: false, error: null }),
}));

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><UpgradesPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('UpgradesPage', () => {
  beforeEach(() => { mockApplyMutateAsync.mockReset(); preflightOk = true; });

  it('renders the version spine + pre-flight gates', () => {
    renderPage();
    expect(screen.getByText('Platform Upgrades')).toBeInTheDocument();
    expect(screen.getByText('2026.6.2')).toBeInTheDocument(); // installed
    expect(screen.getByText('2026.7.0')).toBeInTheDocument(); // available
    expect(screen.getByText('Database (CNPG) healthy')).toBeInTheDocument();
    expect(screen.getByText(/All blocking checks pass/)).toBeInTheDocument();
  });

  it('Preview does a dry-run (apply:false) and shows the plan; Apply is two-click', async () => {
    mockApplyMutateAsync.mockResolvedValueOnce({ data: { action: 'upgrade', target: '2026.7.0', reason: 'manual', proceed: true, applied: false, gitRepository: 'hosting-platform-production', environment: 'production', summary: 'DRY-RUN: would re-pin → v2026.7.0' } });
    renderPage();
    fireEvent.click(screen.getByText('Preview'));
    await waitFor(() => expect(mockApplyMutateAsync).toHaveBeenCalledWith({ version: undefined, apply: false }));
    await screen.findByText(/DRY-RUN: would re-pin/);
    // Apply appears (two-click), first click reveals the confirm
    fireEvent.click(screen.getByText(/Apply upgrade/));
    expect(screen.getByText(/Confirm upgrade/)).toBeInTheDocument();
    // Confirm performs the real apply (apply:true)
    mockApplyMutateAsync.mockResolvedValueOnce({ data: { action: 'upgrade', target: '2026.7.0', reason: 'x', proceed: true, applied: true, gitRepository: 'x', environment: 'production', summary: 're-pinned' } });
    fireEvent.click(screen.getByText(/Confirm upgrade/));
    await waitFor(() => expect(mockApplyMutateAsync).toHaveBeenCalledWith({ version: undefined, apply: true }));
  });

  it('Apply button is disabled when pre-flight has blocking failures', async () => {
    preflightOk = false;
    mockApplyMutateAsync.mockResolvedValueOnce({ data: { action: 'upgrade', target: '2026.7.0', reason: 'm', proceed: true, applied: false, gitRepository: 'x', environment: 'production', summary: 'preview' } });
    renderPage();
    expect(screen.getByText(/1 blocking failure/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Preview'));
    const applyBtn = await screen.findByText(/Apply upgrade/);
    expect(applyBtn.closest('button')).toBeDisabled();
  });
});
