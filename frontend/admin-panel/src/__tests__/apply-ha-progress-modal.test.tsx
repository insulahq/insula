/**
 * Production never runs Dex or oauth2-proxy; an HA apply there listed both as
 * FAILED, so every apply read "Apply failed" and its frozen convergence
 * snapshot looked live. A component this environment does not run is "not
 * installed", and a stopped run says its snapshot is from when it stopped.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ApplyHaProgressModal from '@/components/ApplyHaProgressModal';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn() }));

const deployments = [
  { namespace: 'platform', name: 'platform-api', previousReplicas: 1, newReplicas: 3, patched: true, error: null },
  { namespace: 'platform', name: 'dex', previousReplicas: 0, newReplicas: 0, patched: false, error: null, notInstalled: true },
  { namespace: 'mail', name: 'roundcube', previousReplicas: 0, newReplicas: 0, patched: false, error: null },
];

function run(status: string, extra: Record<string, unknown> = {}) {
  return {
    data: {
      id: '11111111-2222-4333-8444-555555555555', status, systemTier: 'ha', startedAt: '2026-10-03T23:03:30Z',
      finishedAt: status === 'running' ? null : '2026-10-03T23:03:31Z', actorId: null,
      patchOutcome: { volumes: [], deployments, cnpgClusters: [] },
      convergence: {
        volumesConverged: 1, volumesTotal: 1, volumesOffSystem: 0, cnpgConverged: 0, cnpgTotal: 1,
        deploymentsConverged: 0, deploymentsTotal: 1, lastObservedAt: '2026-10-03T23:03:31Z', elapsedMs: 1200,
        stuckResources: [{ kind: 'cnpg', name: 'platform/system-db', observed: 1, desired: 3, reason: 'Creating a new replica' }],
      },
      ...extra,
    },
  };
}

beforeEach(() => vi.mocked(apiFetch).mockReset());

describe('ApplyHaProgressModal', () => {
  it('shows a component this environment does not run as not installed, not as failed', async () => {
    vi.mocked(apiFetch).mockResolvedValue(run('succeeded') as never);
    render(<ApplyHaProgressModal runId="11111111-2222-4333-8444-555555555555" onClose={() => undefined} />);
    expect(await screen.findByText(/1 patched, 1 no-op, 0 failed, 1 not installed/)).toBeInTheDocument();
    expect(screen.getByTestId('apply-ha-not-installed')).toHaveTextContent('not installed here');
  });

  it('labels the convergence of a stopped run as a snapshot, not as live progress', async () => {
    vi.mocked(apiFetch).mockResolvedValue(run('failed') as never);
    render(<ApplyHaProgressModal runId="11111111-2222-4333-8444-555555555555" onClose={() => undefined} />);
    expect(await screen.findByText('Cluster state when the apply stopped (after 1s)')).toBeInTheDocument();
    expect(screen.getByText(/not yet at desired state then/)).toBeInTheDocument();
    expect(screen.queryByText(/still mid-rebuild/)).toBeNull();
  });

  it('a running apply keeps the live wording', async () => {
    vi.mocked(apiFetch).mockResolvedValue(run('running') as never);
    render(<ApplyHaProgressModal runId="11111111-2222-4333-8444-555555555555" onClose={() => undefined} />);
    expect(await screen.findByText('Cluster convergence')).toBeInTheDocument();
    expect(screen.getByText(/still mid-rebuild/)).toBeInTheDocument();
  });
});
