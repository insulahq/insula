import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import zlib from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCompress from '@fastify/compress';
import { COMPRESS_OPTIONS } from './compress-options.js';

const BODY = JSON.stringify({ email: 'someone@example.test', password: 'x' });

// @fastify/compress takes its decoder factories from node:zlib when it is
// registered, so spies set up before that see every decoder it creates.
const brotli = vi.spyOn(zlib, 'createBrotliDecompress');
const gunzip = vi.spyOn(zlib, 'createGunzip');
const zstd = typeof zlib.createZstdDecompress === 'function' ? vi.spyOn(zlib, 'createZstdDecompress') : undefined;

describe('COMPRESS_OPTIONS', () => {
  let app: FastifyInstance;
  let handled = 0;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyCompress, COMPRESS_OPTIONS);
    app.post('/echo', async (request) => {
      handled += 1;
      return request.body;
    });
    app.get('/big', async () => ({ text: 'a'.repeat(4096) }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    brotli.mockClear();
    gunzip.mockClear();
    zstd?.mockClear();
  });

  const post = (payload: string | Buffer, encoding?: string) =>
    app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json', ...(encoding ? { 'content-encoding': encoding } : {}) },
      payload,
    });

  it('refuses a Brotli request body with 415 without creating a Brotli decoder', async () => {
    const before = handled;
    const res = await post(zlib.brotliCompressSync(BODY), 'br');
    expect(res.statusCode).toBe(415);
    expect(brotli).not.toHaveBeenCalled();
    expect(handled).toBe(before);
  });

  it.runIf(zstd)('refuses a zstd request body with 415 without creating a zstd decoder', async () => {
    const before = handled;
    const res = await post(zlib.zstdCompressSync(BODY), 'zstd');
    expect(res.statusCode).toBe(415);
    expect(zstd).not.toHaveBeenCalled();
    expect(handled).toBe(before);
  });

  it('still decodes gzip and deflate request bodies', async () => {
    for (const [encoding, payload] of [['gzip', zlib.gzipSync(BODY)], ['deflate', zlib.deflateSync(BODY)]] as const) {
      const res = await post(payload, encoding);
      expect(res.statusCode, encoding).toBe(200);
      expect(res.json(), encoding).toEqual(JSON.parse(BODY));
    }
    // The control for the spies above: the gzip body went through one.
    expect(gunzip).toHaveBeenCalledTimes(1);
  });

  it('accepts an uncompressed body, with or without identity', async () => {
    expect((await post(BODY)).json()).toEqual(JSON.parse(BODY));
    expect((await post(BODY, 'identity')).json()).toEqual(JSON.parse(BODY));
  });

  it('still compresses responses with Brotli', async () => {
    const res = await app.inject({ method: 'GET', url: '/big', headers: { 'accept-encoding': 'br' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('br');
  });
});
