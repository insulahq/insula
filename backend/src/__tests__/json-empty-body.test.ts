import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * `Content-Type: application/json` with an EMPTY body must mean `{}`.
 *
 * Fastify's built-in JSON parser rejects that combination with
 * FST_ERR_CTP_EMPTY_JSON_BODY (400). Several endpoints take no body at all
 * (POST …/files/start, …/files/stop, …/refresh-route-dns), and sending the JSON
 * header on a body-less POST is a very common client default — `curl -X POST -H
 * 'Content-Type: application/json'` with no `-d`, or any HTTP library with a
 * default header set.
 *
 * This was found on DEV, not in CI: the identical call returned 200 before a
 * routine dependency bump and 400 after it. Nobody chose the change, it was
 * invisible from both panels (their apiFetch only sets the header when there is
 * a body), and it would have surfaced as external automation breaking after an
 * upgrade with nothing in the release notes.
 *
 * The parser under test is registered in app.ts; it is reproduced here rather
 * than booting the whole app, which needs a database.
 */
function registerTolerantJsonParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (typeof body !== 'string' || body.trim() === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      (err as Error & { statusCode?: number }).statusCode = 400;
      done(err as Error);
    }
  });
}

describe('JSON body parsing', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    registerTolerantJsonParser(app);
    app.post('/echo', async (req) => ({ body: req.body }));
    await app.ready();
  });

  afterAll(async () => { await app.close(); });

  it('accepts an empty body with the JSON content-type and treats it as {}', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual({});
  });

  it('accepts a whitespace-only body too', async () => {
    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '   \n ',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual({});
  });

  it('still parses a real JSON body', async () => {
    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ hello: 'world', n: 1 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toEqual({ hello: 'world', n: 1 });
  });

  it('still REJECTS a malformed body — tolerance is only for emptiness', async () => {
    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
  });

  it('the stock parser rejects an empty body — the behaviour being compensated for', async () => {
    // Pins WHY the custom parser exists. If a future Fastify makes the default
    // tolerant again, this test fails and the override can be reconsidered
    // rather than carried forever as unexplained code.
    const stock = Fastify();
    stock.post('/echo', async (req) => ({ body: req.body }));
    await stock.ready();
    const res = await stock.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FST_ERR_CTP_EMPTY_JSON_BODY');
    await stock.close();
  });
});
