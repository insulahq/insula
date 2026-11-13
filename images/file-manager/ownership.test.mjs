// What the file manager creates belongs to www-data (33:33) — run via
// `node --test`, AS ROOT (CI runs this file under sudo; without root it skips,
// because only root can give a file away).
//
// THE BUG: uploads and archive extraction left root-owned files in a tenant's
// web root, which a PHP app running as www-data then could not write.
//   - extraction set no owner at all: unzip as root writes root's files, and
//     GNU tar as root restores whatever uid the archive recorded (1000, 501…)
//   - an upload chowned its file, but `mkdir -p` made the folders of an
//     uploaded folder as root
//   - copies (fs.cp), new archives and git clones were root's too
//
// THE FIX (server.mjs, "Ownership of what the file manager creates"): folders
// this process makes are chowned as they are made, and the external tools run
// as www-data, keeping DAC_OVERRIDE and FOWNER, so the kernel makes whatever
// they create www-data's. Folders that already existed keep their owner, and
// modes stay what they were when root did the work.
//
// Every case below drives the real HTTP router and the real tools, and reads
// the owner back from the filesystem.

import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, chownSync, lstatSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
// FM_OWNERSHIP_REQUIRED (the CI root step): never skip, so a lost sudo fails loudly.
const REQUIRED = process.env.FM_OWNERSHIP_REQUIRED === '1';
const skip = IS_ROOT || REQUIRED ? false : 'needs root: only root can give files to www-data';

const BASE = mkdtempSync(join(tmpdir(), 'fm-owner-'));
chmodSync(BASE, 0o755);
process.env.FM_BASE = BASE;
process.env.FM_NO_LISTEN = '1';
delete process.env.PLATFORM_INTERNAL_SECRET; // auth gate off for this suite

const { server } = await import('./server.mjs');
const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
after(() => { server.close(); rmSync(BASE, { recursive: true, force: true }); });

test('runs as root when it is required to', { skip: REQUIRED ? false : 'not required here' }, () => {
  assert.ok(IS_ROOT, 'FM_OWNERSHIP_REQUIRED is set but this is not root: every check below would mean nothing');
});

const WWW = '33:33';
const owner = (rel) => { const s = lstatSync(join(BASE, rel)); return `${s.uid}:${s.gid}`; };
const mode = (rel) => (lstatSync(join(BASE, rel)).mode & 0o7777).toString(8);

async function post(path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  return { status: res.status, text, error: events.find((e) => e?.type === 'error') ?? null };
}

