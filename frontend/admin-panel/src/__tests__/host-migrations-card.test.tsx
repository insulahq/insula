/**
 * The card exists because a blocked migration chain was invisible — DEV sat at
 * 11 pending behind one failure for five weeks. So the assertions that matter
 * are: a failure is legible (cause + how long), a *blocked* node is treated as
 * needing attention even though nothing on it "failed", and a healthy or
 * not-yet-reported node does NOT cry wolf.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const fetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => fetchMock(...a) }));

const { default: HostMigrationsCard } = await import('@/components/platform/HostMigrationsCard');

const node = (over: Record<string, unknown> = {}) => ({
  node: 'node-a', collectedAt: '2026-08-05T20:00:00Z', mode: 'enforce', source: 'embedded', ok: true,
  appliedCount: 3, failedCount: 0, blockedCount: 0, pendingCount: 0, skippedCount: 0, items: [], ...over,
});

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const resolve = (payload: unknown) => fetchMock.mockResolvedValue({ data: payload });

beforeEach(() => fetchMock.mockReset());

describe('HostMigrationsCard', () => {
  it('shows a failed migration with its cause and how long it has been failing', async () => {
    resolve({
      degraded: true, runbookUrl: 'https://example.test/runbook',
      nodes: [node({
        failedCount: 1, ok: false,
        items: [{
          key: '2026.7.1/0001-a.sh', state: 'run-failed',
          error: 'schema rejects runtimeClassName', attempt: 840, failingSince: '2026-07-01',
        }],
      })],
    });
    render(<HostMigrationsCard />, { wrapper });
    await waitFor(() => expect(screen.getByText(/needs attention/i)).toBeInTheDocument());
    expect(screen.getByText(/schema rejects runtimeClassName/)).toBeInTheDocument();
    expect(screen.getByText(/attempt 840/)).toBeInTheDocument();
    expect(screen.getByText(/failing since 2026-07-01/)).toBeInTheDocument();
  });

  it('treats a node with only BLOCKED migrations as needing attention', async () => {
    // Nothing "failed" on this node's own account — it is queued behind another
    // failure. That is the silent case the card exists for.
    resolve({
      degraded: true, runbookUrl: 'https://example.test/runbook',
      nodes: [node({ blockedCount: 2, items: [
        { key: 'v/0002.sh', state: 'blocked' }, { key: 'v/0003.sh', state: 'blocked' },
      ] })],
    });
    render(<HostMigrationsCard />, { wrapper });
    await waitFor(() => expect(screen.getByText(/needs attention/i)).toBeInTheDocument());
    expect(screen.getByText(/2 blocked/)).toBeInTheDocument();
  });

  it('links the runbook when degraded', async () => {
    resolve({
      degraded: true, runbookUrl: 'https://example.test/runbook',
      nodes: [node({ failedCount: 1, items: [{ key: 'v/0001.sh', state: 'run-failed', error: 'boom' }] })],
    });
    render(<HostMigrationsCard />, { wrapper });
    await waitFor(() =>
      expect(screen.getByTestId('host-migrations-runbook-link')).toHaveAttribute('href', 'https://example.test/runbook'),
    );
  });

  it('does NOT cry wolf on a healthy fleet', async () => {
    resolve({ degraded: false, runbookUrl: 'r', nodes: [node(), node({ node: 'node-b' })] });
    render(<HostMigrationsCard />, { wrapper });
    await waitFor(() => expect(screen.getByTestId('host-migrations-card')).toBeInTheDocument());
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId('host-migrations-runbook-link')).not.toBeInTheDocument();
  });

  it('says so plainly when a node has not reported, rather than showing a scary zero', async () => {
    resolve({
      degraded: false, runbookUrl: 'r',
      nodes: [node({ collectedAt: null, appliedCount: 0, note: 'This node has not reported host-migration state yet.' })],
    });
    render(<HostMigrationsCard />, { wrapper });
    await waitFor(() => expect(screen.getByText(/has not reported/i)).toBeInTheDocument());
    expect(screen.queryByText(/needs attention/i)).not.toBeInTheDocument();
  });

  it('shows an operator skip with its reason on expand, so it never reads as applied', async () => {
    // A healthy node stays collapsed — a skip is worth recording, not alerting.
    resolve({
      degraded: false, runbookUrl: 'r',
      nodes: [node({ skippedCount: 1, items: [
        { key: 'v/0004.sh', state: 'skipped', skipReason: 'stale values, cleared by hand' },
      ] })],
    });
    const user = userEvent.setup();
    render(<HostMigrationsCard />, { wrapper });
    await waitFor(() => expect(screen.getByTestId('host-migrations-node-node-a')).toBeInTheDocument());
    expect(screen.queryByText(/skipped by operator/i)).not.toBeInTheDocument();
    await user.click(screen.getByTestId('host-migrations-node-node-a'));
    expect(screen.getByText(/skipped by operator: stale values, cleared by hand/i)).toBeInTheDocument();
  });

  it('opens a broken node automatically — the operator should not have to hunt', async () => {
    resolve({
      degraded: true, runbookUrl: 'r',
      nodes: [node({ failedCount: 1, items: [{ key: 'v/0001.sh', state: 'run-failed', error: 'boom' }] })],
    });
    render(<HostMigrationsCard />, { wrapper });
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
  });
});
