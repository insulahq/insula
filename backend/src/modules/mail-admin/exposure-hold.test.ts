import { describe, expect, it } from 'vitest';
import { withoutHeldEndpoints } from './exposure-hold.js';

const until = new Date('2026-10-13T11:29:13Z');
const endpoint = (node: string, error: string | null) => ({ node, exposure: 'haproxy' as const, ready: error === null, ports: [], error });
const exposureFailure = (nodes: ReturnType<typeof endpoint>[], error = 'endpoints failing') => ({
  key: 'exposure',
  component: { status: 'fail', healthy: false, nodes, error },
  items: [],
});

describe('withoutHeldEndpoints', () => {
  it('holds an endpoint on a joining node too — the same window the node\'s own alerts are held in', () => {
    const { alert, held } = withoutHeldEndpoints(
      [exposureFailure([endpoint('node-new', 'no stalwart-haproxy pod runs here')])],
      new Map([['node-new', { until, reason: 'new-node' as const }]]),
    );
    expect(alert).toEqual([]);
    expect(held.map(([node, v]) => [node, v.reason])).toEqual([['node-new', 'new-node']]);
  });

  it('never holds an exposure failure that is not about an endpoint — the endpoint set could not be read', () => {
    const failure = exposureFailure([], 'Could not determine the mail endpoints: timeout');
    const { alert, held } = withoutHeldEndpoints([failure], new Map([['node-b', { until, reason: 'node-down' as const }]]));
    expect(alert).toEqual([failure]);
    expect(held).toEqual([]);
  });

  it('leaves every other component alone, whatever node is held', () => {
    const pod = { key: 'pod', component: { healthy: false, error: 'no Running pod', nodes: [endpoint('node-b', 'x')] }, items: [] };
    const { alert } = withoutHeldEndpoints([pod], new Map([['node-b', { until, reason: 'node-down' as const }]]));
    expect(alert).toEqual([pod]);
  });
});
