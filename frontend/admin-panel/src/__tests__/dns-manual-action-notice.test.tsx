import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { NodeDown } from '@insula/api-contracts';
import DnsManualActionNotice from '../components/outage/DnsManualActionNotice';

const down = (over: Partial<NodeDown> = {}): NodeDown => ({
  name: 'node-c',
  role: 'server',
  notReadySince: '2026-09-11T20:30:00Z',
  isMailActiveNode: false,
  ingressMode: 'all',
  ingressAddresses: ['198.51.100.7', '2001:db8::7'],
  ...over,
});

describe('DnsManualActionNotice', () => {
  it('renders nothing when no node is down', () => {
    render(<DnsManualActionNotice nodesDown={[]} />);
    expect(screen.queryByTestId('dns-manual-action-notice')).toBeNull();
  });

  it('names the down node and the addresses DNS still resolves to', () => {
    render(<DnsManualActionNotice nodesDown={[down()]} />);
    const el = screen.getByTestId('dns-manual-action-notice');
    expect(el.textContent).toContain('node-c');
    expect(screen.getByTestId('dns-stale-addresses').textContent).toContain('198.51.100.7');
    expect(screen.getByTestId('dns-stale-addresses').textContent).toContain('2001:db8::7');
  });

  it('says explicitly that the platform will not remove them', () => {
    // The operator must not wait for an automatic cleanup that is never coming.
    render(<DnsManualActionNotice nodesDown={[down()]} />);
    expect(screen.getByTestId('dns-manual-action-notice').textContent)
      .toContain('does not manage your DNS');
  });

  it('stays silent for an ingress:none node — nothing was ever published for it', () => {
    render(<DnsManualActionNotice nodesDown={[down({ ingressMode: 'none' })]} />);
    expect(screen.queryByTestId('dns-manual-action-notice')).toBeNull();
  });

  it('stays silent when a down node has no known addresses', () => {
    // An empty address list means the read did not give us one; inventing an
    // action item with nothing to act on wastes the operator's attention.
    render(<DnsManualActionNotice nodesDown={[down({ ingressAddresses: [] })]} />);
    expect(screen.queryByTestId('dns-manual-action-notice')).toBeNull();
  });

  it('covers every serving node when several are down at once', () => {
    render(
      <DnsManualActionNotice
        nodesDown={[
          down(),
          down({ name: 'node-d', ingressAddresses: ['198.51.100.9'] }),
          down({ name: 'node-e', ingressMode: 'none' }),
        ]}
      />,
    );
    const text = screen.getByTestId('dns-stale-addresses').textContent ?? '';
    expect(text).toContain('node-c');
    expect(text).toContain('node-d');
    expect(text).not.toContain('node-e');
  });

  it('marks a local-mode node as having served only its own routes', () => {
    render(<DnsManualActionNotice nodesDown={[down({ ingressMode: 'local' })]} />);
    expect(screen.getByTestId('dns-stale-addresses').textContent)
      .toContain('served only its own routes');
  });
});
