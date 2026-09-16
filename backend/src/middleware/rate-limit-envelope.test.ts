import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { registerRateLimit } from './rate-limit.js';
import { errorHandler } from './error-handler.js';

/**
 * The 429 envelope, as the CLIENT actually receives it.
 *
 * `rate-limit.test.ts` already asserts `error.code === 'RATE_LIMIT_EXCEEDED'`
 * and passes — because its test app never installs `errorHandler`. That is
 * precisely where the bug lived: `@fastify/rate-limit` does
 * `throw params.errorResponseBuilder(...)`, so the builder's return value
 * travels through the platform error handler, and the handler reduced it to
 * `BAD_REQUEST`. A test that skips the error handler tests the half of the
 * path that was never broken.
 *
 * So this file wires the app the way app.ts does — registerRateLimit THEN
 * setErrorHandler — and asserts on the serialised response body.
 */

async function buildApp(max: number) {
  const app = Fastify();
  await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
  await registerRateLimit(app, { max, timeWindow: '1 minute' });
  app.get('/limited', async () => ({ ok: true }));
  // Order matters and mirrors app.ts:419-423.
  app.setErrorHandler(errorHandler);
  await app.ready();
  return app;
}

async function exhaust(app: Awaited<ReturnType<typeof buildApp>>, times: number) {
  for (let i = 0; i < times; i++) {
    await app.inject({ method: 'GET', url: '/limited' });
  }
  return app.inject({ method: 'GET', url: '/limited' });
}

describe('429 envelope through the real error handler', () => {
  it('reports RATE_LIMIT_EXCEEDED, not BAD_REQUEST', async () => {
    const app = await buildApp(2);
    const res = await exhaust(app, 2);

    expect(res.statusCode).toBe(429);
    const body = res.json();
    // The regression: an operator being throttled was told they had sent a
    // bad request, which is both wrong and unactionable.
    expect(body.error.code).not.toBe('BAD_REQUEST');
    expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    await app.close();
  });

  it('carries a human message rather than an empty one', async () => {
    const app = await buildApp(2);
    const res = await exhaust(app, 2);
    const body = res.json();
    // The thrown plain object had no top-level `message`, so the handler
    // emitted `undefined` and the panel rendered a blank error box.
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(body.error.message).toMatch(/too many requests/i);
    await app.close();
  });

  it('tells the caller when to retry', async () => {
    const app = await buildApp(2);
    const res = await exhaust(app, 2);
    const body = res.json();
    // Without this a client cannot back off correctly — it can only guess.
    expect(body.error.details?.retry_after).toBeGreaterThan(0);
    expect(body.error.remediation).toBeTruthy();
    await app.close();
  });

  it('keeps the status at 429 so clients can distinguish throttling', async () => {
    const app = await buildApp(2);
    const res = await exhaust(app, 2);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.status).toBe(429);
    await app.close();
  });

  it('still sets Retry-After and the rate-limit headers', async () => {
    const app = await buildApp(2);
    const res = await exhaust(app, 2);
    // Header and body must agree; a client may use either.
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  it('leaves an under-limit request untouched', async () => {
    const app = await buildApp(5);
    const res = await app.inject({ method: 'GET', url: '/limited' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });
});
