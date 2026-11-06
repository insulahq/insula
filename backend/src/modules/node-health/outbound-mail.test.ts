import { describe, it, expect, vi } from 'vitest';
import type { OutboundMailProbe } from '@insula/api-contracts';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  blockedPortImpact,
  blockedRequiredPorts,
  isOutboundMailStale,
  judgeOutboundMail,
  mailNodeNames,
  parseOutboundMailProbe,
  probeFromStored,
  readOutboundMailProbes,
  requiredOutboundPorts,
  storedRequiresDelivery,
} from './outbound-mail.js';

const NOW = new Date('2026-11-04T12:00:00Z');

function probe(statuses: Record<number, 'open' | 'blocked' | 'unknown'>, checkedAt = '2026-11-04T11:55:00Z'): OutboundMailProbe {
  return {
    checkedAt,
    intervalSeconds: 900,
    ports: Object.entries(statuses).map(([port, status]) => ({
      port: Number(port),
      status,
      target: status === 'open' ? 'smtp.example.test' : null,
      latencyMs: status === 'open' ? 12 : null,
      detail: status === 'open' ? null : 'smtp.example.test timed out after 5s',
    })),
  };
}

describe('parseOutboundMailProbe', () => {
  it('reads what the probe publishes (outboundmail.go OutboundMailWire)', () => {
    // Verbatim shape of the Go marshaller: nil pointers are null, never absent.
    const raw = '{"checkedAt":"2026-11-04T11:55:00Z","intervalSeconds":900,"ports":['
      + '{"port":25,"status":"blocked","target":null,"latencyMs":null,"detail":"a timed out after 5s"},'
      + '{"port":587,"status":"open","target":"smtp.example.test","latencyMs":14,"detail":null}]}';
    expect(parseOutboundMailProbe(raw)).toEqual({
      checkedAt: '2026-11-04T11:55:00Z',
      intervalSeconds: 900,
      ports: [
        { port: 25, status: 'blocked', target: null, latencyMs: null, detail: 'a timed out after 5s' },
        { port: 587, status: 'open', target: 'smtp.example.test', latencyMs: 14, detail: null },
      ],
    });
  });

  it('is null for an absent key (an older probe, or no check yet) and for garbage', () => {
    expect(parseOutboundMailProbe(undefined)).toBeNull();
    expect(parseOutboundMailProbe('')).toBeNull();
    expect(parseOutboundMailProbe('{not json')).toBeNull();
    expect(parseOutboundMailProbe('{"checkedAt":"x","intervalSeconds":900,"ports":[]}')).toBeNull();
    expect(parseOutboundMailProbe('{"checkedAt":"2026-11-04T11:55:00Z","intervalSeconds":900,"ports":[{"port":25,"status":"closed"}]}')).toBeNull();
  });
});

describe('readOutboundMailProbes', () => {
  const cm = (name: string, data: Record<string, string>, node?: string) => ({
    metadata: { name, labels: node ? { app: 'security-probe', 'security-probe.platform/node': node } : { app: 'security-probe' } },
    data,
  });
  const k8s = (items: unknown[] | Error) => ({
    core: {
      listNamespacedConfigMap: vi.fn(async (args: { namespace: string; labelSelector: string }) => {
        expect(args).toEqual({ namespace: 'platform-system', labelSelector: 'app=security-probe' });
        if (items instanceof Error) throw items;
        return { items };
      }),
    },
  }) as unknown as Pick<K8sClients, 'core'>;

  it('keys each result by the node the probe labels it with, and skips ConfigMaps without one', async () => {
    const good = JSON.stringify(probe({ 25: 'open' }));
    const got = await readOutboundMailProbes(k8s([
      cm('security-probe-sv1', { outboundMail: good }, 'sv1'),
      cm('security-probe-sv2.example.test', { outboundMail: good }),
      cm('security-probe-sv3', { snapshot: '{}' }, 'sv3'),
      cm('security-probe-sv4', { outboundMail: '{broken' }, 'sv4'),
      cm('something-else', { outboundMail: good }, 'sv5'),
    ]));
    expect([...got.keys()]).toEqual(['sv1', 'sv2.example.test']);
  });

  it('reports a listing failure and returns nothing (nodes are then unchecked, never judged)', async () => {
    const onError = vi.fn();
    const got = await readOutboundMailProbes(k8s(new Error('forbidden')), onError);
    expect(got.size).toBe(0);
    expect(onError).toHaveBeenCalledWith('forbidden');
  });
});