async function upload(dest, body, query = {}) {
  const qs = new URLSearchParams({ path: dest, ...query });
  const res = await fetch(`http://127.0.0.1:${port}/write-raw?${qs}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
  });
  return res.status;
}

// A source tree as an archive from another machine has it: owned by uid 1000,
// a group-writable folder and file, a setuid file, a symlink, and a file that
// will overwrite a root-owned one.
before(() => {
  if (!IS_ROOT) return;
  const src = join(tmpdir(), `fm-owner-src-${process.pid}`);
  rmSync(src, { recursive: true, force: true });
  mkdirSync(join(src, 'site', 'keep'), { recursive: true });
  mkdirSync(join(src, 'site', 'new', 'deep'), { recursive: true });
  writeFileSync(join(src, 'site', 'new', 'deep', 'index.php'), '<?php echo 1;');
  writeFileSync(join(src, 'site', 'keep', 'config.php'), 'new');
  writeFileSync(join(src, 'site', 'tool'), '#!/bin/sh\n');
  chmodSync(join(src, 'site', 'tool'), 0o4755);
  mkdirSync(join(src, 'site', 'shared'));
  writeFileSync(join(src, 'site', 'shared', 'upload.txt'), 'x');
  chmodSync(join(src, 'site', 'shared'), 0o775);
  chmodSync(join(src, 'site', 'shared', 'upload.txt'), 0o664);
  symlinkSync('new/deep/index.php', join(src, 'site', 'link.php'));
  execFileSync('chown', ['-R', '-h', '1000:1000', src]);
  execFileSync('zip', ['-qry', join(BASE, 'site.zip'), 'site'], { cwd: src });
  execFileSync('tar', ['czf', join(BASE, 'site.tgz'), 'site'], { cwd: src });
  rmSync(src, { recursive: true, force: true });
});

/** A destination where `site/keep` already exists, root's, mode 0700, with a root-owned file the archive replaces. */
function existingTree(dest) {
  mkdirSync(join(BASE, dest, 'site', 'keep'), { recursive: true });
  chmodSync(join(BASE, dest, 'site', 'keep'), 0o700);
  writeFileSync(join(BASE, dest, 'site', 'keep', 'config.php'), 'old');
  writeFileSync(join(BASE, dest, 'site', 'keep', 'local.txt'), 'not in the archive');
}

for (const [label, archive] of [['zip', 'site.zip'], ['tar.gz', 'site.tgz']]) {
  test(`extracting a ${label} creates www-data's files, whatever owner the archive recorded`, { skip }, async () => {
    const dest = `x-${label}`;
    existingTree(dest);
    const res = await post('/extract', { path: `/${archive}`, destPath: `/${dest}` });
    assert.equal(res.status, 200);
    assert.equal(res.error, null, res.text.slice(0, 300));

    for (const rel of ['site/new', 'site/new/deep', 'site/new/deep/index.php', 'site/tool', 'site/link.php']) {
      assert.equal(owner(`${dest}/${rel}`), WWW, `${rel} is not www-data's`);
    }
    assert.equal(owner(`${dest}/site/keep/config.php`), WWW, 'a file the archive replaced must become www-data\'s');
    assert.equal(readFileSync(join(BASE, dest, 'site', 'keep', 'config.php'), 'utf8'), 'new');
    // What existed before is left alone.
    assert.equal(owner(`${dest}/site/keep`), '0:0', 'an existing folder changed owner');
    assert.equal(mode(`${dest}/site/keep`), '700', 'an existing folder changed mode');
    assert.equal(owner(`${dest}/site/keep/local.txt`), '0:0', 'a file the archive does not hold changed owner');
    // Modes are the archive's, as root's extraction left them: a non-root tar
    // applies the umask unless told not to (664 became 644).
    assert.equal(mode(`${dest}/site/shared`), '775', 'a group-writable folder lost its mode');
    assert.equal(mode(`${dest}/site/shared/upload.txt`), '664', 'a group-writable file lost its mode');
    // Whatever happens to a setuid bit, the file is never root's.
    assert.equal(owner(`${dest}/site/tool`), WWW);
  });
}

test('extracting into a new folder gives that folder and its parents to www-data', { skip }, async () => {
  const res = await post('/extract', { path: '/site.zip', destPath: '/new-a/new-b' });
  assert.equal(res.error, null, res.text.slice(0, 300));
  assert.equal(owner('new-a'), WWW);
  assert.equal(owner('new-a/new-b'), WWW);
  assert.equal(owner('new-a/new-b/site'), WWW);
});

test('an upload into new folders gives the file and every folder made for it to www-data', { skip }, async () => {
  mkdirSync(join(BASE, 'uploads-root'));
  assert.equal(await upload('/uploads-root/theme/css/style.css', 'body{}'), 200);
  assert.equal(owner('uploads-root/theme'), WWW);
  assert.equal(owner('uploads-root/theme/css'), WWW);
  assert.equal(owner('uploads-root/theme/css/style.css'), WWW);
  assert.equal(owner('uploads-root'), '0:0', 'the existing folder the upload went into changed owner');
});

test('a chunked upload is www-data\'s too', { skip }, async () => {
  const body = Buffer.alloc(4096, 7);
  assert.equal(await upload('/chunked/dir/big.bin', body, { offset: '0', total: String(body.length) }), 200);
  assert.equal(owner('chunked'), WWW);
  assert.equal(owner('chunked/dir'), WWW);
  assert.equal(owner('chunked/dir/big.bin'), WWW);
});

