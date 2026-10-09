/**
 * The progress modal is what an operator watches during an upgrade. Two things it
 * must never do: call the upgrade done while a platform migration is pending, and
 * call it broken (or hold it open) because nodes apply the release's host changes
 * later, on their own timer — that is the normal state right after an upgrade.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Gate = { id: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string; scheduled?: boolean };
let post: Record<string, unknown> | undefined;
let prog: Record<string, unknown> | undefined;
let run: Record<string, unknown> | null = null;
let runById: Record<string, unknown> | null = null;
const cancelMutate = vi.fn();

vi.mock('@/hooks/use-platform-upgrade', () => ({
  usePostflight: () => ({ data: post ? { data: post } : undefined, failureCount: 0 }),
  useUpgradeProgress: () => ({ data: prog ? { data: prog } : undefined, failureCount: 0 }),
  useUpgradeRun: () => ({ data: { data: { run } }, failureCount: 0 }),
  useUpgradeRunById: (id: string | undefined) => ({ data: id ? { data: runById } : undefined, failureCount: 0 }),
  useCancelUpgradeRun: () => ({ mutate: cancelMutate, isPending: false, error: null }),
}));

const { default: Modal } = await import('@/components/PlatformUpgradeProgressModal');

const rolledProgress = {
  targetTag: 'v2026.10.7-rc.2', total: 3, atTarget: 3, ready: 3, percent: 100, readable: true,
  deployments: [{ name: 'platform-api', label: 'Management API', desiredReplicas: 1, readyReplicas: 1, imageTag: '2026.10.7-rc.2', atTarget: true, phase: 'ready' }],
};
const postflight = (gates: Gate[]) => ({
  phase: 'healthy', verdict: 'healthy', consecutiveFailures: 0, abortThreshold: 3,
  pendingVersion: null, runningVersion: '2026.10.7-rc.2', gates, ok: true, failures: 0, warnings: 0,
  lastCheckedAt: null, environment: 'production',
});
const migrations = (status: Gate['status']): Gate => ({ id: 'migrations-converged', label: 'Platform migrations applied', status, detail: status === 'pass' ? 'registry converged' : '1 migration(s) not yet applied' });
const hosts = (status: Gate['status'], scheduled: boolean, detail: string): Gate => ({ id: 'host-migrations-converged', label: 'Host migrations', status, scheduled, detail });

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Modal version="2026.10.7-rc.2" onClose={() => {}} /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { post = undefined; prog = undefined; run = null; runById = null; cancelMutate.mockReset(); });

const runOf = (over: Record<string, unknown>) => ({
  id: 'r1', fromVersion: '2026.10.7-rc.1', toVersion: '2026.10.7-rc.2', mode: 'manual', status: 'running', step: 'prepare-nodes',
  excludedNodes: [], message: null, startedAt: '2026-10-09T10:00:00Z', stepStartedAt: '2026-10-09T10:00:00Z', finishedAt: null,
  nodes: [
    { node: 's1', state: 'ready', cliVersion: '2026.10.7-rc.2', detail: 'On 2026.10.7-rc.2; host changes before the services applied.' },
    { node: 's2', state: 'updating', cliVersion: '2026.10.7-rc.1', detail: 'Fetching and verifying the 2026.10.7-rc.2 CLI…' },
  ],
  ...over,
});

describe('PlatformUpgradeProgressModal', () => {
  it('is Done while nodes are still catching up — and says so neutrally', () => {
    prog = rolledProgress;
    post = postflight([migrations('pass'), hosts('warn', true, '2 of 3 node(s) still on an older CLI (s2, s3); each applies this release\'s host changes on its next update check, within the hour')]);
    renderModal();
    expect(screen.getByText(/Done — all services are running/)).toBeInTheDocument();
    expect(screen.getByTestId('convergence-host-migrations-converged-state')).toHaveTextContent('Catching up');
    expect(screen.getByTestId('convergence-host-migrations-converged-detail')).toHaveTextContent(/next update check/);
  });

  it('shows a node that needs attention without holding the services open', () => {
    prog = rolledProgress;
    post = postflight([migrations('pass'), hosts('warn', false, 'needs attention on s2 — see Host migrations')]);
    renderModal();
    expect(screen.getByText(/Done — all services are running/)).toBeInTheDocument();
    expect(screen.getByTestId('convergence-host-migrations-converged-state')).toHaveTextContent('Needs attention');
  });

  it('is NOT done while a platform migration is still pending', () => {
    prog = rolledProgress;
    post = { ...postflight([migrations('fail'), hosts('pass', false, 'All 3 node(s) on CLI 2026.10.7-rc.2; host changes applied')]), phase: 'reconciling', pendingVersion: '2026.10.7-rc.2' };
    renderModal();
    expect(screen.queryByText(/Done — all services are running/)).not.toBeInTheDocument();
    expect(screen.getByTestId('convergence-migrations-converged-state')).toHaveTextContent('Converging');
    expect(screen.getByTestId('convergence-host-migrations-converged-state')).toHaveTextContent('Applied');
  });

  it('never labels catching-up nodes as converged or applied', () => {
    prog = rolledProgress;
    post = postflight([migrations('pass'), hosts('warn', true, '1 of 3 node(s) still on an older CLI (s3)')]);
    renderModal();
    expect(screen.getByTestId('convergence-host-migrations-converged-state')).not.toHaveTextContent(/Applied|Converged/);
  });

  describe('with an upgrade run (ADR-064)', () => {
    it('while the nodes update: says the services are untouched, shows each node, hides the service roll, offers Cancel', () => {
      run = runOf({});
      prog = rolledProgress;
      renderModal();
      expect(screen.getByTestId('upgrade-run-status')).toHaveTextContent(/Updating the nodes to v2026\.10\.7-rc\.2 \(1\/2\).*services keep running the current release/);
      expect(screen.getByTestId('run-node-s1-state')).toHaveTextContent('Ready');
      expect(screen.getByTestId('run-node-s2-state')).toHaveTextContent('Updating');
      expect(screen.queryByText('Management API')).not.toBeInTheDocument();
      expect(screen.getByTestId('cancel-upgrade-btn')).toBeInTheDocument();
      expect(screen.queryByText(/Done/)).not.toBeInTheDocument();
    });

    it('Cancel asks once, then stops the run', () => {
      run = runOf({});
      renderModal();
      fireEvent.click(screen.getByTestId('cancel-upgrade-btn'));
      expect(cancelMutate).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('cancel-upgrade-confirm'));
      expect(cancelMutate).toHaveBeenCalledTimes(1);
    });

    it('rolled services are NOT done while the run still finishes host changes', () => {
      run = runOf({ step: 'finish' });
      prog = rolledProgress;
      post = postflight([migrations('pass')]);
      renderModal();
      expect(screen.queryByText(/Done/)).not.toBeInTheDocument();
      expect(screen.getByTestId('upgrade-run-status')).toHaveTextContent(/Finishing host changes/);
      expect(screen.queryByTestId('cancel-upgrade-btn')).not.toBeInTheDocument();
    });

    it('a succeeded run is Done for services AND nodes', () => {
      run = runOf({ status: 'succeeded', step: 'done' });
      renderModal();
      expect(screen.getByTestId('upgrade-run-status')).toHaveTextContent(/Done — the services and every node run v2026\.10\.7-rc\.2/);
    });

    it('a succeeded run without a node does not claim every node — it counts them and says how the rest catches up', () => {
      run = runOf({
        status: 'succeeded', step: 'done', excludedNodes: ['w1'],
        nodes: [
          { node: 's1', state: 'ready', cliVersion: '2026.10.7-rc.2', detail: 'On 2026.10.7-rc.2.' },
          { node: 'w1', state: 'excluded', cliVersion: '2026.10.7-rc.1', detail: 'Upgraded without it — it updates on its own timer when it is back.' },
        ],
      });
      renderModal();
      const line = screen.getByTestId('upgrade-run-status');
      expect(line).toHaveTextContent('Done — the services and 1 of 2 nodes run v2026.10.7-rc.2; the node left out updates on its own timer when it is back.');
      expect(line).not.toHaveTextContent(/every node/);
    });

    it('a succeeded Kubernetes run names the version, and that left-out nodes need the CLI for it', () => {
      run = runOf({
        status: 'succeeded', step: 'done', kubernetesVersion: 'v1.36.5+k3s1', excludedNodes: ['w1', 'w2'],
        nodes: [
          { node: 's1', state: 'ready', cliVersion: null, detail: 'Kubernetes v1.36.5+k3s1.' },
          { node: 'w1', state: 'excluded', cliVersion: null, detail: 'Left out.' },
          { node: 'w2', state: 'excluded', cliVersion: null, detail: 'Left out.' },
        ],
      });
      renderModal();
      expect(screen.getByTestId('upgrade-run-status')).toHaveTextContent(
        'Done — the services and 1 of 3 nodes run v2026.10.7-rc.2, on Kubernetes v1.36.5+k3s1; the 2 nodes left out update on their own timer when they are back (Kubernetes: run `insula cluster upgrade` for them).',
      );
    });

    it('a succeeded Kubernetes run with every node says so', () => {
      run = runOf({ status: 'succeeded', step: 'done', kubernetesVersion: 'v1.36.5+k3s1' });
      renderModal();
      expect(screen.getByTestId('upgrade-run-status')).toHaveTextContent('Done — the services and every node run v2026.10.7-rc.2, on Kubernetes v1.36.5+k3s1.');
    });

    it('a failed run shows its message, not a spinner', () => {
      run = runOf({ status: 'failed', message: 'Stopped before the services changed: s2 — failed. The services still run the previous release.' });
      renderModal();
      expect(screen.getByTestId('upgrade-run-status')).toHaveTextContent(/Stopped before the services changed: s2/);
    });

    it('a cancelled run reads as an outcome, not a fault, and offers no Cancel', () => {
      run = runOf({ status: 'cancelled', message: 'Cancelled by an operator before the services changed. The services still run the previous release.' });
      renderModal();
      expect(screen.getByTestId('upgrade-run-status')).toHaveTextContent(/Cancelled by an operator/);
      expect(screen.queryByTestId('cancel-upgrade-btn')).not.toBeInTheDocument();
    });

    it('a run with a Kubernetes target shows the fourth step and its status', () => {
      run = runOf({ step: 'upgrade-kubernetes', kubernetesVersion: 'v1.36.5+k3s1' });
      renderModal();
      expect(screen.getByTestId('run-step-upgrade-kubernetes')).toHaveTextContent('4. Upgrade Kubernetes to v1.36.5+k3s1');
      expect(screen.getByTestId('upgrade-run-status')).toHaveTextContent(/Upgrading Kubernetes to v1\.36\.5\+k3s1 \(1\/2\)/);
    });

    it('an excluded node reads as upgraded without, not as a fault', () => {
      run = runOf({ excludedNodes: ['s3'], nodes: [{ node: 's3', state: 'excluded', cliVersion: null, detail: 'Upgraded without it — it updates on its own timer when it is back.' }] });
      renderModal();
      expect(screen.getByTestId('run-node-s3-state')).toHaveTextContent('Upgraded without');
    });

    it('a finished run for ANOTHER version is ignored (e.g. the modal reopened for a rollback)', () => {
      run = runOf({ status: 'succeeded', step: 'done', toVersion: '2026.10.6' });
      prog = rolledProgress;
      post = postflight([migrations('pass')]);
      renderModal();
      expect(screen.queryByTestId('upgrade-run')).not.toBeInTheDocument();
      expect(screen.getByText(/Done — all services are running/)).toBeInTheDocument();
    });
  });

  describe('the run page (a view of the same component)', () => {
    it('follows the run it was opened for — a finished one stays a record, without the live roll', async () => {
      const { default: View } = await import('@/components/platform/UpgradeProgressView');
      runById = runOf({ id: 'old', status: 'succeeded', step: 'done', toVersion: '2026.10.7-rc.1', fromVersion: '2026.10.6' });
      // A different upgrade is live right now — the page must not mix it in.
      prog = rolledProgress;
      post = { ...postflight([migrations('fail')]), phase: 'reconciling', pendingVersion: '2026.10.7-rc.3' };
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(<QueryClientProvider client={qc}><MemoryRouter><View runId="old" asPage /></MemoryRouter></QueryClientProvider>);
      expect(screen.getByTestId('upgrade-run-status')).toHaveTextContent(/Done — the services and every node run v2026\.10\.7-rc\.1/);
      expect(screen.getByText(/Platform upgrade v2026\.10\.6 → v2026\.10\.7-rc\.1/)).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByText(/Reload admin panel/)).toBeNull();
      expect(screen.queryByTestId('upgrade-run-page-link')).toBeNull();
    });

    it('a failed run\'s page does not borrow the live roll of another upgrade', async () => {
      const { default: View } = await import('@/components/platform/UpgradeProgressView');
      runById = runOf({ id: 'old', status: 'failed', step: 'update-services', message: 'The services were not changed: refused.' });
      prog = rolledProgress; // another upgrade, live right now
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(<QueryClientProvider client={qc}><MemoryRouter><View runId="old" asPage /></MemoryRouter></QueryClientProvider>);
      expect(screen.getByText('33%')).toBeInTheDocument();
      expect(screen.queryByText('Management API')).toBeNull();
    });

    it('the modal links to the run\'s page', () => {
      run = runOf({});
      renderModal();
      expect(screen.getByTestId('upgrade-run-page-link')).toHaveAttribute('href', '/platform/updates/runs/r1');
    });
  });
});

