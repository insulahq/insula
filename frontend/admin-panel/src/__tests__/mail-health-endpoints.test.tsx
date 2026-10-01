import { render, screen, within } from '@testing-library/react';
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

const PORTS = [25, 465, 587, 143, 993, 995, 4190];

// The reported 2-node shape plus a standby: mail on node-1 (activeNodeOnly),
// node-2 is the standby secondary. A third server (node-3) holds no slot and
// publishes nothing — the backend leaves it out entirely, and so must the UI.
const HEALTH: MailHealthResponse = {
  healthy: true,
  checkedAt: '2026-10-01T00:00:00.000Z',
  cachedFor: 30,
  components: {
    pod: { healthy: true, error: null, podName: 'stalwart-mail-abc', node: 'node-1', phase: 'Running', containerReady: true, restartCount: 0, initContainerStatus: null },
    jmap: { healthy: true, error: null, durationMs: 12, serverName: 'Stalwart', serverVersion: null },
    rocksdb: { healthy: true, error: null, status: 'ok', currentFile: true, lockFile: true },
    cert: { healthy: true, error: null, status: 'ok', ports: [] },
    tcp: { healthy: true, error: null, status: 'ok', ports: [] },
    exposure: {
      healthy: true,
      error: null,
      status: 'ok',
      nodes: [{ node: 'node-1', exposure: 'hostPort', ready: true, error: null, ports: PORTS.map((port) => ({ port, published: true })) }],
    },
    deliverability: {
      healthy: true,
      error: null,
      status: 'ok',
      hostname: 'mail.example.test',
      expectedMailIps: ['203.0.113.11'],
      forwardDns: null,
      reverseDns: [
        { severity: 'ok', assertion: 'PTR', actual: null, expected: null, remediation: null, ip: '203.0.113.11', node: 'node-1', family: 'ipv4', ptrRecords: [], expectedPtr: 'mail.example.test', fcrdnsOk: true },
        { severity: 'ok', assertion: 'PTR', actual: null, expected: null, remediation: null, ip: '2001:db8::11', node: 'node-1', family: 'ipv6', ptrRecords: [], expectedPtr: 'mail.example.test', fcrdnsOk: true },
      ],
      blocklists: [
        { severity: 'ok', assertion: 'not listed', actual: null, expected: null, remediation: null, ip: '203.0.113.11', node: 'node-1', family: 'ipv4', list: 'Spamhaus ZEN', zone: 'zen.spamhaus.org', listed: false, reasonTxt: null, lookupUrl: null },
      ],
      certSanMatch: null,
      smtpBanner: null,
      summary: { ok: 3, warning: 0, fail: 0, advisory: 0, skipped: 0 },
    },
  },
  endpoints: {
    mode: 'activeNodeOnly',
    activeNode: 'node-1',
    activeNodeSource: 'pod',
    ports: PORTS,
    endpoints: [
      {
        node: 'node-1',
        roles: ['primary'],
        active: true,
        exposure: 'hostPort',
        addresses: [
          { address: '203.0.113.11', family: 'ipv4', source: 'ExternalIP' },
          { address: '2001:db8::11', family: 'ipv6', source: 'ExternalIP' },
        ],
      },
    ],
    untested: [
      { node: 'node-2', roles: ['secondary'], reason: 'standby', detail: 'Port exposure is activeNodeOnly, so only the active mail node (node-1) publishes the mail ports.' },
    ],
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

describe('MailHealthDetailsModal — mail endpoints', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue({ data: HEALTH });
  });

  it('shows the tested endpoint with both address families and its port exposure', async () => {
    renderModal();
    const row = await screen.findByTestId('mail-endpoint-node-1');
    expect(within(row).getByText('203.0.113.11')).toBeInTheDocument();
    expect(within(row).getByText('2001:db8::11')).toBeInTheDocument();
    expect(within(row).getByText('primary, active')).toBeInTheDocument();
    expect(within(row).getByText('Stalwart hostPort')).toBeInTheDocument();
    expect(within(row).getByText(/7\/7 published/)).toBeInTheDocument();
  });

  it('lists the standby as "Not tested — standby" with the reason', async () => {
    renderModal();
    const row = await screen.findByTestId('mail-untested-node-2');
    expect(within(row).getByText(/Not tested — standby/)).toBeInTheDocument();
    expect(within(row).getByText(/only the active mail node/)).toBeInTheDocument();
    expect(screen.queryByTestId('mail-endpoint-node-2')).not.toBeInTheDocument();
  });

  it('never mentions a node outside the endpoint set', async () => {
    renderModal();
    await screen.findByTestId('mail-endpoints-section');
    expect(screen.queryByText(/node-3/)).not.toBeInTheDocument();
  });

  it('labels each reverse-DNS card with node and family', async () => {
    renderModal();
    expect(await screen.findByText('Reverse DNS — node-1 · IPv4 (203.0.113.11)')).toBeInTheDocument();
    expect(screen.getByText('Reverse DNS — node-1 · IPv6 (2001:db8::11)')).toBeInTheDocument();
  });

  it('renders the port-exposure card in the cluster section', async () => {
    renderModal();
    expect(await screen.findByText('Mail port exposure')).toBeInTheDocument();
    expect(screen.getByText(/1\/1 endpoint node\(s\) publishing: node-1 \(hostPort\) ok/)).toBeInTheDocument();
  });

  it('degrades gracefully for an older backend without endpoints / exposure', async () => {
    const older: MailHealthResponse = {
      ...HEALTH,
      endpoints: undefined,
      components: { ...HEALTH.components, exposure: undefined },
    };
    mockApiFetch.mockResolvedValue({ data: older });
    renderModal();
    expect(await screen.findAllByText(/Reverse DNS — node-1/)).toHaveLength(2);
    expect(screen.queryByTestId('mail-endpoints-section')).not.toBeInTheDocument();
    expect(screen.queryByText('Mail port exposure')).not.toBeInTheDocument();
  });
});
