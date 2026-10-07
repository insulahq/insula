import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import MailHealthDetailsModal from '../components/MailHealthDetailsModal';
import { apiFetch } from '@/lib/api-client';
import type { MailHealthResponse } from '@insula/api-contracts';

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
}));

const mockApiFetch = vi.mocked(apiFetch);
const GB = 1024 ** 3;

const BASE: MailHealthResponse = {
  healthy: false,
  checkedAt: '2026-10-01T00:00:00.000Z',
  cachedFor: 30,
  components: {
    pod: { healthy: true, error: null, podName: 'stalwart-mail-abc', node: 'node-1', phase: 'Running', containerReady: true, restartCount: 0, initContainerStatus: null },
    jmap: { healthy: true, error: null, durationMs: 12, serverName: 'Stalwart', serverVersion: null },
    rocksdb: { healthy: true, error: null, status: 'ok', currentFile: true, lockFile: true },
    cert: { healthy: true, error: null, status: 'ok', ports: [] },
    tcp: { healthy: true, error: null, status: 'ok', ports: [] },
    standby: {
      healthy: false,
      status: 'fail',
      error: '1 standby node has no copy younger than 30 min. A failover restores the newest complete copy (or the backup, if that is newer), so mail received since would be lost.',
      maxAgeSeconds: 1800,
      nodes: [{ node: 'node-2', ageSeconds: 3600, durationSeconds: 900, sizeBytes: 40 * GB, fresh: false }],
    },
    storage: {
      healthy: false,
      status: 'fail',
      error: '1 mail node has less free space than its mail data.',
      nodes: [
        { node: 'node-1', role: 'active', freeBytes: 4 * GB, mailBytes: 10 * GB, enough: false },
        { node: 'node-2', role: 'standby', freeBytes: 50 * GB, mailBytes: 10 * GB, enough: true },
      ],
    },
  },
};

function renderModal() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MailHealthDetailsModal onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('MailHealthDetailsModal — capacity', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({ data: BASE });
  });

  it('shows a stale standby copy with its age, how long the sync took, and what to do', async () => {
    renderModal();
    expect(await screen.findByText('Standby copies')).toBeInTheDocument();
    expect(screen.getByText('node-2: copy 60 min old (last sync took 15 min)')).toBeInTheDocument();
    expect(screen.getByText(/1 standby node has no copy younger than 30 min/)).toBeInTheDocument();
    expect(screen.getByText(/kubectl -n mail logs ds\/mail-stack-standby-replicate/)).toBeInTheDocument();
  });

  it('shows free space against mail data per node', async () => {
    renderModal();
    expect(await screen.findByText('Disk headroom')).toBeInTheDocument();
    expect(screen.getByText('node-1 (active): 4.0 GB free, 10.0 GB mail • node-2 (standby): 50.0 GB free, 10.0 GB mail')).toBeInTheDocument();
    expect(screen.getByText(/holds the old and new files until it finishes/)).toBeInTheDocument();
  });

  it('says there is nothing to check on an install without standby nodes', async () => {
    mockApiFetch.mockResolvedValue({
      data: {
        ...BASE,
        components: {
          ...BASE.components,
          standby: { healthy: true, status: 'not_implemented', error: null, maxAgeSeconds: 1800, nodes: [] },
        },
      },
    });
    renderModal();
    expect(await screen.findByText('no node is labelled for mail standby')).toBeInTheDocument();
  });

  it('degrades gracefully for an older backend without the capacity components', async () => {
    mockApiFetch.mockResolvedValue({
      data: { ...BASE, components: { ...BASE.components, standby: undefined, storage: undefined } },
    });
    renderModal();
    expect(await screen.findByText('Standby copies')).toBeInTheDocument();
    expect(screen.getAllByText('not reported by this backend')).toHaveLength(2);
  });
});
