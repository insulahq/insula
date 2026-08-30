/**
 * Regression guard: EVERY direct-ClusterIP call to the file-manager sidecar
 * must carry the `X-Platform-Internal` auth header.
 *
 * The sidecar rejects any non-/health request without it with
 * `403 {"error":"Forbidden"}`. When that gate landed, only the buffered
 * `proxyDirect` helper was updated — the three STREAMING direct branches kept
 * sending bare headers, so `/files/upload-raw`, `/files/download` and
 * `/files/fetch-url` returned 403 on every in-cluster deployment while
 * `ls`/`write`/`mkdir` (buffered) kept working. The asymmetry is what made it
 * read as a large-file/chunking bug rather than an auth bug.
 *
 * These tests run against a REAL local http server rather than a mocked
 * `node:http`, so they assert the headers that actually reach the wire.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { AddressInfo } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import { createHmac } from 'node:crypto';

import {
  proxyToFileManager,
  proxyToFileManagerStream,
  streamFromFileManager,
  streamToFileManager,
} from './service.js';

const MASTER = 'unit-test-master-secret';
const NAMESPACE = 'tenant-unit-test';
const EXPECTED = createHmac('sha256', MASTER).update(`fm:${NAMESPACE}`).digest('base64url');

let server: Server;
let baseUrl: string;
let received: IncomingHttpHeaders[] = [];

/** Stand-in for the sidecar: records headers, always answers 200 JSON. */
beforeAll(async () => {
  process.env.PLATFORM_INTERNAL_SECRET = MASTER;
  server = createServer((req, res) => {
    received.push(req.headers);
    req.resume(); // drain the body so the client's request can finish
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A ServerResponse-shaped sink for the two functions that pipe upstream. */
function responseSink(): PassThrough & { writeHead: () => void } {
  const sink = new PassThrough() as PassThrough & { writeHead: () => void };
  sink.writeHead = () => { /* headers are not under test here */ };
  return sink;
}

describe('file-manager direct-ClusterIP auth header', () => {
  beforeAll(() => { received = []; });

  it('proxyToFileManager (buffered — /ls, /write, /mkdir) sends the header', async () => {
    received = [];
    await proxyToFileManager(undefined, NAMESPACE, '/ls', { directUrl: baseUrl, query: { path: '/' } });
    expect(received).toHaveLength(1);
    expect(received[0]['x-platform-internal']).toBe(EXPECTED);
  });

  it('streamToFileManager (/files/upload-raw) sends the header', async () => {
    received = [];
    const body = Readable.from([Buffer.from('payload-bytes')]);
    const result = await streamToFileManager(undefined, NAMESPACE, '/write-raw', body, {
      contentType: 'application/octet-stream',
      query: { path: '/x.bin', offset: '0' },
      directUrl: baseUrl,
    });
    expect(result.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]['x-platform-internal']).toBe(EXPECTED);
    // The caller-supplied headers must survive alongside the auth header.
    expect(received[0]['content-type']).toBe('application/octet-stream');
  });

  it('streamFromFileManager (/files/download) sends the header', async () => {
    received = [];
    await streamFromFileManager(undefined, NAMESPACE, '/download', responseSink(), {
      query: { path: '/x.bin' },
      directUrl: baseUrl,
    });
    expect(received).toHaveLength(1);
    expect(received[0]['x-platform-internal']).toBe(EXPECTED);
  });

  it('proxyToFileManagerStream (/files/fetch-url, /files/clone-site) sends the header', async () => {
    received = [];
    await proxyToFileManagerStream(
      undefined,
      NAMESPACE,
      '/fetch-url',
      JSON.stringify({ url: 'https://example.test/a', path: '/a' }),
      responseSink(),
      { directUrl: baseUrl },
    );
    expect(received).toHaveLength(1);
    expect(received[0]['x-platform-internal']).toBe(EXPECTED);
    expect(received[0]['content-type']).toBe('application/json');
  });

  it('derives a DISTINCT secret per namespace (F5 — a tenant cannot reuse another tenant’s)', async () => {
    received = [];
    await proxyToFileManager(undefined, 'tenant-other', '/ls', { directUrl: baseUrl });
    expect(received[0]['x-platform-internal']).not.toBe(EXPECTED);
    expect(received[0]['x-platform-internal']).toBe(
      createHmac('sha256', MASTER).update('fm:tenant-other').digest('base64url'),
    );
  });
});
