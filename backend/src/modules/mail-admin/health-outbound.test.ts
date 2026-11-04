import { describe, it, expect } from 'vitest';
import { mailHealthOutboundComponentSchema, type OutboundMailProbe } from '@insula/api-contracts';
import { evaluateOutbound, outboundItems, probeOutbound, type MailOutboundInput } from './health-outbound.js';
import { componentDetail, componentImpact, componentProbes, componentsToAlert } from './health-scheduler.js';

const NOW = new Date('2026-11-04T12:00:00Z');

function probe(port25: 'open' | 'blocked' | 'unknown', checkedAt = '2026-11-04T11:55:00Z'): OutboundMailProbe {
  return {
    checkedAt,
    intervalSeconds: 900,
    ports: [
      { port: 587, status: 'open', target: 'smtp.example.test', latencyMs: 9, detail: null },
      {
        port: 25,
        status: port25,
        target: port25 === 'open' ? 'mx.example.test' : null,
        latencyMs: port25 === 'open' ? 11 : null,
        detail: port25 === 'open' ? null : 'mx.example.test timed out after 5s; mx2.example.test timed out after 5s',
      },
      { port: 465, status: 'open', target: 'smtp.example.test', latencyMs: 8, detail: null },
    ],
  };
}

function input(probes: Record<string, OutboundMailProbe>, placement: Partial<MailOutboundInput['placement']> = {}): MailOutboundInput {
  return {
    placement: { primaryNode: 'sv1', secondaryNode: 'sv3', tertiaryNode: null, activeNode: 'sv1', ...placement },
    probes: new Map(Object.entries(probes)),
    now: NOW,
  };
}

describe('evaluateOutbound', () => {
  it('ok when every mail node can open port 25; lists them in placement order with all ports', () => {
    const c = evaluateOutbound(input({ sv1: probe('open'), sv3: probe('open') }));
    expect(c).toMatchObject({ status: 'ok', healthy: true, error: null, deliveryPort: 25 });
    expect(c.nodes.map((n) => [n.node, n.role, n.active, n.delivery])).toEqual([
      ['sv1', 'primary', true, 'open'],
      ['sv3', 'secondary', false, 'open'],
    ]);
    // Sorted by port, 25 required on a mail node like the submission ports.
    expect(c.nodes[0]?.ports.map((p) => [p.port, p.required])).toEqual([[25, true], [465, true], [587, true]]);
    expect(mailHealthOutboundComponentSchema.safeParse(c).success).toBe(true);
  });

  it('fails when a STANDBY placement node is blocked — before a failover lands there', () => {
    const c = evaluateOutbound(input({ sv1: probe('open'), sv3: probe('blocked') }));
    expect(c.healthy).toBe(false);
    expect(c.status).toBe('fail');
    expect(c.error).toBe('Outbound port 25 is blocked on sv3 (the secondary mail node): mail would stop going out if the mail server moved there.'
      + ' Ask the hosting provider to unblock outbound TCP 25.');
  });

  it('says outbound mail is queued when the node the mail server runs on is blocked', () => {
    const c = evaluateOutbound(input({ sv1: probe('blocked'), sv3: probe('open') }));
    expect(c.error).toMatch(/^Outbound port 25 is blocked on sv1 \(the primary mail node\), where the mail server runs: mail to other servers is queued, not delivered\./);
  });

  it('a node whose probe has not reported, or reported long ago, is unknown and does not fail', () => {
    const c = evaluateOutbound(input({ sv1: probe('open'), sv3: probe('blocked', '2026-11-04T09:00:00Z') }));
    expect(c.healthy).toBe(true);
    expect(c.nodes.find((n) => n.node === 'sv3')).toMatchObject({ stale: true, delivery: 'unknown' });
    const unchecked = evaluateOutbound(input({ sv1: probe('open') }));
    expect(unchecked.nodes.find((n) => n.node === 'sv3')).toMatchObject({ checkedAt: null, delivery: 'unknown', ports: [] });
    expect(unchecked.status).toBe('ok');
  });

  it('not_implemented when no mail node has reported a check (older probes)', () => {
    const c = evaluateOutbound(input({}));
    expect(c).toMatchObject({ status: 'not_implemented', healthy: true });
    expect(c.nodes).toHaveLength(2);
  });

  it('covers the tertiary node, and the active node when placement does not name it', () => {
    const c = evaluateOutbound(input(
      { sv1: probe('open'), sv3: probe('open'), sv4: probe('blocked'), sv9: probe('open') },
      { tertiaryNode: 'sv4', activeNode: 'sv9' },
    ));
    expect(c.nodes.map((n) => [n.node, n.role, n.active])).toEqual([
      ['sv1', 'primary', false], ['sv3', 'secondary', false], ['sv4', 'tertiary', false], ['sv9', 'active', true],
    ]);
    expect(c.healthy).toBe(false);
    expect(c.error).toContain('sv4 (the tertiary mail node)');
  });

  it('a node in two roles is listed once', () => {
    const c = evaluateOutbound(input({ sv1: probe('open') }, { secondaryNode: 'sv1' }));
    expect(c.nodes.map((n) => n.node)).toEqual(['sv1']);
  });
});

describe('probeOutbound', () => {
  it('not_implemented without a reader', async () => {
    expect(await probeOutbound(undefined)).toEqual({ status: 'not_implemented', healthy: true, error: null, deliveryPort: 25, nodes: [] });
  });

  it('fails, naming the cause, when the read fails — "could not tell" is not "fine"', async () => {
    const c = await probeOutbound(async () => { throw new Error('listing the security-probe ConfigMaps failed: forbidden'); });
    expect(c).toMatchObject({ status: 'fail', healthy: false });
    expect(c.error).toBe("Could not read the mail nodes' outbound mail checks: listing the security-probe ConfigMaps failed: forbidden");
  });
});

describe('the alert for a blocked mail node', () => {
  const failing = evaluateOutbound(input({ sv1: probe('blocked'), sv3: probe('blocked') }));

  it('lists each blocked node with what its targets answered', () => {
    expect(outboundItems(failing)).toEqual([
      'sv1 (primary, the mail server runs here): port 25 — mx.example.test timed out after 5s; mx2.example.test timed out after 5s',
      'sv3 (secondary): port 25 — mx.example.test timed out after 5s; mx2.example.test timed out after 5s',
    ]);
    expect(componentProbes('outbound', failing)).toEqual(outboundItems(failing));
    expect(outboundItems(evaluateOutbound(input({ sv1: probe('open') })))).toEqual([]);
  });

  it('is raised for the component, with a sentence that leads into the list', () => {
    expect(componentsToAlert({ outbound: failing }).map(([k]) => k)).toEqual(['outbound']);
    expect(componentDetail('outbound', failing, outboundItems(failing)))
      .toBe(' Outbound port 25 is blocked on 2 mail nodes — ask the hosting provider to unblock it:');
  });

  it('says delivery is affected only when the mail server runs on a blocked node', () => {
    expect(componentImpact('outbound', failing)).toBe('Mail to other mail servers is not delivered until the port is open.');
    const standbyOnly = evaluateOutbound(input({ sv1: probe('open'), sv3: probe('blocked') }));
    expect(componentImpact('outbound', standbyOnly)).toBe('Mail delivery is not affected now; a failover to that node would stop it.');
  });
});
