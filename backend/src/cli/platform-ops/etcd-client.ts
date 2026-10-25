/**
 * A minimal etcd v3 Cluster-API client — MemberList and MemberRemove only, for
 * `insula etcd` (a server join that never finished leaves its node behind as an
 * etcd LEARNER that nothing removes; see scripts/bootstrap.sh fail_join).
 *
 * k3s ships no etcdctl, the distro package is missing on the RHEL family, and
 * k3s's embedded etcd serves no HTTP gateway (415 on every path), so this speaks
 * gRPC itself over node:http2: POST /etcdserverpb.Cluster/<Method> with a 5-byte
 * length-prefixed protobuf body, grpc-status in the trailers. The handful of
 * fields it needs are encoded by hand below — field numbers from etcd's
 * api/etcdserverpb/rpc.proto, unchanged since v3.0 — so the signed binary gains
 * no protobuf or gRPC dependency.
 */
import { connect } from 'node:http2';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EtcdMember {
  /** etcd's uint64 member ID (etcdctl prints it in hex). */
  readonly id: bigint;
  /** Empty for a member that was added but never started. */
  readonly name: string;
  readonly peerUrls: readonly string[];
  readonly clientUrls: readonly string[];
  readonly isLearner: boolean;
}

export interface EtcdTls {
  readonly ca: Buffer;
  readonly cert: Buffer;
  readonly key: Buffer;
}

// ── protobuf wire format (just what the two calls need) ─────────────────────

function varint(value: bigint): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

/** MemberListRequest { bool linearizable = 1 } — true: the leader's view, not a
 *  possibly stale follower's (etcd < 3.5 ignores the unknown field). */
export function encodeMemberListRequest(): Uint8Array {
  return Uint8Array.of(0x08, 0x01);
}

/** MemberRemoveRequest { uint64 ID = 1 } */
export function encodeMemberRemoveRequest(id: bigint): Uint8Array {
  return Uint8Array.of(0x08, ...varint(id));
}

class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): bigint {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.pos >= this.buf.length) throw new Error('truncated etcd answer (varint)');
      const b = this.buf[this.pos++] ?? 0;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
    }
    throw new Error('malformed etcd answer (varint too long)');
  }

  bytes(): Uint8Array {
    const len = Number(this.varint());
    if (len > this.buf.length - this.pos) throw new Error('truncated etcd answer (field)');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0: this.varint(); return;
      case 1: this.advance(8); return;
      case 2: this.bytes(); return;
      case 5: this.advance(4); return;
      default: throw new Error(`malformed etcd answer (wire type ${wireType})`);
    }
  }

  private advance(n: number): void {
    if (n > this.buf.length - this.pos) throw new Error('truncated etcd answer (fixed)');
    this.pos += n;
  }
}

const utf8 = new TextDecoder();

/** Member { uint64 ID = 1; string name = 2; repeated string peerURLs = 3;
 *           repeated string clientURLs = 4; bool isLearner = 5 } */
function decodeMember(buf: Uint8Array): EtcdMember {
  const r = new Reader(buf);
  let id = 0n;
  let name = '';
  const peerUrls: string[] = [];
  const clientUrls: string[] = [];
  let isLearner = false;
  while (!r.done) {
    const tag = Number(r.varint());
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 0) id = r.varint();
    else if (field === 2 && wire === 2) name = utf8.decode(r.bytes());
    else if (field === 3 && wire === 2) peerUrls.push(utf8.decode(r.bytes()));
    else if (field === 4 && wire === 2) clientUrls.push(utf8.decode(r.bytes()));
    else if (field === 5 && wire === 0) isLearner = r.varint() !== 0n;
    else r.skip(wire);
  }
  return { id, name, peerUrls, clientUrls, isLearner };
}

/** MemberListResponse / MemberRemoveResponse { ResponseHeader header = 1;
 *  repeated Member members = 2 } — both carry the member list. */
export function decodeMembers(buf: Uint8Array): EtcdMember[] {
  const r = new Reader(buf);
  const members: EtcdMember[] = [];
  while (!r.done) {
    const tag = Number(r.varint());
    if (tag >>> 3 === 2 && (tag & 7) === 2) members.push(decodeMember(r.bytes()));
    else r.skip(tag & 7);
  }
  return members;
}

// ── gRPC over HTTP/2 ────────────────────────────────────────────────────────

