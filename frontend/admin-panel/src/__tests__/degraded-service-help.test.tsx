import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { ClusterOutageImpact } from '@insula/api-contracts';
import DegradedServiceHelp from '../components/outage/DegradedServiceHelp';

/**
 * This is the one failure in the outage set with no automatic recovery, and its
 * remediation used to live in an HTML `title` tooltip — hover-only, invisible on
 * touch and to keyboard users, unannounced by screen readers. The platform named
 * the broken thing and effectively never said it would not fix itself.
 *
 * The guidance below is what was actually measured on staging 2026-09-12, not
 * what seemed plausible. Two drafts of it were wrong before the drill:
 *
 *   - "removing the node is not a reliable substitute" — wrong, it does release
 *     the lock, after ~80s
 *   - "delete the node, either works" — technically true and operationally
 *     dangerous: deleting the Node drops its IP from the cluster firewall
 *     allowlist, so the machine can no longer reach the API server to rejoin.
 *     Measured: `worker → staging1:6443 BLOCKED`, agent stuck on
 *     "Failed to validate connection to cluster", recovered only by re-enrolling
 *     the peer.
 */
const services: ClusterOutageImpact['degradedServices'] = [
  { namespace: 'cnpg-system', name: 'barman-cloud', label: 'Backups (barman-cloud plugin)' },
];

const node = (name: string) => ({
  name, role: 'server', notReadySince: null,
  isMailActiveNode: false, ingressMode: 'all', ingressAddresses: [],
});

describe('DegradedServiceHelp', () => {
  it('renders nothing when no service is degraded', () => {
    render(<DegradedServiceHelp services={[]} nodesDown={[node('n1')]} />);
    expect(screen.queryByTestId('node-outage-services-pill')).toBeNull();
  });

  it('is a real button, not a hover-only tooltip', () => {
    render(<DegradedServiceHelp services={services} nodesDown={[node('worker')]} />);
    const pill = screen.getByTestId('node-outage-services-pill');
    expect(pill.tagName).toBe('BUTTON');
    // The old implementation hid everything in title="…", reachable only by hover.
    expect(pill.getAttribute('title')).toBeNull();
    expect(pill.textContent).toContain('what to do');
  });

  it('states plainly that it will not self-heal', () => {
    render(<DegradedServiceHelp services={services} nodesDown={[node('worker')]} />);
    fireEvent.click(screen.getByTestId('node-outage-services-pill'));
    expect(screen.getByTestId('degraded-service-no-self-heal').textContent)
      .toContain('will not recover on its own');
  });

  it('orders the steps: recover the node, then power off, then delete', () => {
    render(<DegradedServiceHelp services={services} nodesDown={[node('worker')]} />);
    fireEvent.click(screen.getByTestId('node-outage-services-pill'));
    const steps = [...screen.getByTestId('degraded-service-steps').querySelectorAll('li')]
      .map((li) => li.textContent ?? '');
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain('bring the node back first');
    expect(steps[1]).toContain('power it off');
    expect(steps[2]).toContain('decommissioning');
  });

  it('warns that deleting a node you want back strands it', () => {
    // The measured consequence, and the reason this warning exists at all.
    render(<DegradedServiceHelp services={services} nodesDown={[node('worker')]} />);
    fireEvent.click(screen.getByTestId('node-outage-services-pill'));
    const warn = screen.getByTestId('degraded-service-delete-warning').textContent ?? '';
    expect(warn).toContain('Do not remove the node just to clear this');
    expect(warn).toContain('strands');
  });

  it('names the offline node so the operator knows where to go', () => {
    render(<DegradedServiceHelp services={services} nodesDown={[node('worker')]} />);
    fireEvent.click(screen.getByTestId('node-outage-services-pill'));
    expect(screen.getByTestId('degraded-service-help').textContent).toContain('worker');
  });

  it('says tenants are unaffected', () => {
    render(<DegradedServiceHelp services={services} nodesDown={[node('worker')]} />);
    fireEvent.click(screen.getByTestId('node-outage-services-pill'));
    expect(screen.getByTestId('degraded-service-help').textContent)
      .toContain('Tenants are not affected');
  });

  it('opens and closes', () => {
    render(<DegradedServiceHelp services={services} nodesDown={[node('worker')]} />);
    expect(screen.queryByTestId('degraded-service-help')).toBeNull();
    fireEvent.click(screen.getByTestId('node-outage-services-pill'));
    expect(screen.getByTestId('degraded-service-help')).toBeTruthy();
    fireEvent.click(screen.getByTestId('degraded-service-help-close'));
    expect(screen.queryByTestId('degraded-service-help')).toBeNull();
  });
});
