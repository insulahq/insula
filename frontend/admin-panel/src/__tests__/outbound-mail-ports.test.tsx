import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MailHealthResponse, NodeOutboundMail, OutboundMailPort } from '@insula/api-contracts';
import type { NodeHealthEntry } from '@/hooks/use-node-health';
import NodeHealthPanel from '@/components/NodeHealthPanel';
import MailHealthDetailsModal from '@/components/MailHealthDetailsModal';
import OutboundMailPorts, { outboundPortTitle } from '@/components/nodes/OutboundMailPorts';
import { apiFetch } from '@/lib/api-client';

/**
 * Outbound mail ports in the admin panel. A provider blocked outbound 25/465/587
 * on a production node, nothing on the node showed it, and a tenant's CRM failed
 * every notification with "Connection timed out". Node health and mail health
 * now carry each node's check; these tests pin what the operator sees.
 */

vi.mock('@/lib/api-client', () => ({
  API_BASE: 'http://localhost:3000',
  apiFetch: vi.fn(),
}));

const mockHealth = vi.fn();
vi.mock('@/hooks/use-node-health', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useNodeHealth: () => mockHealth(),
  useStalePodCounts: () => ({ data: {} }),
  useNodeMemoryEvents: () => ({ data: { data: { events: [] } }, isLoading: false, isError: false }),
  useReconcileNodeHealth: () => ({ mutate: vi.fn(), isPending: false }),
}));

const port = (p: number, status: OutboundMailPort['status'], required: boolean): OutboundMailPort => ({
  port: p,
  status,
  required,
  target: status === 'open' ? 'smtp.example.test' : null,
  latencyMs: status === 'open' ? 12 : null,
  detail: status === 'open' ? null : 'smtp.example.test timed out after 5s; smtp2.example.test timed out after 5s',
});

const mail = (ports: OutboundMailPort[], stale = false): NodeOutboundMail => ({ checkedAt: '2026-11-04T11:55:00Z', intervalSeconds: 900, stale, ports });

