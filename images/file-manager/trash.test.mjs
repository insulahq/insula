// Recycle-bin tests for trash.mjs + its wiring into server.mjs — `node --test`.
//
// Driven through the real HTTP router wherever the behaviour is reachable that
// way, so the auth gate, body parsing and the `permanent` default are covered
// rather than just the module in isolation.
//
// The security cases are the point of this file. The PVC is writable over SFTP,
// so a tenant can hand-author /data/.trash/info/<id>.json — every field read
// back off disk is attacker-controlled input, and `originalPath` in particular
// is a path traversal waiting to happen if a restore trusts it.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync, readdirSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = mkdtempSync(join(tmpdir(), 'fm-trash-'));
const OUTSIDE = mkdtempSync(join(tmpdir(), 'fm-trash-out-'));
process.env.FM_BASE = BASE;
process.env.FM_NO_LISTEN = '1';
delete process.env.PLATFORM_INTERNAL_SECRET; // auth gate off for this suite

const { server, safePath, trash } = await import('./server.mjs');

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
after(() => {
  server.close();
  rmSync(BASE, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

const api = async (path, init) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body };
};
const post = (path, payload) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
const seedFile = (rel, content = 'hello') => {
  const abs = join(BASE, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  return abs;
};
const trashIds = () => {
  const root = join(BASE, '.trash', 'files');
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((shard) => readdirSync(join(root, shard)));
};

// ─── Default behaviour: rm trashes, it does not destroy ──────────────────────

test('rm without a permanent flag moves the file into the trash', async () => {
  seedFile('site/index.php', '<?php echo 1;');
  const { status, body } = await post('/rm', { path: 'site/index.php' });

  assert.equal(status, 200);
  assert.equal(body.trashed, true);
  assert.equal(body.trashEntry.originalPath, 'site/index.php');
  assert.equal(body.trashEntry.type, 'file');
  assert.equal(body.trashEntry.sizeBytes, 13);
  assert.equal(existsSync(join(BASE, 'site/index.php')), false, 'original must be gone');

  const payload = join(BASE, '.trash', 'files', body.trashEntry.id.split('-')[0] && new Date(Number(body.trashEntry.id.split('-')[0])).toISOString().slice(0, 7), body.trashEntry.id);
  assert.equal(readFileSync(payload, 'utf8'), '<?php echo 1;', 'payload content preserved');
});

test('rm with permanent:true destroys and leaves nothing in the trash', async () => {
  seedFile('site/gone.txt');
  const before = trashIds().length;
  const { status, body } = await post('/rm', { path: 'site/gone.txt', permanent: true });

  assert.equal(status, 200);
  assert.equal(body.trashed, false);
  assert.equal(existsSync(join(BASE, 'site/gone.txt')), false);
  assert.equal(trashIds().length, before, 'no new trash entry');
});

test('a directory is trashed whole, in one move', async () => {
  seedFile('app/nested/deep/a.txt', 'A');
  seedFile('app/nested/deep/b.txt', 'B');
  const { status, body } = await post('/rm', { path: 'app/nested' });

  assert.equal(status, 200);
  assert.equal(body.trashEntry.type, 'directory');
  assert.equal(existsSync(join(BASE, 'app/nested')), false);
  const entries = await trash.listTrash();
  const e = entries.find(x => x.id === body.trashEntry.id);
  assert.equal(e.originalPath, 'app/nested');
});

test('the PVC root can never be trashed', async () => {
  for (const p of ['/', '.', '']) {
    const { status } = await post('/rm', { path: p });
    assert.ok(status === 400 || status === 403, `path ${JSON.stringify(p)} must be refused, got ${status}`);
  }
  assert.ok(existsSync(BASE));
});

// ─── The trash is unreachable through ordinary file operations ───────────────

test('safePath refuses every path inside the PVC-root .trash', async () => {
  for (const p of ['.trash', '/.trash', '.trash/files', '.trash/info/x.json', 'site/../.trash/files']) {
    assert.equal(await safePath(p), null, `${p} must be refused`);
  }
});

test('a tenant own nested .trash directory stays reachable', async () => {
  // Root-anchored hiding, not any-segment: hiding wp-content/.trash would make
  // the tenant's own data silently vanish from the browser.
  seedFile('wp-content/.trash/keep.txt', 'mine');
  assert.notEqual(await safePath('wp-content/.trash'), null);
  assert.notEqual(await safePath('wp-content/.trash/keep.txt'), null);

  const { body } = await api('/ls?path=wp-content');
  assert.ok(body.entries.some(e => e.name === '.trash'), 'nested .trash must be listed');
});

test('the root trash is hidden from directory listings', async () => {
  await post('/rm', { path: seedFile('listing-probe.txt') && 'listing-probe.txt' });
  const { body } = await api('/ls?path=/');
  assert.equal(body.entries.some(e => e.name === '.trash'), false, 'root .trash must not be listed');
});

test('rm, rename, copy and write cannot touch the trash internals', async () => {
  seedFile('victim.txt', 'v');
  const { body: trashed } = await post('/rm', { path: 'victim.txt' });
  const id = trashed.trashEntry.id;
  const shard = new Date(Number(id.split('-')[0])).toISOString().slice(0, 7);
  const inside = `.trash/files/${shard}/${id}`;

  assert.equal((await post('/rm', { path: inside })).status, 404);
  assert.equal((await post('/rename', { oldPath: inside, newPath: 'stolen.txt' })).status, 404);
  assert.equal((await post('/copy', { sourcePath: inside, destPath: 'stolen.txt' })).status, 404);
  assert.equal((await post('/write', { path: '.trash/info/evil.json', content: 'x' })).status, 404);

  // …and the entry is still intact afterwards.
  const entries = await trash.listTrash();
  assert.ok(entries.some(e => e.id === id), 'entry survived the attempts');
});

// ─── Restore ─────────────────────────────────────────────────────────────────

test('restore puts the file back and recreates missing parents', async () => {
  seedFile('restore/me/file.txt', 'payload');
  const { body: trashed } = await post('/rm', { path: 'restore/me/file.txt' });
  rmSync(join(BASE, 'restore'), { recursive: true, force: true }); // parents gone too

  const { status, body } = await post('/trash/restore', { id: trashed.trashEntry.id });
  assert.equal(status, 200);
  assert.equal(body.restoredTo, 'restore/me/file.txt');
  assert.equal(readFileSync(join(BASE, 'restore/me/file.txt'), 'utf8'), 'payload');

  const entries = await trash.listTrash();
  assert.equal(entries.some(e => e.id === trashed.trashEntry.id), false, 'entry consumed by the restore');
});

test('restore onto an occupied path reports a conflict instead of overwriting', async () => {
  seedFile('conflict.txt', 'original');
  const { body: trashed } = await post('/rm', { path: 'conflict.txt' });
  seedFile('conflict.txt', 'NEWER');

  const { status, body } = await post('/trash/restore', { id: trashed.trashEntry.id });
  assert.equal(status, 409);
  assert.equal(body.conflictPath, 'conflict.txt');
  assert.equal(readFileSync(join(BASE, 'conflict.txt'), 'utf8'), 'NEWER', 'existing file untouched');
});

test('restore with autoRename lands beside the existing file', async () => {
  seedFile('rn/page.php', 'old');
  const { body: trashed } = await post('/rm', { path: 'rn/page.php' });
  seedFile('rn/page.php', 'current');

  const { status, body } = await post('/trash/restore', { id: trashed.trashEntry.id, autoRename: true });
  assert.equal(status, 200);
  assert.equal(body.restoredTo, 'rn/page (restored).php');
  assert.equal(readFileSync(join(BASE, 'rn/page (restored).php'), 'utf8'), 'old');
  assert.equal(readFileSync(join(BASE, 'rn/page.php'), 'utf8'), 'current');
});

test('restore with overwrite replaces the occupant', async () => {
  seedFile('ow/x.txt', 'from-trash');
  const { body: trashed } = await post('/rm', { path: 'ow/x.txt' });
  seedFile('ow/x.txt', 'occupant');

  const { status } = await post('/trash/restore', { id: trashed.trashEntry.id, overwrite: true });
  assert.equal(status, 200);
  assert.equal(readFileSync(join(BASE, 'ow/x.txt'), 'utf8'), 'from-trash');
});

// ─── Security: the metadata on disk is untrusted input ───────────────────────

test('a forged originalPath cannot escape the PVC on restore', async () => {
  seedFile('forge/target.txt', 'data');
  const { body: trashed } = await post('/rm', { path: 'forge/target.txt' });
  const id = trashed.trashEntry.id;
  const shard = new Date(Number(id.split('-')[0])).toISOString().slice(0, 7);
  const infoFile = join(BASE, '.trash', 'info', shard, `${id}.json`);

  for (const evil of ['../../../../etc/passwd', `${OUTSIDE}/pwned.txt`, '../escapee.txt', '.platform/sendmail']) {
    const info = JSON.parse(readFileSync(infoFile, 'utf8'));
    writeFileSync(infoFile, JSON.stringify({ ...info, originalPath: evil }));

    const { status } = await post('/trash/restore', { id }); // eslint-disable-line no-await-in-loop
    assert.equal(status, 400, `forged path ${evil} must be refused`);
    assert.equal(existsSync(join(OUTSIDE, 'pwned.txt')), false);
  }
  assert.equal(readdirSync(OUTSIDE).length, 0, 'nothing was written outside BASE');
});

test('a symlink payload is moved as a LINK — never followed out of the PVC', async () => {
  // A tenant with SFTP can replace a payload with a link pointing anywhere.
  // Restoring it must move the link itself: rename() does not traverse, so
  // nothing outside the PVC is read, written or deleted, and the restored link
  // is inert because every sidecar operation goes through safePath().
  //
  // Refusing the restore outright would be worse than useless — that is exactly
  // what made such an entry permanently un-purgeable before (see entryPath()).
  writeFileSync(join(OUTSIDE, 'secret.txt'), 'TOP_SECRET');
  seedFile('sym/real.txt', 'real');
  const { body: trashed } = await post('/rm', { path: 'sym/real.txt' });
  const id = trashed.trashEntry.id;
  const shard = new Date(Number(id.split('-')[0])).toISOString().slice(0, 7);

  const payload = join(BASE, '.trash', 'files', shard, id);
  rmSync(payload, { force: true });
  symlinkSync(OUTSIDE, payload);

  const listed = await trash.listTrash();
  assert.equal(listed.find(e => e.id === id).type, 'symlink', 'observed type wins over recorded type');

  const { status } = await post('/trash/restore', { id });
  assert.equal(status, 200);

  const restored = join(BASE, 'sym/real.txt');
  assert.equal(lstatSync(restored).isSymbolicLink(), true, 'the link was moved, not its target');
  assert.deepEqual(readdirSync(OUTSIDE), ['secret.txt'], 'nothing outside BASE was touched');
  // …and the sidecar still refuses to act through it.
  assert.equal(await safePath('sym/real.txt'), null);
  assert.equal(await safePath('sym/real.txt/secret.txt'), null);
  rmSync(restored, { force: true });
});

test('a symlink payload can still be purged, so the bin is always emptyable', async () => {
  seedFile('sym2/x.txt', 'x');
  const { body: trashed } = await post('/rm', { path: 'sym2/x.txt' });
  const id = trashed.trashEntry.id;
  const shard = new Date(Number(id.split('-')[0])).toISOString().slice(0, 7);
  const payload = join(BASE, '.trash', 'files', shard, id);
  rmSync(payload, { force: true });
  symlinkSync(OUTSIDE, payload);

  const { body } = await post('/trash/purge', { all: true });
  assert.ok(body.purged >= 1, 'the symlink entry was purged');
  assert.equal(body.failed.length, 0, `no un-purgeable leftovers: ${JSON.stringify(body.failed)}`);
  assert.equal((await trash.listTrash()).length, 0, 'bin is empty');
  assert.deepEqual(readdirSync(OUTSIDE), ['secret.txt'], 'the link target survived the purge');
});

test('a restore cannot target the trash itself', async () => {
  seedFile('selfref.txt', 'x');
  const { body: trashed } = await post('/rm', { path: 'selfref.txt' });
  const id = trashed.trashEntry.id;
  const shard = new Date(Number(id.split('-')[0])).toISOString().slice(0, 7);
  const infoFile = join(BASE, '.trash', 'info', shard, `${id}.json`);
  const info = JSON.parse(readFileSync(infoFile, 'utf8'));
  writeFileSync(infoFile, JSON.stringify({ ...info, originalPath: '.trash/files/evil' }));

  const { status } = await post('/trash/restore', { id });
  assert.equal(status, 400);
});

test('a traversing trash id is rejected', async () => {
  for (const id of ['../../etc/passwd', 'a/b', '..', '.']) {
    const { status } = await post('/trash/restore', { id }); // eslint-disable-line no-await-in-loop
    assert.equal(status, 404, `id ${id} must not resolve`);
  }
});

// ─── Orphans: the payload tree is the source of truth ────────────────────────

test('a payload whose metadata is missing is still listed and still restorable', async () => {
  seedFile('orphan.txt', 'orphaned-content');
  const { body: trashed } = await post('/rm', { path: 'orphan.txt' });
  const id = trashed.trashEntry.id;
  const shard = new Date(Number(id.split('-')[0])).toISOString().slice(0, 7);
  rmSync(join(BASE, '.trash', 'info', shard, `${id}.json`), { force: true });

  const { body: listed } = await api('/trash/list');
  const entry = listed.entries.find(e => e.id === id);
  assert.ok(entry, 'orphan is listed');
  assert.equal(entry.orphaned, true);
  assert.equal(entry.originalPath, null);
  assert.ok(entry.deletedAt, 'ctime fallback supplies a deletion time');

  const { status, body } = await post('/trash/restore', { id });
  assert.equal(status, 200);
  assert.equal(body.restoredTo, `restored/${id}`);
  assert.equal(readFileSync(join(BASE, 'restored', id), 'utf8'), 'orphaned-content');
});

// ─── Purge ───────────────────────────────────────────────────────────────────

test('purge by age removes only entries past the cutoff', async () => {
  // Everything trashed by this suite is seconds old, so a 1-day cutoff must
  // spare all of it — the guard against an expiry sweep eating live entries.
  seedFile('age/fresh.txt', 'fresh');
  const { body: fresh } = await post('/rm', { path: 'age/fresh.txt' });

  const { status, body } = await post('/trash/purge', { olderThanDays: 1 });
  assert.equal(status, 200);
  assert.equal(body.purged, 0);
  assert.ok(body.examined > 0, 'entries were examined, not skipped');
  assert.ok((await trash.listTrash()).some(e => e.id === fresh.trashEntry.id));

  // A zero-day cutoff expires everything.
  const purgeAll = await post('/trash/purge', { olderThanDays: 0 });
  assert.ok(purgeAll.body.purged > 0);
  assert.equal((await trash.listTrash()).length, 0);
});

test('purge by id removes exactly the named entries', async () => {
  seedFile('sel/a.txt', 'a');
  seedFile('sel/b.txt', 'b');
  const { body: a } = await post('/rm', { path: 'sel/a.txt' });
  const { body: b } = await post('/rm', { path: 'sel/b.txt' });

  const { status, body } = await post('/trash/purge', { ids: [a.trashEntry.id] });
  assert.equal(status, 200);
  assert.equal(body.purged, 1);
  assert.ok(body.bytesFreed >= 1, 'freed bytes reported');

  const remaining = await trash.listTrash();
  assert.equal(remaining.some(e => e.id === a.trashEntry.id), false);
  assert.ok(remaining.some(e => e.id === b.trashEntry.id));
});

test('purge all empties the bin', async () => {
  seedFile('wipe/x.txt', 'x');
  await post('/rm', { path: 'wipe/x.txt' });
  const { body } = await post('/trash/purge', { all: true });
  assert.ok(body.purged > 0);
  assert.equal((await trash.listTrash()).length, 0);
});

test('purge rejects a negative retention rather than treating it as now', async () => {
  const { status } = await post('/trash/purge', { olderThanDays: -1 });
  assert.equal(status, 400);
});

// ─── Reporting ───────────────────────────────────────────────────────────────

test('disk-usage reports the trash as a subset of used bytes', async () => {
  await post('/trash/purge', { all: true });
  const before = await api('/disk-usage');
  assert.equal(before.body.trashBytes, 0);

  seedFile('usage/big.bin', 'x'.repeat(200_000));
  await post('/rm', { path: 'usage/big.bin' });

  const after_ = await api('/disk-usage');
  assert.ok(after_.body.trashBytes >= 200_000, `trashBytes ${after_.body.trashBytes} should cover the file`);
  assert.ok(after_.body.trashBytes <= after_.body.usedBytes, 'trash is a subset of used, not an addition');
  assert.ok(after_.body.trashFormatted.length > 0);
});

test('summary exposes the oldest entry so the backend can skip idle tenants', async () => {
  await post('/trash/purge', { all: true });
  const empty = await api('/trash/summary');
  assert.equal(empty.body.count, 0);
  assert.equal(empty.body.oldestDeletedAt, null);

  seedFile('sum/one.txt', '1');
  await post('/rm', { path: 'sum/one.txt' });
  const one = await api('/trash/summary');
  assert.equal(one.body.count, 1);
  assert.ok(Date.parse(one.body.oldestDeletedAt) > 0);
});

test('deletion provenance is recorded for the deployment path', async () => {
  seedFile('dep/data/file.txt', 'd');
  const { body } = await post('/rm', {
    path: 'dep/data',
    actor: 'operator@example.test',
    origin: 'deployment',
    deploymentName: 'my-wp',
  });
  assert.equal(body.trashEntry.deletedBy, 'operator@example.test');
  assert.equal(body.trashEntry.origin, 'deployment');
  assert.equal(body.trashEntry.deploymentName, 'my-wp');
});

// ─── Overwrites: an incidental replace must be recoverable ───────────────────
//
// These are the silent destructions: the user names a SOURCE (or an archive, or
// a file to upload) and something ELSE disappears. An editor save is excluded
// on purpose — see handleWrite's `expectExisting`.

test('rename onto an occupied name backs up the occupant', async () => {
  await post('/trash/purge', { all: true });
  seedFile('ow/src.txt', 'SOURCE');
  seedFile('ow/victim.txt', 'VICTIM');
  const { status, body } = await post('/rename', { oldPath: 'ow/src.txt', newPath: 'ow/victim.txt' });

  assert.equal(status, 200);
  assert.equal(readFileSync(join(BASE, 'ow/victim.txt'), 'utf8'), 'SOURCE', 'the move happened');
  assert.ok(body.replaced, 'the displaced file was reported');
  assert.equal(body.replaced.originalPath, 'ow/victim.txt');
  assert.equal(body.replaced.origin, 'replaced');

  const { status: rs } = await post('/trash/restore', { id: body.replaced.id, autoRename: true });
  assert.equal(rs, 200);
  assert.equal(readFileSync(join(BASE, 'ow/victim (restored).txt'), 'utf8'), 'VICTIM', 'the lost content came back');
});

test('rename onto a FREE name backs up nothing', async () => {
  await post('/trash/purge', { all: true });
  seedFile('ow2/a.txt', 'A');
  const { body } = await post('/rename', { oldPath: 'ow2/a.txt', newPath: 'ow2/b.txt' });
  assert.equal(body.replaced, null);
  assert.equal((await trash.listTrash()).length, 0, 'the bin stays empty for ordinary renames');
});

test('copy onto an occupied name backs up the occupant', async () => {
  await post('/trash/purge', { all: true });
  seedFile('cp/src.txt', 'NEW');
  seedFile('cp/dest.txt', 'OLD');
  const { body } = await post('/copy', { sourcePath: 'cp/src.txt', destPath: 'cp/dest.txt' });
  assert.equal(readFileSync(join(BASE, 'cp/dest.txt'), 'utf8'), 'NEW');
  assert.equal(body.replaced.originalPath, 'cp/dest.txt');
});

test('an editor save (expectExisting) does NOT fill the bin', async () => {
  // One trash entry per Ctrl-S would bury the accidents this exists to catch.
  await post('/trash/purge', { all: true });
  seedFile('edit/page.php', 'v1');
  for (const v of ['v2', 'v3', 'v4']) {
    await post('/write', { path: 'edit/page.php', content: v, expectExisting: true }); // eslint-disable-line no-await-in-loop
  }
  assert.equal(readFileSync(join(BASE, 'edit/page.php'), 'utf8'), 'v4');
  assert.equal((await trash.listTrash()).length, 0, 'three saves produced no trash entries');
});

test('a blind write over an existing file DOES back it up', async () => {
  // "New File" with a name that already exists, an AI-applied change, a script.
  await post('/trash/purge', { all: true });
  seedFile('blind/notes.txt', 'IRREPLACEABLE');
  await post('/write', { path: 'blind/notes.txt', content: 'clobbered' });
  const entries = await trash.listTrash();
  assert.equal(entries.length, 1, 'the occupant was backed up');
  assert.equal(entries[0].originalPath, 'blind/notes.txt');
});

test('a non-chunked upload over an existing file backs it up', async () => {
  await post('/trash/purge', { all: true });
  seedFile('up/data.bin', 'ORIGINAL-UPLOAD');
  const res = await fetch(`http://127.0.0.1:${port}/write-raw?path=up/data.bin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: 'REPLACEMENT',
  });
  assert.equal(res.status, 200);
  assert.equal(readFileSync(join(BASE, 'up/data.bin'), 'utf8'), 'REPLACEMENT');
  const entries = await trash.listTrash();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].originalPath, 'up/data.bin');
});

test('PARALLEL chunks back up exactly once and never corrupt the upload', async () => {
  // The race that makes a naive "back up at offset 0" wrong: chunks arrive
  // concurrently and out of order. Two backups would move the half-written NEW
  // file into the bin and destroy the upload.
  await post('/trash/purge', { all: true });
  const CHUNK = '0123456789';
  const total = CHUNK.length * 4;
  seedFile('up/par.bin', 'PREVIOUS-CONTENT');

  await Promise.all([3, 1, 0, 2].map((i) =>
    fetch(`http://127.0.0.1:${port}/write-raw?path=up/par.bin&offset=${i * CHUNK.length}&total=${total}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: CHUNK,
    })));

  assert.equal(readFileSync(join(BASE, 'up/par.bin'), 'utf8'), CHUNK.repeat(4), 'upload is intact');
  const entries = await trash.listTrash();
  assert.equal(entries.length, 1, `exactly one backup, got ${entries.length}`);
  assert.equal(entries[0].originalPath, 'up/par.bin');
});

