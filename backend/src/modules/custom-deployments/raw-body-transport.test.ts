import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';

/**
 * ADR-060 raw transport: the custom-deployments routes accept the SAME JSON
 * body under `application/octet-stream`, so the WAF never parses a compose
 * document or a `.env` into ARGS and matches it as an attack.
 *
 * These tests exercise the content-type parser in isolation rather than the
 * whole route module, which needs Kubernetes clients. The parser is the part
 * that can silently break: if it stops accepting octet-stream, every submit
 * from the panel 415s; if it stops accepting JSON, the editor breaks for the
 * length of a rollout, since panels and API are separate Deployments.
 */

/** Mirrors the parser registered in routes.ts. */
function registerParser(app: ReturnType<typeof Fastify>): void {
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'string' },
    (_req, body, done) => {
      const raw = typeof body === 'string' ? body : String(body);
      if (raw.trim() === '') { done(null, {}); return; }
      try {
        done(null, JSON.parse(raw) as unknown);
      } catch {
        done(Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 }), undefined);
      }
    },
  );
}

async function build() {
  const app = Fastify();
  registerParser(app);
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
});
