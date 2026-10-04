/**
 * The route ("apex") DNS drift modal: what it says, what it will change, and
 * that it names the servers behind every address.
 */
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DnsApexDriftReport } from '@insula/api-contracts';

const fixMutate = vi.fn();
const scanMutate = vi.fn();
vi.mock('../hooks/use-dns-apex-drift', () => ({
  useFixDnsApexDrift: () => ({ mutate: fixMutate, isPending: false, isError: false, error: null }),
  useScanDnsApexDrift: () => ({ mutate: scanMutate, isPending: false, isError: false, error: null }),
}));
// Server aliases: sv-new is shown as "Frankfurt 2".
vi.mock('../hooks/use-node-labels', () => ({
  useNodeLabel: () => (name: string | null | undefined) => (name === 'sv-new' ? 'Frankfurt 2' : name ?? ''),
}));

const { default: DnsApexDriftModal } = await import('../components/DnsApexDriftModal');

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';

const report: DnsApexDriftReport = {
  version: 2,
  scannedAt: '2026-10-04T09:00:00.000Z',
  trigger: 'manual',
  ingressSource: 'discovered',
  expected: [
    { type: 'A', content: '203.0.113.1', servers: ['sv1'] },
    { type: 'A', content: '203.0.113.2', servers: ['sv-new'] },
  ],
  servers: [
    { name: 'sv1', ipv4: ['203.0.113.1'], ipv6: [], status: 'ingress' },
    { name: 'sv-new', ipv4: ['203.0.113.2'], ipv6: [], status: 'ingress' },
    { name: 'sv-old', ipv4: ['203.0.113.9'], ipv6: [], status: 'removed' },
  ],
  domains: [
    {
      domainId: D1, domainName: 'example.test', error: null, missingCount: 1, staleCount: 1, heldCount: 0, foreignCount: 1,
      hostnames: [{
        hostname: 'example.test', recordName: '@', ok: 1,
        missing: [{ type: 'A', content: '203.0.113.2', servers: ['sv-new'] }],
        stale: [{ type: 'A', content: '203.0.113.9', servers: ['sv-old'], reason: 'server-removed' }],
        held: [],
        foreign: [{ type: 'A', content: '198.51.100.7' }],
      }],
    },
    { domainId: D2, domainName: 'clean.test', error: null, missingCount: 0, staleCount: 0, heldCount: 0, foreignCount: 0, hostnames: [] },
  ],
  driftCount: 1, missingCount: 1, staleCount: 1, heldCount: 0, foreignCount: 1, errorCount: 0, scanError: null,
};

function renderModal(r: DnsApexDriftReport | null, onFixStarted = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DnsApexDriftModal report={r} onClose={vi.fn()} onFixStarted={onFixStarted} />
    </QueryClientProvider>,
  );
  return { onFixStarted };
}

beforeEach(() => { fixMutate.mockReset(); scanMutate.mockReset(); });

describe('DnsApexDriftModal', () => {
  it('explains what is checked and why — and no longer promises an additive-only repair', () => {
    renderModal(report);
    const explainer = screen.getByTestId('dns-apex-drift-explainer');
    expect(explainer).toHaveTextContent('What is checked');
    expect(explainer).toHaveTextContent('Why fix it');
    expect(explainer).toHaveTextContent('removes the stale ones');
    expect(explainer).toHaveTextContent('never removes an address published by a hand-made record');
    expect(document.body).not.toHaveTextContent('repair is additive');
  });

  it('Refresh rescans', () => {
    renderModal(report);
    fireEvent.click(screen.getByTestId('dns-apex-drift-refresh'));
    expect(scanMutate).toHaveBeenCalledTimes(1);
  });

  it('lists the servers by name with their addresses and status', () => {
    renderModal(report);
    const row = screen.getByTestId('dns-apex-drift-server-sv-new');
    expect(row).toHaveTextContent('Frankfurt 2');
    expect(row).toHaveTextContent('203.0.113.2');
    expect(row).toHaveTextContent('serves ingress');
    expect(screen.getByTestId('dns-apex-drift-server-sv-old')).toHaveTextContent('removed');
  });

  it('shows what the repair adds and removes, with the server behind each address', () => {
    renderModal(report);
    const domain = screen.getByTestId('dns-apex-drift-domain-example.test');
    expect(within(domain).getByTestId('dns-apex-drift-add')).toHaveTextContent('A 203.0.113.2 (Frankfurt 2)');
    const remove = within(domain).getByTestId('dns-apex-drift-remove');
    expect(remove).toHaveTextContent('A 203.0.113.9 (sv-old)');
    expect(remove).toHaveTextContent('server removed');
    expect(within(domain).getByTestId('dns-apex-drift-foreign')).toHaveTextContent('left alone');
    expect(screen.queryByTestId('dns-apex-drift-domain-clean.test')).toBeNull();
  });

  it('fixes the selected domains or all of them, and hands back the task', () => {
    const { onFixStarted } = renderModal(report);
    expect(screen.getByTestId('dns-apex-drift-fix-selected')).toBeDisabled();
    fireEvent.click(screen.getByTestId('dns-apex-drift-select-example.test'));
    fireEvent.click(screen.getByTestId('dns-apex-drift-fix-selected'));
    expect(fixMutate.mock.calls[0][0]).toEqual({ domainIds: [D1] });

    fireEvent.click(screen.getByTestId('dns-apex-drift-fix-all'));
    expect(fixMutate.mock.calls[1][0]).toEqual({ all: true });
    fixMutate.mock.calls[1][1].onSuccess({ data: { taskId: 't-1', domainCount: 1 } });
    expect(onFixStarted).toHaveBeenCalledWith('t-1');
  });

  it('records kept on purpose are listed with why, and are not offered for repair', () => {
    const D3 = '33333333-3333-4333-8333-333333333333';
    const holding = {
      domainId: D3, domainName: 'held.test', error: null, missingCount: 0, staleCount: 0, heldCount: 1, foreignCount: 0,
      hostnames: [{
        hostname: 'held.test', recordName: '@', ok: 2, missing: [], stale: [], foreign: [],
        held: [{ type: 'A' as const, content: '203.0.113.4', servers: ['sv-new'], reason: 'server-not-ready' as const }],
      }],
    };
    renderModal({ ...report, domains: [holding], driftCount: 0, missingCount: 0, staleCount: 0, heldCount: 1, foreignCount: 0 });
    expect(screen.getByTestId('dns-apex-drift-held-section')).toHaveTextContent('Kept on purpose (1)');
    expect(screen.getByTestId('dns-apex-drift-held')).toHaveTextContent('A 203.0.113.4 (Frankfurt 2)');
    expect(screen.getByTestId('dns-apex-drift-held')).toHaveTextContent('not ready right now');
    expect(screen.queryByTestId('dns-apex-drift-fix-all')).toBeNull();
  });

  it('a clean report says so and offers no repair', () => {
    renderModal({ ...report, domains: [report.domains[1]], driftCount: 0, missingCount: 0, staleCount: 0, foreignCount: 0 });
    expect(screen.getByTestId('dns-apex-drift-clean')).toHaveTextContent('1 domain checked');
    expect(screen.queryByTestId('dns-apex-drift-fix-all')).toBeNull();
  });

  it('with no scan yet, it asks for one', () => {
    renderModal(null);
    expect(screen.getByTestId('dns-apex-drift-scanned')).toHaveTextContent('Not scanned yet');
    expect(document.body).toHaveTextContent('No scan has run yet');
  });
});
