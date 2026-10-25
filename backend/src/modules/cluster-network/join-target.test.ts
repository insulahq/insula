import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type AddressInfo } from 'node:net';
import {
  defaultJoinTarget,
  probeApiPort,
  requestedJoinTarget,
  serverCandidates,
  type ServerCandidate,
} from './join-target.js';

function node(o: { name: string; ip: string; server?: boolean; ready?: boolean; cordoned?: boolean; ext?: string }) {
  return {
    metadata: {
      name: o.name,
      labels: o.server === false ? {} : { 'node-role.kubernetes.io/control-plane': 'true' },
    },
    spec: o.cordoned ? { unschedulable: true } : {},
    status: {
      addresses: [
        { type: 'InternalIP', address: '2001:db8::1' },
        { type: 'InternalIP', address: o.ip },
        ...(o.ext ? [{ type: 'ExternalIP', address: o.ext }] : []),
      ],
      conditions: [{ type: 'Ready', status: o.ready === false ? 'False' : 'True' }],
    },
  };
}

function cand(name: string, over: Partial<ServerCandidate> = {}): ServerCandidate {
  return { name, ip: `192.0.2.${name.length}`, ready: true, cordoned: false, answering: null, privateUnderlay: false, ...over };
}

describe('serverCandidates', () => {
  it('lists servers by name with their IPv4 InternalIP, never a worker', () => {
    const c = serverCandidates([
      node({ name: 'sv3', ip: '192.0.2.13' }),
      node({ name: 'w1', ip: '192.0.2.40', server: false }),
      node({ name: 'sv1', ip: '192.0.2.11', cordoned: true, ext: '203.0.113.1' }),
    ]);
    expect(c).toEqual([
      { name: 'sv1', ip: '192.0.2.11', ready: true, cordoned: true, answering: null, privateUnderlay: true },
      { name: 'sv3', ip: '192.0.2.13', ready: true, cordoned: false, answering: null, privateUnderlay: false },
    ]);
  });

  it('unlabelled legacy nodes all qualify', () => {
    expect(serverCandidates([node({ name: 'n1', ip: '192.0.2.9', server: false })]).map((c) => c.ip)).toEqual([
      '192.0.2.9',
    ]);
  });
});

describe('defaultJoinTarget', () => {
  it('answering beats unchecked beats silent; uncordoned first within each', () => {
    expect(
      defaultJoinTarget([
        cand('a', { answering: false }),
        cand('bb', { answering: null }),
        cand('ccc', { answering: true, cordoned: true }),
        cand('dddd', { answering: true }),
      ])?.name,
    ).toBe('dddd');
    expect(defaultJoinTarget([cand('a', { answering: false }), cand('bb', { answering: true, cordoned: true })])?.name).toBe(
      'bb',
    );
    expect(defaultJoinTarget([cand('a', { answering: false }), cand('bb', { answering: null })])?.name).toBe('bb');
    expect(defaultJoinTarget([cand('a', { answering: false })])?.name).toBe('a');
  });

  it('never a server that is not Ready', () => {
    expect(defaultJoinTarget([cand('a', { ready: false, answering: true })])).toBeNull();
  });
});

describe('requestedJoinTarget', () => {
  it('returns the picked server, refuses an unknown or NotReady one', () => {
    const list = [cand('a'), cand('bb', { ready: false })];
    expect(requestedJoinTarget(list, list[0]!.ip).name).toBe('a');
    expect(() => requestedJoinTarget(list, '198.51.100.99')).toThrow(expect.objectContaining({ code: 'JOIN_TARGET_UNKNOWN' }));
    expect(() => requestedJoinTarget(list, list[1]!.ip)).toThrow(expect.objectContaining({ code: 'JOIN_TARGET_NOT_READY' }));
  });
});

describe('probeApiPort', () => {
  const servers: Array<Server | NetServer> = [];
  const sockets = new Set<import('node:net').Socket>();
  afterEach(async () => {
    // close() waits for open connections — drop the ones the stub accepted.
    for (const sock of sockets) sock.destroy();
    sockets.clear();
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
  });
  const listen = <S extends Server | NetServer>(s: S): Promise<number> =>
    new Promise((resolve) => {
      servers.push(s);
      s.on('connection', (sock: import('node:net').Socket) => sockets.add(sock));
      s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port));
    });
  const CA = Buffer.from('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');

  it('false when nothing listens', async () => {
    const port = await listen(createNetServer());
    await new Promise((r) => servers.pop()!.close(() => r(undefined)));
    expect(await probeApiPort('127.0.0.1', CA, port, 500)).toBe(false);
  });

  it('false when the port speaks plain HTTP (no TLS signed by the cluster CA)', async () => {
    const port = await listen(createServer((_req, res) => res.end('pong')));
    expect(await probeApiPort('127.0.0.1', CA, port, 500)).toBe(false);
  });

  it('false, within the timeout, when the port accepts but never answers', async () => {
    const port = await listen(createNetServer(() => undefined));
    const t0 = Date.now();
    expect(await probeApiPort('127.0.0.1', CA, port, 300)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
