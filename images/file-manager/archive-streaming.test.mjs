// Creating an archive — streamed progress, unbounded size. Run via `node --test`.
//
// `zip -r` prints "  adding: <path>" per file, exactly as chatty as the `unzip`
// that broke extraction of a 14,191-entry archive in production. Archive
// CREATION had the same latent 1 MiB execFile cap and would have failed the
// same way for a large enough folder — it just had not been hit yet.
//
// Creation cannot know a total cheaply (counting would mean walking the tree
// twice), so it reports a running count with total: null. The panel must show
// an indeterminate bar in that case rather than invent a percentage.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = mkdtempSync(join(tmpdir(), 'fm-archive-'));
process.env.FM_BASE = BASE;
process.env.FM_NO_LISTEN = '1';
delete process.env.PLATFORM_INTERNAL_SECRET;

const { server } = await import('./server.mjs');
after(() => rmSync(BASE, { recursive: true, force: true }));

function request(path, body) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        server.close();
        const events = text.split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        resolve({
          status: res.status, body: text, events,
          complete: events.find(e => e.type === 'complete') ?? null,
          error: events.find(e => e.type === 'error') ?? null,
        });
      } catch (err) { server.close(); reject(err); }
    });
  });
}

const NAME_PAD = 'y'.repeat(150);
const FILE_COUNT = 6000;

before(() => {
  const src = join(BASE, 'site');
  mkdirSync(src, { recursive: true });
  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(join(src, `g${String(i).padStart(5, '0')}-${NAME_PAD}.txt`), 'y');
  }
});

test('creates a zip from a folder whose chatter exceeds the old buffer cap', async () => {
  const res = await request('/archive', { paths: ['/site'], destPath: '/site.zip', format: 'zip' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body.slice(0, 300)}`);
  assert.ok(res.complete, `no complete event; got: ${res.body.slice(0, 400)}`);
  assert.ok(existsSync(join(BASE, 'site.zip')), 'archive file was not created');
  assert.ok(res.complete.size > 0, 'archive is empty');
  // FILE_COUNT + 1: zip records the enclosing directory as a member too, so
  // the honest expectation is "every file plus the folder entry".
  assert.equal(res.complete.files, FILE_COUNT + 1, 'not every file was added');
});

test('reports a running count with no fabricated percentage', async () => {
  const res = await request('/archive', { paths: ['/site'], destPath: '/site2.zip', format: 'zip' });
  const prog = res.events.filter(e => e.type === 'progress');

  assert.ok(prog.length > 0, 'no progress events were emitted');
  // total is genuinely unknown here — it must be null, NOT a guess, so the UI
  // knows to render an indeterminate bar.
  assert.equal(prog[0].total, null, 'archive creation must not claim a total it did not compute');
  assert.equal(prog[0].percent, null, 'percent must be null when total is unknown');
  for (let i = 1; i < prog.length; i++) {
    assert.ok(prog[i].done >= prog[i - 1].done, 'progress went backwards');
  }
});

test('a tar.gz archive also streams and completes', async () => {
  const res = await request('/archive', { paths: ['/site'], destPath: '/site.tar.gz', format: 'tar.gz' });
  assert.ok(res.complete, `no complete event; got: ${res.body.slice(0, 400)}`);
  assert.ok(existsSync(join(BASE, 'site.tar.gz')), 'tar.gz was not created');
  assert.equal(res.complete.files, FILE_COUNT + 1, 'tar counts the directory entry too');
});
