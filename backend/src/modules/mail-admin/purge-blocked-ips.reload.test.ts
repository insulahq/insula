/**
 * The cluster-internal ban purge must make the RUNNING server let those
 * addresses back in. Destroying a BlockedIp row only edits the store: Stalwart
 * keeps enforcing its in-memory ban list until it re-reads it (measured on a VM
 * cluster: destroyed row, address still refused, until ReloadBlockedIps). So a
 * destroy is followed by ReloadBlockedIps in the same request.
 */
import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';

const requests: Array<{ methodCalls: Array<[string, Record<string, unknown>, string]> }> = [];

vi.mock('@kubernetes/client-node', () => {
  class KubeConfig { loadFromCluster() {} loadFromFile() {} makeApiClient() { return core; } }
  const core = {
    listNamespacedPod: async () => ({ items: [{ metadata: { name: 'stalwart-0' }, status: { phase: 'Running', containerStatuses: [{ name: 'stalwart', ready: true }] } }] }),
    readNamespacedSecret: async () => ({ data: { adminPassword: Buffer.from('pw').toString('base64') } }),
    listNode: async () => ({ items: [] }),
  };
  class Exec {
    async exec(_ns: string, _pod: string, _c: string, _args: string[], stdout: Writable, _stderr: Writable,
      stdin: NodeJS.ReadableStream, _tty: boolean, done: (s: { status: string }) => void) {
      let body = '';
      for await (const chunk of stdin) body += chunk.toString();
      const req = JSON.parse(body) as { methodCalls: Array<[string, Record<string, unknown>, string]> };
      requests.push(req);
      const responses = req.methodCalls.map(([method, args, id]) => {
        if (method === 'x:BlockedIp/get') return [method, { list: [{ id: 'b1', address: '10.42.3.4' }, { id: 'b2', address: '203.0.113.9' }] }, id];
        if (method === 'x:BlockedIp/set') return [method, { destroyed: args.destroy }, id];
        if (method === 'x:Action/set') return [method, { created: { reload: { id: 'r' } } }, id];
        return [method, {}, id];
      });
      stdout.write(JSON.stringify({ methodResponses: responses }));
      done({ status: 'Success' });
    }
  }
  return { KubeConfig, Exec, CoreV1Api: class {} };
});

const { purgeClusterInternalBlockedIps } = await import('./purge-blocked-ips.js');

describe('purgeClusterInternalBlockedIps', () => {
  it('destroys only cluster-internal bans, then reloads the running ban list', async () => {
    const r = await purgeClusterInternalBlockedIps({ kubeconfigPath: undefined, podCidrV4: '10.42.0.0/16', nodeIps: ['192.0.2.10'] });
    expect(r).toMatchObject({ purgedCount: 1, ran: true });
    const destroyReq = requests.find((q) => q.methodCalls.some(([m]) => m === 'x:BlockedIp/set'))!;
    expect(destroyReq.methodCalls.map(([m]) => m)).toEqual(['x:BlockedIp/set', 'x:Action/set']);
    expect(destroyReq.methodCalls[0][1]).toMatchObject({ destroy: ['b1'] });
    expect(destroyReq.methodCalls[1][1]).toMatchObject({ create: { reload: { '@type': 'ReloadBlockedIps' } } });
  });
});
