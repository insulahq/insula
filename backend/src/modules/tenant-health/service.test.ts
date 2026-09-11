/**
 * The tenant degradation matrix from the 2026-09-11 node-outage drill.
 *
 * Each case here is one row of docs/architecture/NODE_OUTAGE_RESILIENCE.md §2.2.
 * They are unit tests because reproducing them live means killing nodes.
 */
import { describe, it, expect } from 'vitest';
import {
  computeOutageImpact, findingsForTenant,
  type OutageInput, type TenantFact, type NodeFact,
} from './service.js';

const OBSERVED = new Date('2026-09-11T15:00:00Z');

// Real nodes carry an ingress mode and public addresses; the fixture does too,
// so that a down node's "DNS still points here" surface is exercised rather
// than silently defaulting to empty.
const node = (name: string, ready: boolean, over: Partial<NodeFact> = {}): NodeFact => ({
  name,
  ready,
  role: 'server',
  notReadySince: ready ? null : '2026-09-11T14:55:00Z',
  ingressMode: 'all',
  ingressAddresses: [`198.51.100.${name.charCodeAt(name.length - 1) % 250}`, `2001:db8::${name.slice(-1)}`],
  ...over,
});

const localTenant = (over: Partial<TenantFact> = {}): TenantFact => ({
  id: 't1', name: 'Acme', namespace: 'tenant-acme', storageTier: 'local',
  pinnedNode: 'node-c', status: 'active', hasMailboxes: true, ...over,
});

const baseInput = (over: Partial<OutageInput> = {}): OutageInput => ({
  nodes: [node('node-a', true), node('node-b', true), node('node-c', false)],
  pods: [],
  replicas: [],
  volumes: [],
  tenants: [],
  mailActiveNode: 'node-a',
  observedAt: OBSERVED,
  ...over,
});

describe('degradation matrix', () => {
  it('local tenant pinned to the dead node is DOWN', () => {
    const t = localTenant({ pinnedNode: 'node-c' });
    const out = computeOutageImpact(baseInput({ tenants: [t] }));
    expect(out.affectedTenants).toHaveLength(1);
    expect(out.affectedTenants[0].state).toBe('down');
    expect(out.affectedTenants[0].hostingAffected).toBe(true);
    expect(out.affectedTenants[0].findings[0].kind).toBe('workloads_pinned_to_down_node');
    // The operator needs the node name in the copy, not just a code.
    expect(out.affectedTenants[0].findings[0].detail).toContain('node-c');
  });

  it('local tenant pinned elsewhere is unaffected and omitted entirely', () => {
    const t = localTenant({ pinnedNode: 'node-a' });
    const out = computeOutageImpact(baseInput({ tenants: [t] }));
    expect(out.affectedTenants).toEqual([]);
    expect(out.affectedTenantCount).toBe(0);
  });

  it('HA tenant with a surviving replica is DEGRADED, not down', () => {
    const t = localTenant({ storageTier: 'ha', pinnedNode: null });
    const out = computeOutageImpact(baseInput({
      tenants: [t],
      volumes: [{ volumeName: 'pvc-1', namespace: 'tenant-acme', pvcName: 'data', robustness: 'degraded' }],
      replicas: [
        { volumeName: 'pvc-1', nodeId: 'node-a' },
        { volumeName: 'pvc-1', nodeId: 'node-c' },
      ],
    }));
    expect(out.affectedTenants[0].state).toBe('degraded');
    expect(out.affectedTenants[0].findings.map((f) => f.kind))
      .toContain('volume_degraded_rebuilding');
  });

  it('a volume whose every replica is on downed nodes is DOWN and names the PVC', () => {
    const t = localTenant({ pinnedNode: null });
    const out = computeOutageImpact(baseInput({
      tenants: [t],
      volumes: [{ volumeName: 'pvc-1', namespace: 'tenant-acme', pvcName: 'acme-storage', robustness: 'faulted' }],
      replicas: [{ volumeName: 'pvc-1', nodeId: 'node-c' }],
    }));
    const f = out.affectedTenants[0].findings.find((x) => x.kind === 'volume_last_replica_on_down_node');
    expect(f?.severity).toBe('down');
    expect(f?.resources).toEqual(['acme-storage']);
    expect(f?.nodes).toEqual(['node-c']);
  });

  it('mail loss hits tenants on ANY tier, independently of hosting', () => {
    const t = localTenant({ pinnedNode: 'node-a' }); // hosting is fine
    const out = computeOutageImpact(baseInput({
      tenants: [t],
      mailActiveNode: 'node-c', // the dead node
    }));
    const e = out.affectedTenants[0];
    expect(e.state).toBe('down');
    expect(e.mailAffected).toBe(true);
    expect(e.hostingAffected).toBe(false); // partial degradation, mail half only
    expect(out.mailAffected).toBe(true);
  });

  it('pinned to the dead node AND mail on it = fully degraded (both axes)', () => {
    const t = localTenant({ pinnedNode: 'node-c' });
    const out = computeOutageImpact(baseInput({ tenants: [t], mailActiveNode: 'node-c' }));
    const e = out.affectedTenants[0];
    expect(e.hostingAffected).toBe(true);
    expect(e.mailAffected).toBe(true);
    expect(e.state).toBe('down');
  });

  it('a tenant with no mailboxes is not reported as mail-affected', () => {
    const t = localTenant({ pinnedNode: 'node-a', hasMailboxes: false });
    const out = computeOutageImpact(baseInput({ tenants: [t], mailActiveNode: 'node-c' }));
    expect(out.affectedTenants).toEqual([]);
  });

  it('suspended tenants are not flagged for having no running pods', () => {
    const t = localTenant({ pinnedNode: 'node-a', status: 'suspended', hasMailboxes: false });
    const out = computeOutageImpact(baseInput({
      tenants: [t],
      pods: [{ namespace: 'tenant-acme', name: 'web-1', nodeName: 'node-a', ready: false, phase: 'Pending' }],
    }));
    expect(out.affectedTenants).toEqual([]);
  });

  it('does not double-report pods that the pin finding already explains', () => {
    const t = localTenant({ pinnedNode: 'node-c', hasMailboxes: false });
    const out = computeOutageImpact(baseInput({
      tenants: [t],
      pods: [{ namespace: 'tenant-acme', name: 'web-1', nodeName: 'node-c', ready: false, phase: 'Running' }],
    }));
    const kinds = out.affectedTenants[0].findings.map((f) => f.kind);
    expect(kinds).toEqual(['workloads_pinned_to_down_node']);
  });
});

