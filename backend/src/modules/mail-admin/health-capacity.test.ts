import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_STANDBY_MAX_AGE_SECONDS,
  capacityItems,
  evaluateStandby,
  evaluateStorage,
  probeCapacity,
  readStandbyMaxAgeSeconds,
  rekeyReports,
  singleFlight,
  type MailCapacityInput,
} from './health-capacity.js';
import type { MailNodeStorage } from './mail-node-storage.js';
import type { NodeStandbyReport } from './standby-reports.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const GiB = 2 ** 30;

function node(name: string, over: Partial<MailNodeStorage> = {}): MailNodeStorage {
  return {
    nodeName: name,
    roles: [],
    isActive: false,
    isStandby: false,
    totalBytes: 100 * GiB,
    freeBytes: 50 * GiB,
    mailUsedBytes: 10 * GiB,
    mailUsedReportedAt: null,
    ...over,
  };
}

function report(name: string, ageSeconds: number): NodeStandbyReport {
  return {
    node: name,
    sizeBytes: 10 * GiB,
    fileCount: 300,
    durationSeconds: 4,
    reportedAt: new Date(Date.now() - ageSeconds * 1000).toISOString(),
    ageSeconds,
  };
}

function input(nodes: MailNodeStorage[], reports: NodeStandbyReport[] = []): MailCapacityInput {
  return { nodes, reports, maxAgeSeconds: 1800 };
}

describe('evaluateStandby — can a failover start from a standby copy?', () => {
  it('has nothing to check without standby nodes', () => {
    const c = evaluateStandby(input([node('a', { isActive: true })]));
    expect(c).toMatchObject({ status: 'not_implemented', healthy: true, nodes: [] });
  });

  it('passes a copy younger than the fast-path limit, and one exactly at it', () => {
    const c = evaluateStandby(input(
      [node('a', { isActive: true }), node('b', { isStandby: true }), node('c', { isStandby: true })],
      [report('b', 60), report('c', 1800)],
    ));
    expect(c).toMatchObject({ status: 'ok', healthy: true, error: null, maxAgeSeconds: 1800 });
    expect(c.nodes.map((n) => [n.node, n.usable])).toEqual([['b', true], ['c', true]]);
  });

  it('fails a copy older than the limit — a long sync holds no complete copy', () => {
    const c = evaluateStandby(input([node('b', { isStandby: true })], [report('b', 1801)]));
    expect(c.status).toBe('fail');
    expect(c.healthy).toBe(false);
    expect(c.error).toMatch(/^1 standby node has no copy a failover could start from/);
    expect(c.error).toContain('younger than 30 min');
    expect(c.nodes[0]).toMatchObject({ node: 'b', ageSeconds: 1801, usable: false });
  });

  it('fails a standby node that never finished a copy', () => {
    const c = evaluateStandby(input([node('b', { isStandby: true }), node('c', { isStandby: true })], [report('c', 10)]));
    expect(c.status).toBe('fail');
    expect(c.nodes.find((n) => n.node === 'b')).toMatchObject({ ageSeconds: null, usable: false });
  });

  it('ignores the active node even when it carries the standby label', () => {
    const c = evaluateStandby(input([node('a', { isActive: true, isStandby: true })]));
    expect(c.status).toBe('not_implemented');
  });

  it('ignores reports from nodes that are no longer standby', () => {
    const c = evaluateStandby(input([node('b', { isStandby: true })], [report('b', 5), report('gone', 99_999)]));
    expect(c.status).toBe('ok');
    expect(c.nodes.map((n) => n.node)).toEqual(['b']);
  });
});