function entry(name: string, overrides: Partial<NodeHealthEntry> = {}): NodeHealthEntry {
  return {
    name,
    ready: true,
    severity: 'normal',
    pressures: [],
    csiDriversPresent: 2,
    csiDriversExpected: 2,
    csiDriversMissing: [],
    evictionsLastHour: 0,
    diskUsedPct: 20,
    outboundMail: null,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

describe('OutboundMailPorts', () => {
  it('colours each port by what it means for this node', () => {
    render(<OutboundMailPorts testId="p" ports={[port(25, 'blocked', false), port(465, 'open', true), port(587, 'blocked', true)]} />);
    expect(screen.getByTestId('p-25')).toHaveTextContent('25 blocked');
    expect(screen.getByTestId('p-25').className).toMatch(/bg-gray-100/);
    expect(screen.getByTestId('p-465')).toHaveTextContent(/^465$/);
    expect(screen.getByTestId('p-465').className).toMatch(/bg-green-100/);
    expect(screen.getByTestId('p-587').className).toMatch(/bg-red-100/);
    // Every pill has a dark-mode variant.
    for (const id of ['p-25', 'p-465', 'p-587']) expect(screen.getByTestId(id).className).toMatch(/dark:bg-/);
  });

  it('a stale result is greyed, labelled, and never red', () => {
    render(<OutboundMailPorts testId="p" stale ports={[port(587, 'blocked', true)]} />);
    expect(screen.getByTestId('p-587').className).not.toMatch(/bg-red/);
    expect(screen.getByText('stale')).toBeInTheDocument();
  });

  it('the hover says what each target answered — what goes to the provider', () => {
    expect(outboundPortTitle(port(587, 'blocked', true)))
      .toBe('Port 587 blocked\nsmtp.example.test timed out after 5s; smtp2.example.test timed out after 5s');
    expect(outboundPortTitle(port(25, 'blocked', false))).toMatch(/^Port 25 blocked \(not needed on this node — only a mail node delivers on it\)/);
    expect(outboundPortTitle(port(465, 'open', true))).toBe('Port 465 open — smtp.example.test accepted in 12 ms');
    expect(outboundPortTitle(port(465, 'unknown', true))).toMatch(/not checked — no target resolved/);
  });
});

describe('Node health — Mail ports out', () => {
  beforeEach(() => {
    mockHealth.mockReturnValue({
      data: {
        data: {
          nodes: [
            entry('sv4', { severity: 'warning', outboundMail: mail([port(25, 'blocked', false), port(465, 'blocked', true), port(587, 'blocked', true)]) }),
            entry('sv1', { outboundMail: mail([port(25, 'open', true), port(465, 'open', true), port(587, 'open', true)]) }),
            entry('sv9'),
          ],
          overallSeverity: 'warning',
          lastTickAt: new Date().toISOString(),
        },
      },
      isLoading: false, isError: false, error: null,
    });
  });

  it('shows the ports per node, and why a node is at warning level', () => {
    wrap(<NodeHealthPanel />);
    expect(screen.getByText('Mail ports out')).toBeInTheDocument();
    const sv4 = screen.getByTestId('node-health-row-sv4');
    expect(within(sv4).getByTestId('node-outbound-sv4-587')).toHaveAttribute('data-status', 'blocked');
    expect(within(sv4).getByText(/outbound mail port 465\/587 blocked — ask the provider to unblock it/)).toBeInTheDocument();
    const sv1 = screen.getByTestId('node-health-row-sv1');
    expect(within(sv1).getByTestId('node-outbound-sv1-25')).toHaveAttribute('data-status', 'open');
    expect(sv1).not.toHaveTextContent(/outbound mail port/);
  });

  it('a node whose probe has not reported says so instead of looking fine', () => {
    wrap(<NodeHealthPanel />);
    expect(within(screen.getByTestId('node-health-row-sv9')).getByTestId('node-outbound-sv9-unchecked')).toHaveTextContent('not checked');
  });
});

describe('Mail health — Outbound delivery', () => {
  const okComponents: MailHealthResponse['components'] = {
    pod: { healthy: true, error: null, podName: 'stalwart-mail-abc', node: 'sv1', phase: 'Running', containerReady: true, restartCount: 0, initContainerStatus: null },
    jmap: { healthy: true, error: null, durationMs: 12, serverName: 'Stalwart', serverVersion: null },
    rocksdb: { healthy: true, error: null, status: 'ok', currentFile: true, lockFile: true },
    cert: { healthy: true, error: null, status: 'ok', ports: [] },
    tcp: { healthy: true, error: null, status: 'ok', ports: [] },
  };
  const response = (outbound: MailHealthResponse['components']['outbound']): MailHealthResponse => ({
    healthy: outbound?.healthy ?? true,
    checkedAt: '2026-11-04T12:00:00.000Z',
    cachedFor: 30,
    components: { ...okComponents, outbound },
  });

  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('names the blocked mail node, what it means, and what to do', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      data: response({
        status: 'fail',
        healthy: false,
        error: 'Outbound port 25 is blocked on sv3 (the secondary mail node): mail would stop going out if the mail server moved there. Ask the hosting provider to unblock outbound TCP 25.',
        deliveryPort: 25,
        nodes: [
          { node: 'sv1', role: 'primary', active: true, checkedAt: '2026-11-04T11:55:00Z', stale: false, delivery: 'open',
            ports: [port(25, 'open', true), port(465, 'open', true), port(587, 'open', true)] },
          { node: 'sv3', role: 'secondary', active: false, checkedAt: '2026-11-04T11:55:00Z', stale: false, delivery: 'blocked',
            ports: [port(25, 'blocked', true), port(465, 'open', true), port(587, 'open', true)] },
        ],
      }),
    });
    wrap(<MailHealthDetailsModal onClose={() => {}} />);
    const card = await screen.findByTestId('mail-health-outbound');
    expect(within(card).getByText('Outbound mail ports')).toBeInTheDocument();
    expect(within(card).getByText('sv1 (primary, mail server here): 25 open • sv3 (secondary): 25 blocked')).toBeInTheDocument();
    expect(within(card).getByText(/mail would stop going out if the mail server moved there/)).toBeInTheDocument();
    expect(within(card).getByText(/Ask the provider to unblock outbound TCP 25, 465 and 587/)).toBeInTheDocument();
    expect(within(card).getByTestId('mail-outbound-sv3-25')).toHaveAttribute('data-status', 'blocked');
  });

  it('says when no mail node has reported yet, rather than passing silently', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      data: response({ status: 'not_implemented', healthy: true, error: null, deliveryPort: 25, nodes: [] }),
    });
    wrap(<MailHealthDetailsModal onClose={() => {}} />);
    const card = await screen.findByTestId('mail-health-outbound');
    expect(within(card).getByText(/no mail node has reported an outbound check yet/)).toBeInTheDocument();
  });
});
