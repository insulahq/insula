// Recursive chmod/chown over a large tree — run via `node --test`.
//
// These two carried the same defect as the archive tools and were missed on
// the first pass because the reported bug was about extraction:
//
//   execFile('chmod', ['-R', ...], { timeout: 60_000 })
//
// A fixed 60-second TOTAL timeout and execFile's 1 MiB stdout buffer. Applying
// permissions recursively to a CMS tree of tens of thousands of files can
// exceed 60s on network storage, and the SIGTERM leaves permissions HALF
// APPLIED behind a generic error — the worst outcome, since a partially
// chmod'ed tree looks fine until something 403s.
//
// Reachable from the UI: the "Apply recursively to all contents" checkbox in
// the Permissions and Ownership dialogs.
//
// The fix runs them with -Rv through the streaming runner, so there is no
// total timeout (only an idle one, which the -v output keeps alive) and no
// buffer to overflow. -v also yields an accurate changed-count to report.
//
// HONEST SCOPE OF THIS TEST: it does NOT reproduce the 60-second timeout.
// Verified by reverting to the old execFile call — these tests still pass,
// because 6,000 files on tmpfs finish in well under 60s and `chmod -R` without
// -v emits nothing to overflow a buffer. Reproducing the timeout needs a tree
// large enough and storage slow enough that neither belongs in a unit test.
//
// What it does cover, and what it has already caught:
//   - recursive chmod applies to EVERY file, asserted on the last one (a tool
//     cut off partway leaves a half-applied tree that a status check misses)
//   - the reported `changed` count is real
//   - the failure message describes THIS operation — it said "the archive
//     appears to be damaged" for a chmod until this test failed on it, and
//     then leaked an internal /tmp path when that was first corrected

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = mkdtempSync(join(tmpdir(), 'fm-perms-'));
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
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-JSON */ }
        resolve({ status: res.status, body: text, json });
      } catch (err) { server.close(); reject(err); }
    });
  });
}

// Enough files that the -v output comfortably exceeds the old 1 MiB buffer:
// each line is "mode of '<BASE>/tree/<name>' changed to 0644 (rw-r--r--)".
const NAME_PAD = 'p'.repeat(140);
const FILE_COUNT = 6000;

before(() => {
  const tree = join(BASE, 'tree');
  mkdirSync(tree, { recursive: true });
  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(join(tree, `perm-${String(i).padStart(5, '0')}-${NAME_PAD}.txt`), 'p');
  }
});

test('recursive chmod applies to every file in a large tree', async () => {
  // 0755, not 0640: a mode without the execute bit strips traversal from the
  // DIRECTORY itself, so chmod cannot descend to the remaining files and fails
  // partway with "Permission denied". Real chmod semantics; the first version
  // of this test hit it and looked like a scale failure.
  const res = await request('/chmod', { path: '/tree', mode: '755', recursive: true });

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body.slice(0, 300)}`);
  assert.equal(res.json?.recursive, true);
  // +1 for the directory itself.
  assert.ok(res.json.changed >= FILE_COUNT, `changed=${res.json.changed}, expected >= ${FILE_COUNT}`);

  // The assertion that matters: permissions are actually applied, everywhere.
  // A killed `chmod -R` leaves a partial tree that a status check would miss.
  const first = statSync(join(BASE, 'tree', `perm-00000-${NAME_PAD}.txt`)).mode & 0o777;
  const last  = statSync(join(BASE, 'tree', `perm-0${FILE_COUNT - 1}-${NAME_PAD}.txt`)).mode & 0o777;
  assert.equal(first, 0o755, 'first file not chmod-ed');
  assert.equal(last, 0o755, 'LAST file not chmod-ed — the tool was cut off partway');
});

test('a non-recursive chmod still works and reports one change', async () => {
  writeFileSync(join(BASE, 'single.txt'), 'x');
  const res = await request('/chmod', { path: '/single.txt', mode: '600', recursive: false });
  assert.equal(res.status, 200, res.body);
  assert.equal(res.json.changed, 1);
  assert.equal(statSync(join(BASE, 'single.txt')).mode & 0o777, 0o600);
});

test('an invalid mode is still rejected before any tool runs', async () => {
  const res = await request('/chmod', { path: '/tree', mode: 'rwxrwxrwx', recursive: true });
  assert.equal(res.status, 400);
});

test('chmod on a missing path reports a cause, not a bare failure', async () => {
  const res = await request('/chmod', { path: '/does-not-exist', mode: '644', recursive: true });
  assert.ok(res.status >= 400, `expected a failure status, got ${res.status}`);
  // The point is the MESSAGE: it must describe this operation, not some other
  // one. The shared failure helper previously answered "the archive appears to
  // be damaged" for a chmod.
  assert.doesNotMatch(res.json?.error ?? '', /archive/i,
    `chmod failure mentions archives: ${res.json?.error}`);
});