describe('fleet view', () => {
  it('reports no outage when every node is Ready', () => {
    const out = computeOutageImpact(baseInput({
      nodes: [node('node-a', true), node('node-b', true)],
      tenants: [localTenant({ pinnedNode: 'node-a' })],
    }));
    expect(out.nodesDown).toEqual([]);
    expect(out.affectedTenantCount).toBe(0);
    expect(out.mailAffected).toBe(false);
  });

  it('flags the dead node and marks it when it is the mail node', () => {
    const out = computeOutageImpact(baseInput({ mailActiveNode: 'node-c' }));
    expect(out.nodesDown).toHaveLength(1);
    expect(out.nodesDown[0].name).toBe('node-c');
    expect(out.nodesDown[0].isMailActiveNode).toBe(true);
    expect(out.nodesDown[0].notReadySince).toBe('2026-09-11T14:55:00Z');
  });

  it('counts down and degraded tenants separately for the banner pill', () => {
    const out = computeOutageImpact(baseInput({
      tenants: [
        localTenant({ id: 'a', name: 'Down Co', pinnedNode: 'node-c', hasMailboxes: false }),
        localTenant({ id: 'b', name: 'Deg Co', storageTier: 'ha', pinnedNode: null, hasMailboxes: false }),
      ],
      volumes: [{ volumeName: 'pvc-2', namespace: 'tenant-acme', pvcName: 'd', robustness: 'degraded' }],
      replicas: [
        { volumeName: 'pvc-2', nodeId: 'node-a' },
        { volumeName: 'pvc-2', nodeId: 'node-c' },
      ],
    }));
    expect(out.affectedTenantCount).toBe(2);
    expect(out.downTenantCount).toBe(1);
    expect(out.degradedTenantCount).toBe(1);
    // Down sorts before degraded so the worst case is at the top of the modal.
    expect(out.affectedTenants[0].state).toBe('down');
  });

  it('a failed cluster read reports unknown, never green', () => {
    const out = computeOutageImpact(baseInput({
      tenants: [localTenant({ pinnedNode: 'node-a' })],
      readError: 'Kubernetes API unreachable',
    }));
    expect(out.readError).toBe('Kubernetes API unreachable');
    expect(out.affectedTenants[0].state).toBe('unknown');
    // Crucially NOT an empty list — an empty result would render as "all fine".
    expect(out.affectedTenantCount).toBe(1);
  });
});

/**
 * Dead DNS records are an accepted state (operator decision, 2026-09-11: the
 * platform does not own DNS). Accepted, but not invisible — the outage payload
 * has to carry enough for the UI to name the manual action, because the drill
 * found this stated only in a tooltip on a page the operator had no reason to
 * open while firefighting.
 */
describe('down-node ingress reachability', () => {
  it('reports the addresses that DNS still points at', () => {
    const out = computeOutageImpact(baseInput({
      nodes: [
        node('node-a', true),
        node('node-c', false, { ingressAddresses: ['198.51.100.7', '2001:db8::7'] }),
      ],
    }));
    expect(out.nodesDown).toHaveLength(1);
    expect(out.nodesDown[0].ingressMode).toBe('all');
    expect(out.nodesDown[0].ingressAddresses).toEqual(['198.51.100.7', '2001:db8::7']);
  });

  it('lists NO addresses for an ingress:none node — those records were never published', () => {
    // Sending the operator to withdraw records that do not exist is worse than
    // saying nothing: it burns the one thing they have during an outage, time.
    const out = computeOutageImpact(baseInput({
      nodes: [
        node('node-a', true),
        node('node-c', false, { ingressMode: 'none', ingressAddresses: ['198.51.100.7'] }),
      ],
    }));
    expect(out.nodesDown[0].ingressMode).toBe('none');
    expect(out.nodesDown[0].ingressAddresses).toEqual([]);
  });

  it('keeps addresses for an ingress:local node — it still served its own routes', () => {
    const out = computeOutageImpact(baseInput({
      nodes: [
        node('node-a', true),
        node('node-c', false, { ingressMode: 'local', ingressAddresses: ['198.51.100.9'] }),
      ],
    }));
    expect(out.nodesDown[0].ingressAddresses).toEqual(['198.51.100.9']);
  });
});
