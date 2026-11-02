/**
 * A move that finished with the tenant on its new node but every block still on
 * the old one showed a green "Idle" — the warning sat in grey under it. It must
 * read as not done.
 */
import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import OperationProgressModal from '@/components/OperationProgressModal';
import { apiFetch } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({ apiFetch: vi.fn() }));
const mockApiFetch = vi.mocked(apiFetch);

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const LEFT = 'Running on node-a, but its data has NOT moved: Longhorn cannot place a copy there — the volume is still held '
  + 'to the Longhorn node tagged node-node-b. Move the tenant to node-a again from its Placement card.';
const op = (params: Record<string, unknown> | null, progressMessage: string) => ({
  data: {
    id: 'op-1', opType: 'relocate', state: 'idle', progressPct: 100, progressMessage,
    lastError: null, completedAt: '2026-11-01T18:29:57Z', params,
  },
});

describe('OperationProgressModal — a move whose data stayed behind', () => {
  beforeEach(() => { mockApiFetch.mockReset(); });

  it('reads as "Data not moved", in amber, with the cause and what to do', async () => {
    mockApiFetch.mockResolvedValue(op({
      targetNode: 'node-a',
      copyBlocker: { cause: 'the volume is still held to the Longhorn node tagged node-node-b', action: 'move the tenant to node-a again' },
    }, LEFT));
    render(<OperationProgressModal operationId="op-1" title="Moving to node-a" onClose={() => {}} />);
    const box = await screen.findByTestId('operation-progress-left-behind');
    expect(box).toHaveTextContent('its data has NOT moved');
    expect(box).toHaveTextContent('node-node-b');
    expect(screen.getByText('Data not moved')).toBeInTheDocument();
    expect(screen.queryByText('idle')).toBeNull();
  });

  it('a move whose copy is under way stays a plain finish', async () => {
    mockApiFetch.mockResolvedValue(op({ targetNode: 'node-a', copyBlocker: null }, 'Running on node-a. Longhorn is copying the data there in the background.'));
    render(<OperationProgressModal operationId="op-1" onClose={() => {}} />);
    expect(await screen.findByText(/Longhorn is copying the data/)).toBeInTheDocument();
    expect(screen.queryByTestId('operation-progress-left-behind')).toBeNull();
    expect(screen.queryByText('Data not moved')).toBeNull();
  });
});
