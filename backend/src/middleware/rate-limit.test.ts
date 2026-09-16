import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { registerRateLimit } from './rate-limit.js';
import { errorHandler } from './error-handler.js';

describe('rate limiting', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    await registerRateLimit(app);

    app.get('/test', async () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should allow requests under the limit', async () => {
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.statusCode).toBe(200);
  });

  it('should include rate limit headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/test' });
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('should return 429 when limit exceeded', async () => {
    // Use a tight limit app.
    //
    // `setErrorHandler` is not optional here even though this test is about
    // the limiter: @fastify/rate-limit THROWS its error-response object, so
    // the platform error handler is what turns it into the body a client
    // reads. Without it this test asserted a shape that only Fastify's
    // default handler ever produced — and passed for a year while real
    // clients were receiving `BAD_REQUEST`. See rate-limit-envelope.test.ts.
    const tightApp = Fastify();
    await tightApp.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    await registerRateLimit(tightApp, { max: 2, timeWindow: '1 minute' });
    tightApp.get('/limited', async () => ({ ok: true }));
    tightApp.setErrorHandler(errorHandler);
    await tightApp.ready();

    await tightApp.inject({ method: 'GET', url: '/limited' });
    await tightApp.inject({ method: 'GET', url: '/limited' });
    const res = await tightApp.inject({ method: 'GET', url: '/limited' });

    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');

    await tightApp.close();
  });
});