test('New folder gives every folder it creates to www-data', { skip }, async () => {
  const res = await post('/mkdir', { path: '/m1/m2/m3' });
  assert.equal(res.status, 201);
  for (const rel of ['m1', 'm1/m2', 'm1/m2/m3']) assert.equal(owner(rel), WWW, `${rel} is not www-data's`);
});

test('a copy is www-data\'s, and merging into an existing folder leaves that folder alone', { skip }, async () => {
  mkdirSync(join(BASE, 'cp-src', 'sub'), { recursive: true });
  writeFileSync(join(BASE, 'cp-src', 'sub', 'a.txt'), 'a');
  writeFileSync(join(BASE, 'cp-src', 'top.txt'), 'top');
  chownSync(join(BASE, 'cp-src', 'top.txt'), 1000, 1000);
  chmodSync(join(BASE, 'cp-src', 'sub'), 0o775);
  chmodSync(join(BASE, 'cp-src', 'sub', 'a.txt'), 0o664);

  assert.equal((await post('/copy', { sourcePath: '/cp-src', destPath: '/cp-new/copy' })).status, 200);
  for (const rel of ['cp-new', 'cp-new/copy', 'cp-new/copy/sub', 'cp-new/copy/sub/a.txt', 'cp-new/copy/top.txt']) {
    assert.equal(owner(rel), WWW, `${rel} is not www-data's`);
  }
  // A copy keeps its source's mode, as fs.cp did.
  assert.equal(mode('cp-new/copy/sub'), '775', 'a copied folder lost its mode');
  assert.equal(mode('cp-new/copy/sub/a.txt'), '664', 'a copied file lost its mode');

  mkdirSync(join(BASE, 'cp-merge', 'sub'), { recursive: true });
  writeFileSync(join(BASE, 'cp-merge', 'sub', 'mine.txt'), 'mine');
  assert.equal((await post('/copy', { sourcePath: '/cp-src', destPath: '/cp-merge' })).status, 200);
  assert.equal(owner('cp-merge'), '0:0', 'the folder merged into changed owner');
  assert.equal(owner('cp-merge/sub'), '0:0');
  assert.equal(owner('cp-merge/sub/mine.txt'), '0:0', 'a file the copy did not write changed owner');
  assert.equal(owner('cp-merge/sub/a.txt'), WWW);
  assert.equal(owner('cp-merge/top.txt'), WWW);

  assert.equal((await post('/copy', { sourcePath: '/cp-src/top.txt', destPath: '/cp-file.txt' })).status, 200);
  assert.equal(owner('cp-file.txt'), WWW);
  assert.equal(readFileSync(join(BASE, 'cp-file.txt'), 'utf8'), 'top');

  assert.equal((await post('/copy', { sourcePath: '/cp-src', destPath: '/cp-src/inside' })).status, 400,
    'copying a folder into itself must be refused');
});

test('a new archive is www-data\'s', { skip }, async () => {
  for (const format of ['zip', 'tar.gz']) {
    const destPath = `/archives/out.${format}`;
    const res = await post('/archive', { paths: ['/cp-src'], destPath, format });
    assert.equal(res.error, null, res.text.slice(0, 300));
    assert.equal(owner('archives'), WWW);
    assert.equal(owner(destPath.slice(1)), WWW, `${format} archive is not www-data's`);
  }
});

test('copying a named pipe is refused instead of hanging', { skip }, async () => {
  execFileSync('mkfifo', [join(BASE, 'a-pipe')]);
  const res = await Promise.race([
    post('/copy', { sourcePath: '/a-pipe', destPath: '/a-pipe-copy' }),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'timed out' }), 10_000)),
  ]);
  assert.equal(res.status, 400, `expected a refusal, got ${res.status}`);
});
