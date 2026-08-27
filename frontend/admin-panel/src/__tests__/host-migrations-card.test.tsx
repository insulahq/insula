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
  appliedCount: 3, failedCount: 0, blockedCount: 0, pendingCount: 0, skippedCount: 0,
  invalidCount: 0, reason: null, items: [], ...over,
});

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/** A wrapper whose QueryClient the test can drive, to simulate the 5-min poll. */
function pollable() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const W = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper: W };
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

  it('opens a node that BREAKS BETWEEN POLLS, not just one broken on first load', async () => {
    // The list is keyed by node name, so NodeBlock never remounts across a
    // refetch — only its props change. A useState initialiser would go stale
    // here and leave the newly-broken node collapsed, which is precisely the
    // "operator has to hunt for it" outcome the auto-open exists to prevent.
    const { qc, wrapper: w } = pollable();
    resolve({ degraded: false, runbookUrl: 'r', nodes: [node()] });
    render(<HostMigrationsCard />, { wrapper: w });
    await waitFor(() => expect(screen.getByTestId('host-migrations-node-node-a')).toBeInTheDocument());
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument(); // collapsed while healthy

    resolve({
      degraded: true, runbookUrl: 'r',
      nodes: [node({ failedCount: 1, ok: false, items: [{ key: 'v/1.sh', state: 'run-failed', error: 'boom' }] })],
    });
    await qc.invalidateQueries();
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
  });

  it('surfaces a WHOLE-RUN refusal, where every count is legitimately zero', async () => {
    // ok:false with no items — nothing "failed", so a counts-only check would
    // render this as a healthy "0 applied" node running nothing at all.
    resolve({
      degraded: true, runbookUrl: 'r',
      nodes: [node({ ok: false, appliedCount: 0, reason: 'host-migration catalog has 700 scripts (> 500 cap) — refusing' })],
    });
    render(<HostMigrationsCard />, { wrapper });
    await waitFor(() => expect(screen.getByTestId('host-migrations-reason')).toBeInTheDocument());
    expect(screen.getByText(/> 500 cap/)).toBeInTheDocument();
    expect(screen.getByText(/run refused/)).toBeInTheDocument();
  });

  it('flags an invalid script, which will never run', async () => {
    resolve({
      degraded: true, runbookUrl: 'r',
      nodes: [node({ invalidCount: 1, items: [{ key: 'v/00x-bad.sh', state: 'invalid' }] })],
    });
    render(<HostMigrationsCard />, { wrapper });
    await waitFor(() => expect(screen.getByText(/1 invalid/)).toBeInTheDocument());
  });

  it('reports expand state to assistive tech', async () => {
    resolve({ degraded: false, runbookUrl: 'r', nodes: [node()] });
    const user = userEvent.setup();
    render(<HostMigrationsCard />, { wrapper });
    await waitFor(() => expect(screen.getByTestId('host-migrations-node-node-a')).toBeInTheDocument());
    const toggle = screen.getByTestId('host-migrations-node-node-a');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
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

/**
 * A node that has never converged must read as BROKEN and must carry the fix,
 * because there is nothing the panel can press on its behalf: the reconciler is
 * observe-only by design, so no in-cluster action can write a systemd unit.
 */
describe('HostMigrationsCard — never-converged node', () => {
  beforeEach(() => { fetchMock.mockReset(); });

  const stalled = node({
    node: 'sv1',
    collectedAt: null, mode: null, source: null, ok: null, appliedCount: 0,
    neverConverged: true,
    note: 'This node has NEVER converged — no host-migration has ever run on it.',
    remediation: ['# On the affected node, as root:', 'insula self-upgrade'],
  });

  it('labels it broken rather than quietly "not reported"', async () => {
    fetchMock.mockResolvedValue({ data: { nodes: [stalled], degraded: true, runbookUrl: 'https://x' } });
    render(<HostMigrationsCard />, { wrapper });
    await waitFor(() => expect(screen.getByTestId('host-migrations-node-sv1')).toBeInTheDocument());
    // Badge AND note both say it — that duplication is the point (it reads as
    // broken in the collapsed row, not only once expanded).
    expect(screen.getAllByText(/never converged/i).length).toBeGreaterThan(0);
  });

  it('shows the manual fix steps, since the panel cannot repair it', async () => {
    fetchMock.mockResolvedValue({ data: { nodes: [stalled], degraded: true, runbookUrl: 'https://x' } });
    render(<HostMigrationsCard />, { wrapper });
    // A broken node auto-opens, so the commands are visible without a click.
    await waitFor(() => expect(screen.getByTestId('host-migrations-remediation')).toBeInTheDocument());
    expect(screen.getByTestId('host-migrations-remediation').textContent).toMatch(/insula self-upgrade/);
    expect(screen.getByText(/cannot be repaired from the panel/i)).toBeInTheDocument();
  });

  it('does not show a remediation block for a healthy node', async () => {
    fetchMock.mockResolvedValue({ data: { nodes: [node()], degraded: false, runbookUrl: 'https://x' } });
    render(<HostMigrationsCard />, { wrapper });
    await waitFor(() => expect(screen.getByTestId('host-migrations-node-node-a')).toBeInTheDocument());
    expect(screen.queryByTestId('host-migrations-remediation')).not.toBeInTheDocument();
  });
});
