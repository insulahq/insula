// Chunked-upload correctness for /write-raw — run via `node --test`.
//
// Parallel chunks are pwritten at explicit offsets into a file opened
// O_CREAT|O_WRONLY, which never SHORTENS the file. Re-uploading a smaller file
// over a larger one of the same name therefore used to leave the previous
// file's tail attached: 5 MB of new data followed by 5 MB of the old file. A
// zip stores its central directory at the END, so the reader finds the OLD
// directory and the "replaced" archive silently reads as the previous one.
//
// The `?total=` parameter carries the final length so the sidecar can set the
// file's size exactly. It rides on EVERY chunk (not just offset=0) because
// parallel chunks have no ordering guarantee, and it can only ever discard
// bytes beyond the final length — never in-flight chunk data.
//
// These tests exercise the real HTTP router, not the handler in isolation, so
// query parsing and the auth gate are covered too.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const BASE = mkdtempSync(join(tmpdir(), 'fm-chunk-'));
process.env.FM_BASE = BASE;
process.env.FM_NO_LISTEN = '1';
delete process.env.PLATFORM_INTERNAL_SECRET; // auth gate off for this suite

const { server } = await import('./server.mjs');

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
after(() => { server.close(); rmSync(BASE, { recursive: true, force: true }); });

const CHUNK = 1024 * 1024;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function putChunk(dest, body, offset, total) {
  const qs = new URLSearchParams({ path: dest, offset: String(offset) });
  if (total !== undefined) qs.set('total', String(total));
  const res = await fetch(`http://127.0.0.1:${port}/write-raw?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  return res.status;
}

/** Upload `buf` as CHUNK-sized slices, all in flight at once. */
async function uploadParallel(dest, buf, { withTotal = true } = {}) {
  const n = Math.ceil(buf.length / CHUNK);
  const codes = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      putChunk(dest, buf.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, buf.length)),
        i * CHUNK, withTotal ? buf.length : undefined)),
  );
  return codes;
}

const big = Buffer.alloc(5 * CHUNK);
const small = Buffer.alloc(2 * CHUNK);
for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
for (let i = 0; i < small.length; i++) small[i] = (i * 13 + 3) & 0xff;

test('parallel chunks reassemble into a byte-exact file', async () => {
  const codes = await uploadParallel('/a.bin', big);
  assert.deepEqual([...new Set(codes)], [200], `chunk statuses: ${codes}`);
  const onDisk = readFileSync(join(BASE, 'a.bin'));
  assert.equal(onDisk.length, big.length);
  assert.equal(sha(onDisk), sha(big), 'reassembled content must match the source');
});

test('overwriting with a SMALLER file leaves no stale tail', async () => {
  await uploadParallel('/b.bin', big);
  assert.equal(statSync(join(BASE, 'b.bin')).size, big.length);

  await uploadParallel('/b.bin', small);
  const onDisk = readFileSync(join(BASE, 'b.bin'));
  assert.equal(onDisk.length, small.length,
    'file must shrink to the new upload — a longer file means the old tail survived');
  assert.equal(sha(onDisk), sha(small));
});

test('a pre-existing longer file is truncated to the new total', async () => {
  writeFileSync(join(BASE, 'c.bin'), Buffer.alloc(9 * CHUNK, 0xee));
  await uploadParallel('/c.bin', small);
  const onDisk = readFileSync(join(BASE, 'c.bin'));
  assert.equal(onDisk.length, small.length);
  assert.equal(sha(onDisk), sha(small));
});

test('without ?total= the old behaviour is preserved (no truncation)', async () => {
  // Back-compat: an older panel that does not send `total` must still write its
  // chunks correctly. It cannot shrink the file — that is exactly what `total`
  // was added to fix — so this asserts the write path, not the length.
  await uploadParallel('/d.bin', big, { withTotal: false });
  const onDisk = readFileSync(join(BASE, 'd.bin'));
  assert.equal(onDisk.length, big.length);
  assert.equal(sha(onDisk), sha(big));
});

test('a malformed ?total= is ignored rather than corrupting the file', async () => {
  const qs = new URLSearchParams({ path: '/e.bin', offset: '0', total: 'not-a-number' });
  const res = await fetch(`http://127.0.0.1:${port}/write-raw?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: small,
  });
  assert.equal(res.status, 200);
  assert.equal(sha(readFileSync(join(BASE, 'e.bin'))), sha(small));
});
