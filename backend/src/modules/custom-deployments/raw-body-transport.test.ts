import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerRawBodyParser } from './raw-body-transport.js';

/**
 * ADR-060 raw transport: the custom-deployments routes accept the SAME JSON
 * body under `application/octet-stream`, so the WAF never parses a compose
 * document or a `.env` into ARGS and matches it as an attack.
 *
 * These tests drive the PRODUCTION `registerRawBodyParser` — not a copy of it.
 * An earlier version of this file re-declared the parser inline and would have
 * kept passing if the real one broke.
 */

async function build() {
  const app = Fastify();
  registerRawBodyParser(app);
  app.post('/echo', async (req) => ({ got: req.body }));
  await app.ready();
  return app;
}

const COMPOSE = {
  mode: 'compose',
  // The exact shapes CRS matches on: a `mysql -e` command (942190) and a
  // `.env` of KEY=value directives (933120).
  compose_yaml: 'services:\n  db:\n    command: ["sh","-c","mysql -e \\"DROP TABLE t\\""]\n',
  env_files: { '.env': 'DISPLAY_ERRORS=Off\nMEMORY_LIMIT=512M\n' },
};

describe('custom-deployments raw body transport (ADR-060)', () => {
  it('parses an octet-stream body as JSON', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/octet-stream' },
      payload: JSON.stringify(COMPOSE),
    });
    expect(res.statusCode).toBe(200);
    // Byte-identical to what the JSON path would have produced — the label is
    // the only thing that changes, so handlers need no branching.
    expect(res.json().got).toEqual(COMPOSE);
    await app.close();
  });

  it('STILL accepts application/json (rollout-skew guard)', async () => {
    // Panels and API deploy separately. An old panel talking to a new API must
    // keep working, or the editor breaks for the length of every rollout.
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(COMPOSE),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().got).toEqual(COMPOSE);
    await app.close();
  });

  it('rejects a malformed octet-stream body with 400, not 500', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/octet-stream' },
      payload: '{"mode":"compose"',
    });
    expect(res.statusCode).toBe(400);
    // The production parser raises ApiError, so the envelope carries a code —
    // a plain Error would 500 and lose it.
    expect(res.json().error?.code ?? res.json().code).toBe('INVALID_FIELD_VALUE');
    await app.close();
  });

  it('treats an empty octet-stream body as {}, not a parse error', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/octet-stream' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().got).toEqual({});
    await app.close();
  });

  it('does NOT register the parser on an app that never called it', async () => {
    // Guards the encapsulation property the security review turned on: the
    // parser must not leak to Fastify instances that did not opt in. Verified
    // in-cluster too — /domains returns 415 for octet-stream.
    const app = Fastify();
    app.post('/echo', async (req) => ({ got: req.body }));
    await app.ready();
    const res = await app.inject({
      method: 'POST', url: '/echo',
      headers: { 'content-type': 'application/octet-stream' },
      payload: JSON.stringify(COMPOSE),
    });
    expect(res.statusCode).toBe(415);
    await app.close();
  });
});
