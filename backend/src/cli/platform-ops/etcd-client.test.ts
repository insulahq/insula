/**
 * etcd-client: the hand-rolled protobuf against bytes etcd itself would send,
 * and the gRPC transport against a real HTTP/2 server (cleartext — the framing,
 * status and trailer handling are what is under test, not TLS).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Http2Server, type Http2Session, type ServerHttp2Stream } from 'node:http2';
import type { AddressInfo } from 'node:net';
import {
  decodeMembers,
  encodeMemberListRequest,
  encodeMemberRemoveRequest,
  grpcUnary,
  listMembers,
  removeMember,
} from './etcd-client.js';

// ── a tiny protobuf encoder for fixtures (the client only decodes these) ─────
function varint(v: bigint): number[] {
  const out: number[] = [];
  let x = v;
  while (x > 0x7fn) {
    out.push(Number((x & 0x7fn) | 0x80n));
    x >>= 7n;
  }
  out.push(Number(x));
  return out;
}
const field = (n: number, wire: number): number[] => varint(BigInt((n << 3) | wire));
const str = (n: number, s: string): number[] => {
  const b = [...Buffer.from(s, 'utf8')];
  return [...field(n, 2), ...varint(BigInt(b.length)), ...b];
};
const msg = (n: number, body: number[]): number[] => [...field(n, 2), ...varint(BigInt(body.length)), ...body];
interface Fixture { id: bigint; name?: string; peers?: string[]; clients?: string[]; learner?: boolean }
function member(m: Fixture): number[] {
  return [
    ...field(1, 0), ...varint(m.id),
    ...(m.name ? str(2, m.name) : []),
    ...(m.peers ?? []).flatMap((p) => str(3, p)),
    ...(m.clients ?? []).flatMap((c) => str(4, c)),
    ...(m.learner ? [...field(5, 0), 1] : []),
  ];
}
function memberList(ms: Fixture[]): Uint8Array {
  // ResponseHeader { cluster_id = 1, member_id = 2, revision = 3, raft_term = 4 }
  const header = [...field(1, 0), ...varint(0xcdef_0123_4567_89abn), ...field(4, 0), 7];
  return Uint8Array.from([...msg(1, header), ...ms.flatMap((m) => msg(2, member(m)))]);
}
const grpcFrame = (b: Uint8Array): Buffer => Buffer.concat([Buffer.from([0, ...[24, 16, 8, 0].map((s) => (b.length >>> s) & 0xff)]), Buffer.from(b)]);

const SV1: Fixture = { id: 0x8e9e05c52164694dn, name: 'sv1-1a2b3c4d', peers: ['https://10.0.0.1:2380'], clients: ['https://10.0.0.1:2379'] };
const STUCK: Fixture = { id: 0xfffffffffffffffen, peers: ['https://[2001:db8::4]:2380'], learner: true };

describe('protobuf', () => {
  it('encodes the two requests', () => {
    expect([...encodeMemberListRequest()]).toEqual([0x08, 0x01]);
    expect([...encodeMemberRemoveRequest(1n)]).toEqual([0x08, 0x01]);
    expect([...encodeMemberRemoveRequest(300n)]).toEqual([0x08, 0xac, 0x02]);
    // a full 64-bit ID needs 10 varint bytes
    expect(encodeMemberRemoveRequest(0xffffffffffffffffn).length).toBe(11);
  });

  it('decodes members, a 64-bit ID, a member that never started, and skips the header', () => {
    const ms = decodeMembers(memberList([SV1, STUCK]));
    expect(ms).toEqual([
      { id: SV1.id, name: 'sv1-1a2b3c4d', peerUrls: ['https://10.0.0.1:2380'], clientUrls: ['https://10.0.0.1:2379'], isLearner: false },
      { id: STUCK.id, name: '', peerUrls: ['https://[2001:db8::4]:2380'], clientUrls: [], isLearner: true },
    ]);
  });

  it('skips fields it does not know (newer etcd)', () => {
    const extra = [...field(9, 0), 5, ...str(10, 'x'), ...field(11, 5), 1, 2, 3, 4, ...field(12, 1), 1, 2, 3, 4, 5, 6, 7, 8];
    const buf = Uint8Array.from(msg(2, [...member(SV1), ...extra]));
    expect(decodeMembers(buf)[0]?.name).toBe('sv1-1a2b3c4d');
  });

  it('refuses a truncated answer instead of inventing members', () => {
    const full = memberList([SV1]);
    expect(() => decodeMembers(full.subarray(0, full.length - 3))).toThrow(/truncated/);
  });
});

// ── transport ───────────────────────────────────────────────────────────────
let server: Http2Server | null = null;
const sessions = new Set<Http2Session>();
afterEach(async () => {
  const s = server;
  server = null;
  for (const x of sessions) x.destroy();
  sessions.clear();
  if (s) await new Promise<void>((r) => s.close(() => r()));
});

type Handler = (stream: ServerHttp2Stream, path: string, body: Buffer) => void;
async function serve(handler: Handler): Promise<string> {
  server = createServer();
  server.on('session', (x: Http2Session) => sessions.add(x));
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => handler(stream, String(headers[':path']), Buffer.concat(chunks)));
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function answer(stream: ServerHttp2Stream, body: Uint8Array, status = '0', message?: string): void {
  stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
  stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': status, ...(message ? { 'grpc-message': message } : {}) }));
  stream.end(grpcFrame(body));
}

describe('grpcUnary', () => {
  it('lists members over HTTP/2 with gRPC framing and trailers', async () => {
    const seen: string[] = [];
    const url = await serve((stream, path, body) => {
      seen.push(`${path} ${[...body].join(',')}`);
      answer(stream, memberList([SV1, STUCK]));
    });
    const ms = await listMembers(url, null);
    expect(ms.map((m) => m.id)).toEqual([SV1.id, STUCK.id]);
    expect(seen).toEqual(['/etcdserverpb.Cluster/MemberList 0,0,0,0,2,8,1']);
  });

  it('sends the member ID to MemberRemove and returns the members left', async () => {
    const url = await serve((stream, path, body) => {
      expect(path).toBe('/etcdserverpb.Cluster/MemberRemove');
      expect([...body.subarray(5)]).toEqual([...encodeMemberRemoveRequest(STUCK.id)]);
      answer(stream, memberList([SV1]));
    });
    expect((await removeMember(url, null, STUCK.id)).map((m) => m.name)).toEqual(['sv1-1a2b3c4d']);
  });

  it("reports etcd's own refusal (grpc-status in the trailers)", async () => {
    const url = await serve((stream) => answer(stream, new Uint8Array(), '5', 'etcdserver%3A%20member%20not%20found'));
    await expect(removeMember(url, null, 1n)).rejects.toThrow('etcdserver: member not found (gRPC status 5)');
  });

  it('reports a trailers-only error answer', async () => {
    const url = await serve((stream) => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '14', 'grpc-message': 'unavailable' }, { endStream: true });
    });
    await expect(listMembers(url, null)).rejects.toThrow('unavailable (gRPC status 14)');
  });

  it('refuses a non-gRPC answer (an HTTP gateway, a proxy)', async () => {
    const url = await serve((stream) => {
      stream.respond({ ':status': 415 });
      stream.end('unsupported');
    });
    await expect(listMembers(url, null)).rejects.toThrow(/HTTP 415: not an etcd gRPC endpoint/);
  });

  it('times out instead of hanging on a silent endpoint', async () => {
    const url = await serve(() => { /* never answers */ });
    await expect(grpcUnary(url, 'MemberList', encodeMemberListRequest(), null, 300)).rejects.toThrow(/did not answer within/);
  });

  it('reports an endpoint that refuses the connection', async () => {
    const url = await serve(() => undefined);
    const s = server;
    server = null;
    await new Promise<void>((r) => s?.close(() => r()));
    // node wraps the cause in "The pending stream has been canceled"; the operator sees only the cause.
    await expect(listMembers(url, null)).rejects.toThrow(new RegExp(`^${url.replace(/[.[\]]/g, '\\$&')}: connect ECONNREFUSED `));
  });
});
