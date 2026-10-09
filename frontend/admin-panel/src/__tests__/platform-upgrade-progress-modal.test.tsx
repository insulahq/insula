/**
 * The progress modal is what an operator watches during an upgrade. Two things it
 * must never do: call the upgrade done while a platform migration is pending, and
 * call it broken (or hold it open) because nodes apply the release's host changes
 * later, on their own timer — that is the normal state right after an upgrade.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Gate = { id: string; label: string; status: 'pass' | 'warn' | 'fail'; detail: string; scheduled?: boolean };
let post: Record<string, unknown> | undefined;
let prog: Record<string, unknown> | undefined;

vi.mock('@/hooks/use-platform-upgrade', () => ({
  usePostflight: () => ({ data: post ? { data: post } : undefined, failureCount: 0 }),
  useUpgradeProgress: () => ({ data: prog ? { data: prog } : undefined, failureCount: 0 }),
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

beforeEach(() => { post = undefined; prog = undefined; });

describe('PlatformUpgradeProgressModal', () => {
  it('is Done while nodes are still catching up — and says so neutrally', () => {
    prog = rolledProgress;
    post = postflight([migrations('pass'), hosts('warn', true, '2 of 3 node(s) still on an older CLI (s2, s3); each applies this release\'s host changes when its daily update runs (within ~25 h)')]);
    renderModal();
    expect(screen.getByText(/Done — all services are running/)).toBeInTheDocument();
    expect(screen.getByTestId('convergence-host-migrations-converged-state')).toHaveTextContent('Catching up');
    expect(screen.getByTestId('convergence-host-migrations-converged-detail')).toHaveTextContent(/daily update/);
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
});
