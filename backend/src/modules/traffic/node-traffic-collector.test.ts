import { afterEach, describe, expect, it } from 'vitest';
import { metricsRegistry } from '../../shared/metrics.js';
import { parseNodeTrafficSnapshot, publishNodeTraffic, readNodeTrafficSnapshots } from './node-traffic-collector.js';

const NOW = Date.parse('2026-01-02T03:04:05Z');

function snapshot(node: string, sampledAt = new Date(NOW - 20_000).toISOString(), extra: object = {}) {
  return JSON.stringify({
    version: 1,
    node,
    sampledAt,
    epoch: 'abc',
    counters: {
      kubeapi: { in: 100, out: 200, inPackets: 1, outPackets: 2 },
      tunnel: { in: 300, out: 400 },
      backup: { in: 5, out: 6, inPackets: 1, outPackets: 1 },
    },
    ...extra,
  });
}

function clients(items: Array<{ data?: Record<string, string> }>) {
  return { core: { listNamespacedConfigMap: async () => ({ items }) } } as never;
}

async function series(name: string): Promise<string[]> {
  const text = await metricsRegistry.getSingleMetricAsString(name);
  return text.split('\n').filter((l) => l.startsWith(name));
}

describe('node traffic collector', () => {
  afterEach(() => publishNodeTraffic([]));

  it('parses the reconciler snapshot and rejects anything else', () => {
    expect(parseNodeTrafficSnapshot(snapshot('n1'))?.node).toBe('n1');
    expect(parseNodeTrafficSnapshot(undefined)).toBeNull();
    expect(parseNodeTrafficSnapshot('{not json')).toBeNull();
    expect(parseNodeTrafficSnapshot(snapshot('n1', undefined, { version: 2 }))).toBeNull();
  });

  it('drops a snapshot nobody has refreshed — a node that left must not keep a flat line', async () => {
    const fresh = snapshot('fresh');
    const stale = snapshot('stale', new Date(NOW - 10 * 60_000).toISOString());
    const out = await readNodeTrafficSnapshots(clients([{ data: { snapshot: fresh } }, { data: { snapshot: stale } }, {}]), NOW);
    expect(out.map((s) => s.node)).toEqual(['fresh']);
  });

  it('exports bytes and packets per node, class and direction', async () => {
    publishNodeTraffic([parseNodeTrafficSnapshot(snapshot('n1'))!]);
    const bytes = await series('platform_node_traffic_bytes');
    expect(bytes).toContain('platform_node_traffic_bytes{node="n1",class="kubeapi",direction="out"} 200');
    expect(bytes).toContain('platform_node_traffic_bytes{node="n1",class="backup",direction="in"} 5');
    const packets = await series('platform_node_traffic_packets');
    expect(packets).toContain('platform_node_traffic_packets{node="n1",class="kubeapi",direction="in"} 1');
    // No packet counts for tunnel in this snapshot → no invented zero.
    expect(packets.some((l) => l.includes('class="tunnel"'))).toBe(false);
  });

  it('replaces, not accumulates — a node gone from the snapshots is gone from /metrics', async () => {
    publishNodeTraffic([parseNodeTrafficSnapshot(snapshot('n1'))!, parseNodeTrafficSnapshot(snapshot('n2'))!]);
    publishNodeTraffic([parseNodeTrafficSnapshot(snapshot('n2'))!]);
    const bytes = await series('platform_node_traffic_bytes');
    expect(bytes.some((l) => l.includes('node="n1"'))).toBe(false);
    expect(bytes.some((l) => l.includes('node="n2"'))).toBe(true);
  });
});