describe('evaluateStorage — room for the mail store to rewrite its files', () => {
  it('passes when every node has at least its mail data free', () => {
    const c = evaluateStorage({ nodes: [
      node('a', { isActive: true, freeBytes: 10 * GiB, mailUsedBytes: 10 * GiB }),
      node('b', { isStandby: true, freeBytes: 30 * GiB, mailUsedBytes: 10 * GiB }),
    ] });
    expect(c).toMatchObject({ status: 'ok', healthy: true, error: null });
    expect(c.nodes.map((n) => [n.node, n.role, n.enough])).toEqual([['a', 'active', true], ['b', 'standby', true]]);
  });

  it('fails a node with less free space than its mail data', () => {
    const c = evaluateStorage({ nodes: [node('a', { isActive: true, freeBytes: 9 * GiB, mailUsedBytes: 10 * GiB })] });
    expect(c.status).toBe('fail');
    expect(c.healthy).toBe(false);
    expect(c.error).toMatch(/^1 mail node has less free space than its mail data/);
  });

  it('does not judge a node whose numbers are unknown — and says so when none can be judged', () => {
    const unknown = evaluateStorage({ nodes: [node('a', { isActive: true, freeBytes: null })] });
    expect(unknown).toMatchObject({ status: 'not_implemented', healthy: true });
    expect(unknown.nodes[0].enough).toBeNull();
    const mixed = evaluateStorage({ nodes: [
      node('a', { isActive: true, mailUsedBytes: null }),
      node('b', { isStandby: true }),
    ] });
    expect(mixed.status).toBe('ok');
  });

  it('judges a standby by what its next sync receives, not only its last finished copy', () => {
    // Mid-rewrite: the standby's last COMPLETE copy predates the growth; the active store is live.
    const c = evaluateStorage({ nodes: [
      node('a', { isActive: true, freeBytes: 100 * GiB, mailUsedBytes: 40 * GiB }),
      node('b', { isStandby: true, freeBytes: 30 * GiB, mailUsedBytes: 25 * GiB }),
      node('c', { isStandby: true, freeBytes: 30 * GiB, mailUsedBytes: null }),
    ] });
    expect(c.nodes.find((n) => n.node === 'b')).toMatchObject({ mailBytes: 40 * GiB, enough: false });
    expect(c.nodes.find((n) => n.node === 'c')).toMatchObject({ mailBytes: 40 * GiB, enough: false });
    expect(c.status).toBe('fail');
  });

  it('keeps a standby\'s own figure when it is the larger one, or when the active size is unknown', () => {
    const c = evaluateStorage({ nodes: [
      node('a', { isActive: true, mailUsedBytes: null }),
      node('b', { isStandby: true, freeBytes: 30 * GiB, mailUsedBytes: 25 * GiB }),
    ] });
    expect(c.nodes.find((n) => n.node === 'b')).toMatchObject({ mailBytes: 25 * GiB, enough: true });
  });

  it('only looks at the active and standby nodes', () => {
    const c = evaluateStorage({ nodes: [node('p', { roles: ['primary'], freeBytes: 0 }), node('a', { isActive: true })] });
    expect(c.nodes.map((n) => n.node)).toEqual(['a']);
    expect(c.status).toBe('ok');
  });
});

describe('capacityItems — one alert line per node', () => {
  it('lists each unusable standby node', () => {
    const c = evaluateStandby(input(
      [node('b', { isStandby: true }), node('c', { isStandby: true }), node('d', { isStandby: true })],
      [report('b', 3000), report('d', 5)],
    ));
    expect(capacityItems('standby', c)).toEqual(['b: last complete copy 50 min old', 'c: has never finished a copy']);
  });

  it('lists each node short of space', () => {
    const c = evaluateStorage({ nodes: [
      node('a', { isActive: true, freeBytes: 4 * GiB, mailUsedBytes: 40 * GiB }),
      node('b', { isStandby: true }),
    ] });
    expect(capacityItems('storage', c)).toEqual(['a: 4.0 GiB free for 40.0 GiB of mail']);
  });

  it('lists nothing for a healthy component or another key', () => {
    expect(capacityItems('storage', evaluateStorage({ nodes: [node('a', { isActive: true })] }))).toEqual([]);
    expect(capacityItems('pod', { healthy: false, nodes: [] })).toEqual([]);
  });
});