test('extract backs up every file it would overwrite, and nothing it would not', async () => {
  await post('/trash/purge', { all: true });
  // A real tar with one colliding file and one new one.
  const stage = join(BASE, 'stage');
  mkdirSync(join(stage, 'site'), { recursive: true });
  writeFileSync(join(stage, 'site', 'index.php'), 'FROM-ARCHIVE');
  writeFileSync(join(stage, 'site', 'brandnew.php'), 'NEW-FILE');
  execFileSync('tar', ['-cf', join(BASE, 'site.tar'), '-C', stage, 'site']);
  rmSync(stage, { recursive: true, force: true });

  // A live install: index.php is customised; other.php is not in the archive.
  seedFile('live/site/index.php', 'CUSTOMISED-BY-TENANT');
  seedFile('live/site/other.php', 'UNTOUCHED');

  const res = await fetch(`http://127.0.0.1:${port}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'site.tar', destPath: 'live' }),
  });
  await res.text(); // drain the NDJSON stream

  assert.equal(readFileSync(join(BASE, 'live/site/index.php'), 'utf8'), 'FROM-ARCHIVE', 'archive won');
  assert.equal(readFileSync(join(BASE, 'live/site/other.php'), 'utf8'), 'UNTOUCHED', 'untouched file survived');

  const entries = await trash.listTrash();
  assert.equal(entries.length, 1, `only the collision is backed up, got ${entries.map(e => e.originalPath).join(',')}`);
  assert.equal(entries[0].originalPath, 'live/site/index.php');

  // …and the customisation is genuinely recoverable.
  await post('/trash/restore', { id: entries[0].id, autoRename: true });
  assert.equal(readFileSync(join(BASE, 'live/site/index (restored).php'), 'utf8'), 'CUSTOMISED-BY-TENANT');
});
