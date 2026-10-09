/**
 * The progress modal is what an operator watches during an upgrade. Two things it
 * must never do: call the upgrade done while a platform migration is pending, and
 * call it broken (or hold it open) because nodes apply the release's host changes
 * later, on their own timer — that is the normal state right after an upgrade.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Gate = { id: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string; scheduled?: boolean };
let post: Record<string, unknown> | undefined;
let prog: Record<string, unknown> | undefined;
let run: Record<string, unknown> | null = null;
const cancelMutate = vi.fn();

vi.mock('@/hooks/use-platform-upgrade', () => ({
  usePostflight: () => ({ data: post ? { data: post } : undefined, failureCount: 0 }),
  useUpgradeProgress: () => ({ data: prog ? { data: prog } : undefined, failureCount: 0 }),
  useUpgradeRun: () => ({ data: { data: { run } }, failureCount: 0 }),
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
  return render(<QueryClientProvider client={qc}><Modal version="2026.10.7-rc.2" onClose={() => {}} /></QueryClientProvider>);
}

beforeEach(() => { post = undefined; prog = undefined; run = null; cancelMutate.mockReset(); });

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
    post = postflight([migrations('pass'), hosts('warn', true, '2 of 3 node(s) still on an older CLI (s2, s3); each applies this release\'s host changes when its hourly update runs')]);
    renderModal();
    expect(screen.getByText(/Done — all services are running/)).toBeInTheDocument();
    expect(screen.getByTestId('convergence-host-migrations-converged-state')).toHaveTextContent('Catching up');
    expect(screen.getByTestId('convergence-host-migrations-converged-detail')).toHaveTextContent(/hourly update/);
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
});