describe('probeCapacity', () => {
  afterEach(() => vi.useRealTimers());

  it('reports both components not_implemented without a reader', async () => {
    const c = await probeCapacity(undefined);
    expect(c.standby).toMatchObject({ status: 'not_implemented', healthy: true, maxAgeSeconds: DEFAULT_STANDBY_MAX_AGE_SECONDS });
    expect(c.storage).toMatchObject({ status: 'not_implemented', healthy: true });
  });

  it('fails both with the reason when the read fails — not "nothing to check"', async () => {
    const c = await probeCapacity(async () => { throw new Error('kube-api down'); });
    expect(c.standby).toMatchObject({ status: 'fail', healthy: false, error: 'Could not read mail node capacity: kube-api down' });
    expect(c.storage).toMatchObject({ status: 'fail', healthy: false, error: 'Could not read mail node capacity: kube-api down' });
  });

  it('fails both when the read hangs', async () => {
    vi.useFakeTimers();
    const pending = probeCapacity(() => new Promise<MailCapacityInput>(() => {}));
    await vi.advanceTimersByTimeAsync(20_000);
    const c = await pending;
    expect(c.storage.error).toBe('Could not read mail node capacity: reading mail node capacity timed out');
  });

  it('evaluates what the reader returns', async () => {
    const c = await probeCapacity(async () => input([node('a', { isActive: true }), node('b', { isStandby: true })], [report('b', 10)]));
    expect(c.standby.status).toBe('ok');
    expect(c.storage.status).toBe('ok');
  });
});

describe('readStandbyMaxAgeSeconds — the limit the Deployment really runs with', () => {
  function apps(env: Array<{ name: string; value?: string }> | undefined, initName = 'restore-state'): K8sClients['apps'] {
    return {
      readNamespacedDeployment: vi.fn().mockResolvedValue({
        spec: { template: { spec: { initContainers: [{ name: initName, env }] } } },
      }),
    } as unknown as K8sClients['apps'];
  }

  it('reads FAST_PATH_MAX_AGE_SECONDS from the restore-state init container', async () => {
    await expect(readStandbyMaxAgeSeconds(apps([{ name: 'FAST_PATH_MAX_AGE_SECONDS', value: '3600' }]))).resolves.toBe(3600);
  });

  it('falls back to the default when unset, unparsable or not positive', async () => {
    await expect(readStandbyMaxAgeSeconds(apps(undefined))).resolves.toBe(1800);
    await expect(readStandbyMaxAgeSeconds(apps([{ name: 'FAST_PATH_MAX_AGE_SECONDS', value: 'soon' }]))).resolves.toBe(1800);
    await expect(readStandbyMaxAgeSeconds(apps([{ name: 'FAST_PATH_MAX_AGE_SECONDS', value: '0' }]))).resolves.toBe(1800);
    await expect(readStandbyMaxAgeSeconds(apps([{ name: 'FAST_PATH_MAX_AGE_SECONDS', value: '600' }], 'other'))).resolves.toBe(1800);
  });
});

describe('rekeyReports — reports join the cards on either node name', () => {
  it('maps a Node object name to its hostname label and passes unknown names through', () => {
    const out = rekeyReports([report('n1.example.test', 5), report('n2', 7)], new Map([['n1.example.test', 'n1']]));
    expect(out.map((r) => r.node)).toEqual(['n1', 'n2']);
    expect(evaluateStandby(input([node('n1', { isStandby: true })], out)).status).toBe('ok');
  });
});

describe('singleFlight — one capacity read at a time', () => {
  it('shares an in-flight read and starts a fresh one after it settles', async () => {
    let calls = 0;
    let release: (v: number) => void = () => {};
    const read = singleFlight(() => { calls += 1; return new Promise<number>((r) => { release = r; }); });
    const a = read();
    const b = read();
    expect(calls).toBe(1);
    release(42);
    await expect(Promise.all([a, b])).resolves.toEqual([42, 42]);
    const c = read();
    expect(calls).toBe(2);
    release(7);
    await expect(c).resolves.toBe(7);
  });

  it('starts fresh after a failure too', async () => {
    let calls = 0;
    const read = singleFlight(async () => { calls += 1; throw new Error('boom'); });
    await expect(read()).rejects.toThrow('boom');
    await expect(read()).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });
});
