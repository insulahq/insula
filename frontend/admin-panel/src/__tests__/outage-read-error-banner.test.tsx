import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClusterOutageImpact } from '@insula/api-contracts';
import NodeOutageBanner from '../components/outage/NodeOutageBanner';

const useOutageImpact = vi.fn();
vi.mock('../hooks/use-outage-impact', () => ({
  useOutageImpact: () => useOutageImpact(),
}));

/**
 * What the 2026-09-12 quorum-loss drill actually put in front of the operator:
 * a raw Kubernetes client dump, response headers and all. Honest, and close to
 * unreadable. Their first question in an incident is "what can I no longer
 * trust?", not "what did the client library return?".
 */
const RAW_K8S_ERROR =
  'longhorn replicas: fetch failed; longhorn volumes: fetch failed; nodes: HTTP-Code: 503 '
  + 'Message: Unknown API Status Code! Body: "{\\"kind\\":\\"Status\\",\\"metadata\\":{},'
  + '\\"status\\":\\"Failure\\",\\"message\\":\\"apiserver not ready\\",\\"reason\\":'
  + '\\"ServiceUnavailable\\",\\"code\\":503}\\n" Headers: {"content-length":"124"}';

const impact = (over: Partial<ClusterOutageImpact> = {}): ClusterOutageImpact => ({
  nodesDown: [],
  affectedTenants: [],
  affectedTenantCount: 0,
  downTenantCount: 0,
  degradedTenantCount: 0,
  mailAffected: false,
  degradedServices: [],
  observedAt: '2026-09-12T10:47:00Z',
  readError: null,
  ...over,
});

function renderBanner() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <NodeOutageBanner />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NodeOutageBanner read-error state', () => {
  beforeEach(() => useOutageImpact.mockReset());

  it('leads with the consequence, not the raw client error', () => {
    useOutageImpact.mockReturnValue({ data: { data: impact({ readError: RAW_K8S_ERROR }) } });
    renderBanner();
    const el = screen.getByTestId('node-outage-read-error');

    // The headline sentence must be readable prose.
    expect(el.textContent).toContain('Cluster health cannot be determined');
    expect(el.textContent).toContain('unknown rather than healthy');

    // The raw text is still available — hidden behind a disclosure, not removed.
    expect(screen.getByTestId('node-outage-read-error-details')).toBeTruthy();
    expect(el.textContent).toContain('HTTP-Code: 503');
  });

  it('puts the raw dump inside the details element, not the headline', () => {
    useOutageImpact.mockReturnValue({ data: { data: impact({ readError: RAW_K8S_ERROR }) } });
    renderBanner();
    const details = screen.getByTestId('node-outage-read-error').querySelector('details');
    expect(details).toBeTruthy();
    expect(details?.textContent).toContain('Headers:');

    // The first paragraph is what an operator reads at a glance; it must not
    // contain the blob.
    const lead = screen.getByTestId('node-outage-read-error').querySelector('p');
    expect(lead?.textContent).not.toContain('HTTP-Code');
    expect(lead?.textContent).not.toContain('Headers:');
  });

  it('says tenants keep serving — the question an operator asks first', () => {
    // Measured in the same drill: sites returned 200 from every node, including
    // the two whose k3s was stopped. Saying so prevents a panicked response to
    // a control-plane-only outage.
    useOutageImpact.mockReturnValue({ data: { data: impact({ readError: RAW_K8S_ERROR }) } });
    renderBanner();
    expect(screen.getByTestId('node-outage-read-error').textContent)
      .toContain('keep serving');
  });

  it('renders nothing when the read succeeded and no node is down', () => {
    useOutageImpact.mockReturnValue({ data: { data: impact() } });
    renderBanner();
    expect(screen.queryByTestId('node-outage-read-error')).toBeNull();
    expect(screen.queryByTestId('node-outage-banner')).toBeNull();
  });

  it('prefers the read-error state over the outage banner when both could apply', () => {
    // A partially-read cluster must not present a confident list of down nodes.
    useOutageImpact.mockReturnValue({
      data: {
        data: impact({
          readError: RAW_K8S_ERROR,
          nodesDown: [{
            name: 'staging3', role: 'server', notReadySince: null,
            isMailActiveNode: false, ingressMode: 'all', ingressAddresses: [],
          }],
        }),
      },
    });
    renderBanner();
    expect(screen.getByTestId('node-outage-read-error')).toBeTruthy();
    expect(screen.queryByTestId('node-outage-banner')).toBeNull();
  });
});
