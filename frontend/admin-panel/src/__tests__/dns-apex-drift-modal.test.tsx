import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DnsApexDriftReport } from '@insula/api-contracts';

const mutateAsync = vi.fn();

vi.mock('../hooks/use-dns-apex-drift', () => ({
  useFixDnsApexDrift: () => ({ mutateAsync, isPending: false, error: null }),
}));

import DnsApexDriftModal from '../components/DnsApexDriftModal';

function createTestQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderModal(report: DnsApexDriftReport, onFixStarted = vi.fn()) {
  const qc = createTestQueryClient();
  render(
    <QueryClientProvider client={qc}>
      <DnsApexDriftModal report={report} onClose={vi.fn()} onFixStarted={onFixStarted} />
    </QueryClientProvider>,
  );
  return { onFixStarted };
}

const baseReport: DnsApexDriftReport = {
  scannedAt: '2026-08-11T09:00:00.000Z',
  trigger: 'manual',
  expected: [
    { type: 'A', content: '203.0.113.10' },
    { type: 'A', content: '203.0.113.11' },
  ],
  domains: [
    {
      domainId: '11111111-1111-4111-8111-111111111111',
      domainName: 'drift-one.example.test',
      expected: [],
      missing: [{ type: 'A', content: '203.0.113.11' }],
      unmanaged: [{ type: 'A', content: '198.51.100.7' }],
      error: null,
    },
    {
      domainId: '22222222-2222-4222-8222-222222222222',
      domainName: 'drift-two.example.test',
      expected: [],
      missing: [{ type: 'A', content: '203.0.113.11' }],
      unmanaged: [],
      error: null,
    },
    {
      domainId: '33333333-3333-4333-8333-333333333333',
      domainName: 'unreadable.example.test',
      expected: [],
      missing: [],
      unmanaged: [],
      error: 'PowerDNS API error: 401',
    },
    {
      domainId: '44444444-4444-4444-8444-444444444444',
      domainName: 'clean.example.test',
      expected: [],
      missing: [],
      unmanaged: [],
      error: null,
    },
  ],
  driftCount: 2,
  unmanagedCount: 1,
  errorCount: 1,
  scanError: null,
};

beforeEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({ data: { taskId: 'task-1', domainCount: 2 } });
});

describe('DnsApexDriftModal', () => {
  it('lists drifting domains with the records that would be added', () => {
    renderModal(baseReport);
    expect(screen.getByTestId('dns-apex-drift-domain-drift-one.example.test')).toBeInTheDocument();
    expect(screen.getByTestId('dns-apex-drift-domain-drift-two.example.test')).toBeInTheDocument();
    expect(screen.getAllByText(/203\.0\.113\.11/).length).toBeGreaterThan(0);
  });

  // The additive contract has to be visible, or an operator reasonably assumes
  // "fix" means "make DNS match exactly" and expects extras to be removed.
  it('shows unmanaged records and says they are left alone', () => {
    renderModal(baseReport);
    expect(screen.getByText(/Also present \(left alone\)/)).toBeInTheDocument();
    expect(screen.getByText(/198\.51\.100\.7/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is ever removed/i)).toBeInTheDocument();
  });

  // An unreadable zone must not be repairable — we don't know what's there.
  it('renders unreadable zones without a checkbox', () => {
    renderModal(baseReport);
    expect(screen.getByTestId('dns-apex-drift-unreadable-unreadable.example.test')).toBeInTheDocument();
    expect(
      screen.queryByTestId('dns-apex-drift-checkbox-unreadable.example.test'),
    ).not.toBeInTheDocument();
  });

  it('disables "Fix selected" until something is selected', () => {
    renderModal(baseReport);
    expect(screen.getByTestId('dns-apex-drift-fix-selected')).toBeDisabled();
    fireEvent.click(screen.getByTestId('dns-apex-drift-checkbox-drift-one.example.test'));
    expect(screen.getByTestId('dns-apex-drift-fix-selected')).toBeEnabled();
  });

  it('submits only the selected domain ids', async () => {
    const { onFixStarted } = renderModal(baseReport);
    fireEvent.click(screen.getByTestId('dns-apex-drift-checkbox-drift-two.example.test'));
    fireEvent.click(screen.getByTestId('dns-apex-drift-fix-selected'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({
      domainIds: ['22222222-2222-4222-8222-222222222222'],
    }));
    await waitFor(() => expect(onFixStarted).toHaveBeenCalledWith('task-1'));
  });

  it('select-all covers every drifting domain but not the unreadable one', async () => {
    renderModal(baseReport);
    fireEvent.click(screen.getByTestId('dns-apex-drift-select-all'));
    fireEvent.click(screen.getByTestId('dns-apex-drift-fix-selected'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({
      domainIds: [
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ],
    }));
  });

  it('"Fix all domains" sends all=true rather than an id list', async () => {
    renderModal(baseReport);
    fireEvent.click(screen.getByTestId('dns-apex-drift-fix-all'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ all: true }));
  });

  it('reports a clean scan and offers nothing to fix', () => {
    renderModal({
      ...baseReport,
      domains: [baseReport.domains[3]],
      driftCount: 0,
      unmanagedCount: 0,
      errorCount: 0,
    });
    expect(screen.getByTestId('dns-apex-drift-none')).toBeInTheDocument();
    expect(screen.getByTestId('dns-apex-drift-fix-all')).toBeDisabled();
  });
});
