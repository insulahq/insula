/**
 * Guard: platform health must notice a dead node.
 *
 * Regression test for the 2026-09-11 node-outage drill, where
 * `/admin/status` reported `kubernetes: ok` — and the dashboard rendered
 * "Platform: Healthy — 4 / 4 services healthy" — with a control-plane node
 * NotReady, eight volumes stranded and mail completely down. The old check
 * counted nodes and never read the Ready condition.
 */
import { describe, it, expect } from 'vitest';
import { checkKubernetes, notReadyNodeNames } from './service.js';

type Cond = { type?: string; status?: string };
const node = (name: string, conditions: Cond[]) => ({
  metadata: { name },
  status: { conditions },
});
const ready = (name: string) => node(name, [{ type: 'Ready', status: 'True' }]);
/** What a node whose kubelet stopped posting actually looks like. */
const unknown = (name: string) => node(name, [{ type: 'Ready', status: 'Unknown' }]);
const notReady = (name: string) => node(name, [{ type: 'Ready', status: 'False' }]);

const fakeCore = (items: unknown[]) =>
  ({ listNode: async () => ({ items }) } as unknown as Parameters<typeof checkKubernetes>[0]);

describe('notReadyNodeNames', () => {
  it('returns nothing when every node is Ready', () => {
    expect(notReadyNodeNames([ready('a'), ready('b')])).toEqual([]);
  });

  it('catches Ready=Unknown — the state a dead node is actually in', () => {
    expect(notReadyNodeNames([ready('a'), unknown('b')])).toEqual(['b']);
  });

  it('catches Ready=False', () => {
    expect(notReadyNodeNames([ready('a'), notReady('b')])).toEqual(['b']);
  });

  it('treats a node with no Ready condition as not ready rather than passing it', () => {
    expect(notReadyNodeNames([node('a', [{ type: 'MemoryPressure', status: 'False' }])]))
      .toEqual(['a']);
  });
});

describe('checkKubernetes', () => {
  it('reports ok when all nodes are Ready', async () => {
    const res = await checkKubernetes(fakeCore([ready('a'), ready('b'), ready('c')]));
    expect(res.status).toBe('ok');
    expect(res.message).toContain('3 node(s)');
  });

  it('reports degraded and NAMES the dead node — the drill scenario', async () => {
    const res = await checkKubernetes(
      fakeCore([ready('node-a'), ready('node-b'), unknown('node-c'), ready('node-d')]),
    );
    expect(res.status).toBe('degraded');
    // The operator has to be able to tell WHICH node from the banner alone.
    expect(res.message).toContain('node-c');
    expect(res.message).toContain('3/4');
  });

  it('still reports error when the API itself is unreachable', async () => {
    const broken = {
      listNode: async () => { throw new Error('connection refused'); },
    } as unknown as Parameters<typeof checkKubernetes>[0];
    const res = await checkKubernetes(broken);
    expect(res.status).toBe('error');
    expect(res.message).toContain('connection refused');
  });

  it('reports degraded when no kubeconfig is configured', async () => {
    const res = await checkKubernetes(undefined);
    expect(res.status).toBe('degraded');
  });
});
