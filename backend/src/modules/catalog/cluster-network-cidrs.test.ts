import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogFetchPolicy, clusterNetworkCidrs, resetClusterNetworkCidrs } from './service.js';

afterEach(() => resetClusterNetworkCidrs());

describe('clusterNetworkCidrs — the networks no repository fetch may reach', () => {
  it('adds the cluster\'s own networks, both families, to the defaults', async () => {
    const cidrs = await clusterNetworkCidrs(async () => ['10.52.0.0/16', '10.53.0.0/16', 'fd99:42::/56', 'fd99:43::/112', undefined]);
    expect(cidrs).toEqual(expect.arrayContaining(['10.52.0.0/16', '10.53.0.0/16', 'fd99:42::/56', 'fd99:43::/112']));
    // The defaults stay, IPv6 included (production is dual-stack).
    expect(cidrs).toEqual(expect.arrayContaining(['10.42.0.0/16', '10.43.0.0/16', 'fd42:42::/56', 'fd42:43::/112']));
    expect(new Set(cidrs).size).toBe(cidrs.length);
  });

  it('falls back to the defaults when the cluster cannot be read', async () => {
    const cidrs = await clusterNetworkCidrs(async () => { throw new Error('not in a cluster'); });
    expect(cidrs).toEqual(['10.42.0.0/16', '10.43.0.0/16', 'fd42:42::/56', 'fd42:43::/112']);
  });

  it('reads the cluster at most once a minute', async () => {
    const read = vi.fn(async () => ['10.52.0.0/16']);
    await clusterNetworkCidrs(read, 1_000_000);
    await clusterNetworkCidrs(read, 1_000_000 + 59_000);
    expect(read).toHaveBeenCalledTimes(1);
    await clusterNetworkCidrs(read, 1_000_000 + 61_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('is what a fetch is refused when private addresses are allowed', async () => {
    await clusterNetworkCidrs(async () => ['fd99:42::/56'], Date.now());
    const chain = { from: () => chain, where: async () => [{ value: 'true' }] };
    const policy = await catalogFetchPolicy({ select: () => chain } as never);
    expect(policy.allowPrivate).toBe(true);
    expect(policy.deniedCidrs).toEqual(expect.arrayContaining(['fd99:42::/56', 'fd42:42::/56']));
  });
});