describe('judging', () => {
  it('requires 465/587 on every node and 25 only on a mail node', () => {
    expect([...requiredOutboundPorts(false)]).toEqual([465, 587]);
    expect([...requiredOutboundPorts(true)].sort()).toEqual([25, 465, 587]);
  });

  it('a worker with port 25 blocked is fine; the same block on a mail node is not', () => {
    const p = probe({ 25: 'blocked', 465: 'open', 587: 'open' });
    const worker = judgeOutboundMail(p, { required: requiredOutboundPorts(false), now: NOW });
    expect(worker?.ports.map((x) => [x.port, x.required])).toEqual([[25, false], [465, true], [587, true]]);
    expect(blockedRequiredPorts(worker)).toEqual([]);
    const mail = judgeOutboundMail(p, { required: requiredOutboundPorts(true), now: NOW });
    expect(blockedRequiredPorts(mail)).toEqual([25]);
  });

  it('a blocked submission port counts on any node', () => {
    const judged = judgeOutboundMail(probe({ 465: 'blocked', 587: 'blocked', 25: 'open' }), { required: requiredOutboundPorts(false), now: NOW });
    expect(blockedRequiredPorts(judged)).toEqual([465, 587]);
  });

  it('unknown (no target resolved) is never a block', () => {
    const judged = judgeOutboundMail(probe({ 465: 'unknown', 587: 'unknown' }), { required: requiredOutboundPorts(true), now: NOW });
    expect(blockedRequiredPorts(judged)).toEqual([]);
  });

  it('a result older than three intervals is stale: shown, not judged', () => {
    // 900 s interval → stale after 45 min.
    expect(isOutboundMailStale(probe({}, '2026-11-04T11:15:01Z'), NOW)).toBe(false);
    expect(isOutboundMailStale(probe({}, '2026-11-04T11:14:59Z'), NOW)).toBe(true);
    const judged = judgeOutboundMail(probe({ 587: 'blocked' }, '2026-11-04T09:00:00Z'), { required: requiredOutboundPorts(false), now: NOW });
    expect(judged?.stale).toBe(true);
    expect(judged?.ports[0]?.status).toBe('blocked');
    expect(blockedRequiredPorts(judged)).toEqual([]);
  });

  it('no probe result is null — unchecked', () => {
    expect(judgeOutboundMail(undefined, { required: requiredOutboundPorts(true), now: NOW })).toBeNull();
    expect(blockedRequiredPorts(null)).toEqual([]);
  });

  it('says what a blocked port breaks', () => {
    expect(blockedPortImpact(25)).toBe('the mail server cannot deliver to other mail servers from this node');
    expect(blockedPortImpact(587)).toBe('apps on this node cannot send mail through a mail server');
  });

  it('mail nodes are the placement nodes, each once — not the stored active node, which can lag the pod', () => {
    expect([...mailNodeNames({ mailPrimaryNode: 'sv1', mailSecondaryNode: 'sv3', mailTertiaryNode: null })]).toEqual(['sv1', 'sv3']);
    expect([...mailNodeNames({ mailPrimaryNode: 'sv1', mailSecondaryNode: 'sv1', mailTertiaryNode: 'sv4' })]).toEqual(['sv1', 'sv4']);
    const withActive = { mailPrimaryNode: 'sv1', mailActiveNode: 'sv9' } as Parameters<typeof mailNodeNames>[0];
    expect([...mailNodeNames(withActive)]).toEqual(['sv1']);
    expect(mailNodeNames(undefined).size).toBe(0);
  });

  it('a stored verdict goes back to the probe shape, and remembers whether port 25 was required', () => {
    const judged = judgeOutboundMail(probe({ 25: 'blocked', 587: 'open' }), { required: requiredOutboundPorts(true), now: NOW });
    expect(probeFromStored(judged)).toEqual(probe({ 25: 'blocked', 587: 'open' }));
    expect(storedRequiresDelivery(judged)).toBe(true);
    const worker = judgeOutboundMail(probe({ 25: 'blocked' }), { required: requiredOutboundPorts(false), now: NOW });
    expect(storedRequiresDelivery(worker)).toBe(false);
    expect(probeFromStored(null)).toBeNull();
    expect(storedRequiresDelivery(undefined)).toBe(false);
  });
});
