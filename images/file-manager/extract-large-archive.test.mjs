// Extracting a MANY-ENTRY archive — run via `node --test`.
//
// THE BUG (production, 2026-08-30): a tenant could not extract a 14,191-entry
// zip (Perfex CRM, 56 MB). The archive was valid (`unzip -t` clean), the PVC
// had 4.6 GB free, and the extraction itself takes 5 seconds. The panel said
// only "Failed to extract archive". The sidecar's own log said:
//
//     [handleExtract] stdout maxBuffer length exceeded
//
// `execFile` buffers the child's stdout and KILLS the child past `maxBuffer`,
// which defaults to 1 MiB. `unzip -o` prints one line per member; for that
// archive it emits 1,513,063 bytes — 44% over the cap. So extraction worked
// for every small archive anyone had tested with, and could never work for a
// large one. Nothing about the failure pointed at output buffering.
//
// The fix is `-q` (don't produce the output) plus an explicit 32 MiB
// `maxBuffer` (don't die if some tool produces output anyway).
//
// THIS TEST builds an archive whose non-quiet `unzip` chatter would exceed
// 1 MiB and drives it through the real HTTP router. It fails against the old
// code for the real reason, not a mocked one.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = mkdtempSync(join(tmpdir(), 'fm-extract-'));
process.env.FM_BASE = BASE;
process.env.FM_NO_LISTEN = '1';
delete process.env.PLATFORM_INTERNAL_SECRET; // auth gate off for this suite

const { server } = await import('./server.mjs');

after(() => rmSync(BASE, { recursive: true, force: true }));

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        server.close();
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON body */ }
        resolve({ status: res.status, body: text, json });
      } catch (err) { server.close(); reject(err); }
    });
  });
}

// Long names so a manageable file count still overflows a 1 MiB stdout buffer.
// unzip prints roughly "  inflating: <BASE>/out/<name>\n" per member.
const NAME_PAD = 'x'.repeat(150);
const FILE_COUNT = 6000;
const ARCHIVE_REL = '/big.zip';
let expectedChatterBytes = 0;

before(() => {
  const src = join(BASE, 'src');
  mkdirSync(src, { recursive: true });
  for (let i = 0; i < FILE_COUNT; i++) {
    const name = `f${String(i).padStart(5, '0')}-${NAME_PAD}.txt`;
    writeFileSync(join(src, name), 'x');
    // "  inflating: " + <BASE>/out/ + name + newline, approximately.
    expectedChatterBytes += 14 + BASE.length + 5 + name.length + 1;
  }
  execFileSync('zip', ['-qr', join(BASE, 'big.zip'), '.'], { cwd: src });
});

test('the fixture really would overflow the old 1 MiB default', () => {
  // Guards the test itself: if this assertion ever fails, the fixture stopped
  // reproducing the bug and a pass below would mean nothing.
  assert.ok(
    expectedChatterBytes > 1024 * 1024,
    `fixture only produces ~${expectedChatterBytes} bytes of unzip output; ` +
    'it must exceed the 1 MiB execFile default to exercise the bug',
  );
});

test('extracts a many-entry archive that overflows the default stdout buffer', async () => {
  const res = await request('POST', '/extract', { path: ARCHIVE_REL, destPath: '/out' });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
  assert.equal(res.json?.extracted, true);

  // The real assertion: every member landed. A killed unzip leaves a partial
  // tree, so a status check alone would not catch a regression.
  const out = join(BASE, 'out');
  assert.ok(existsSync(out), 'destination directory was not created');
  assert.equal(
    readdirSync(out).filter(n => n.endsWith('.txt')).length,
    FILE_COUNT,
    'not every archive member was extracted — the child was probably killed partway',
  );
});

test('a damaged archive reports that it is damaged, not a generic failure', async () => {
  writeFileSync(join(BASE, 'broken.zip'), 'PK\x03\x04 this is not really a zip');
  const res = await request('POST', '/extract', { path: '/broken.zip', destPath: '/broken-out' });

  assert.equal(res.status, 500);
  // The generic "Failed to extract archive" is what sent a real investigation
  // to the wrong place; the message must now name a cause.
  assert.match(
    res.json?.error ?? '',
    /damaged or unreadable/,
    `expected a diagnostic message, got: ${res.json?.error}`,
  );
});
