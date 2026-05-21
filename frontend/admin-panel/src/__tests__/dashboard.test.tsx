import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Dashboard from '../pages/Dashboard';

// 2026-05-21 Wave 3 — Dashboard rebuilt as incident-first. Old tests
// asserted "Total Clients / Domains / Backups" StatCards which no
// longer exist. New tests assert the contract: heading + 4 incident
// stat cards by testid + the Health banner.

vi.mock('@/hooks/use-tenants', () => ({
  useTenants: () => ({ data: { data: [] }, isLoading: false }),
}));
vi.mock('@/hooks/use-audit-logs', () => ({
  useAuditLogs: () => ({ data: { data: [] } }),
}));
vi.mock('@/hooks/use-backup-health', () => ({
  useBackupHealth: () => ({ data: [] }),
}));
vi.mock('@/hooks/use-health', () => ({
  useHealth: () => ({
    data: {
      data: {
        overall: 'healthy',
        checkedAt: new Date().toISOString(),
        services: [
          { name: 'database', status: 'ok', latencyMs: 5, message: null },
          { name: 'dns', status: 'ok', latencyMs: 10, message: null },
        ],
      },
    },
  }),
}));
vi.mock('@/hooks/use-lifecycle', () => ({
  useLifecycleTransitions: () => ({ data: { data: { transitions: [], hookRuns: {} } } }),
}));
vi.mock('@/hooks/use-pods', () => ({
  usePods: () => ({ data: { data: { pods: [], capacity: null } } }),
}));

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('Dashboard — incident-first surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Dashboard heading + the 4 incident stat cards', () => {
    render(<Dashboard />, { wrapper: createWrapper() });
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByTestId('stat-failed-pods')).toBeInTheDocument();
    expect(screen.getByTestId('stat-5xx-alerts')).toBeInTheDocument();
    expect(screen.getByTestId('stat-failing-backups')).toBeInTheDocument();
    expect(screen.getByTestId('stat-transitions')).toBeInTheDocument();
  });

  it('renders the Health banner with overall status', () => {
    render(<Dashboard />, { wrapper: createWrapper() });
    const banner = screen.getByTestId('health-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/healthy/i);
  });

  it('renders the Recent Tenants section even when empty', () => {
    render(<Dashboard />, { wrapper: createWrapper() });
    expect(screen.getByTestId('recent-tenants')).toBeInTheDocument();
  });
});