function frame(message: Uint8Array): Buffer {
  const out = Buffer.alloc(5 + message.length);
  out.writeUInt8(0, 0); // not compressed
  out.writeUInt32BE(message.length, 1);
  out.set(message, 5);
  return out;
}

function unframe(body: Buffer): Uint8Array {
  if (body.length < 5) throw new Error('etcd sent no answer message');
  if (body.readUInt8(0) !== 0) throw new Error('etcd sent a compressed answer, which this client does not read');
  const len = body.readUInt32BE(1);
  if (body.length < 5 + len) throw new Error('truncated etcd answer');
  return body.subarray(5, 5 + len);
}

function grpcText(raw: unknown): string {
  const s = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A refused connection or a rejected certificate reaches the stream as
 *  "The pending stream has been canceled" with the real reason as its cause. */
function streamError(endpoint: string, e: Error): Error {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ERR_HTTP2_STREAM_CANCEL' && e.cause instanceof Error) {
    return new Error(`${endpoint}: ${e.cause.message}`);
  }
  return e;
}

/**
 * One unary call to etcd's Cluster service. `tls` null only for a cleartext
 * endpoint (tests); k3s's etcd always requires its client certificate.
 */
export function grpcUnary(
  endpoint: string,
  method: 'MemberList' | 'MemberRemove',
  message: Uint8Array,
  tls: EtcdTls | null,
  timeoutMs = 10_000,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const session = connect(endpoint, tls ? { ca: tls.ca, cert: tls.cert, key: tls.key } : {});
    let settled = false;
    const finish = (err: Error | null, value?: Uint8Array): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.destroy();
      if (err) reject(err);
      else resolve(value ?? new Uint8Array());
    };
    const timer = setTimeout(
      () => finish(new Error(`${endpoint} did not answer within ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );
    // Usually the stream reports this first (streamError); either way the operator learns which endpoint.
    session.on('error', (e: Error) => finish(new Error(`${endpoint}: ${e.message}`)));
    // A GOAWAY or a reset ends the stream without 'end': fail now, not at the timeout.
    session.on('close', () => finish(new Error(`${endpoint} closed the connection without an answer`)));

    let req: ReturnType<typeof session.request>;
    try {
      req = session.request({
        ':method': 'POST',
        ':path': `/etcdserverpb.Cluster/${method}`,
        'content-type': 'application/grpc',
        te: 'trailers',
      });
    } catch (e) {
      finish(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const chunks: Buffer[] = [];
    let status = 0;
    let grpcStatus: string | undefined;
    let grpcMessage = '';
    const takeStatus = (h: Record<string, unknown>): void => {
      if (h['grpc-status'] === undefined) return;
      grpcStatus = String(h['grpc-status']);
      grpcMessage = grpcText(h['grpc-message']);
    };
    req.on('response', (h) => {
      status = Number(h[':status']);
      takeStatus(h);
    });
    req.on('trailers', (h) => takeStatus(h));
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', (e: Error) => finish(streamError(endpoint, e)));
    req.on('close', () => finish(new Error(`${endpoint} closed the request without an answer`)));
    req.on('end', () => {
      if (status !== 200) {
        finish(new Error(`${endpoint} answered HTTP ${status || 'nothing'}: not an etcd gRPC endpoint`));
        return;
      }
      if (grpcStatus !== '0') {
        finish(new Error(`${grpcMessage || 'etcd refused the request'} (gRPC status ${grpcStatus ?? 'missing'})`));
        return;
      }
      try {
        finish(null, unframe(Buffer.concat(chunks)));
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });
    req.end(frame(message));
  });
}

/** k3s's etcd client credentials, as every server holds them. */
export function readEtcdTls(dir: string): EtcdTls {
  return {
    ca: readFileSync(join(dir, 'server-ca.crt')),
    cert: readFileSync(join(dir, 'server-client.crt')),
    key: readFileSync(join(dir, 'server-client.key')),
  };
}

export async function listMembers(endpoint: string, tls: EtcdTls | null): Promise<EtcdMember[]> {
  return decodeMembers(await grpcUnary(endpoint, 'MemberList', encodeMemberListRequest(), tls));
}

/** Remove one member; resolves to the members etcd lists afterwards. */
export async function removeMember(endpoint: string, tls: EtcdTls | null, id: bigint): Promise<EtcdMember[]> {
  return decodeMembers(await grpcUnary(endpoint, 'MemberRemove', encodeMemberRemoveRequest(id), tls));
}
