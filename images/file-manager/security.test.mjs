// Security unit tests for server.mjs — SSRF IP guard (F1), symlink/realpath
// confinement (F2), and the BASE prefix fix (F3). Run via `node --test`.
//
// We set FM_BASE to a throwaway temp dir BEFORE importing server.mjs (BASE is
// captured at import time) and FM_NO_LISTEN=1 so importing the module doesn't
// bind a port.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = mkdtempSync(join(tmpdir(), 'fm-base-'));
const OUTSIDE = mkdtempSync(join(tmpdir(), 'fm-outside-'));
process.env.FM_BASE = BASE;
process.env.FM_NO_LISTEN = '1';

// Seed the fake PVC:
//   ok/file.txt                 — a normal file inside BASE
//   inlink -> ok                — a symlink that stays inside BASE (allowed)
//   escape -> OUTSIDE           — a symlink pointing OUT of BASE (must be blocked)
mkdirSync(join(BASE, 'ok'), { recursive: true });
writeFileSync(join(BASE, 'ok', 'file.txt'), 'inside');
writeFileSync(join(OUTSIDE, 'secret.txt'), 'TOP_SECRET_OUTSIDE');
symlinkSync(join(BASE, 'ok'), join(BASE, 'inlink'));
symlinkSync(OUTSIDE, join(BASE, 'escape'));

const { safePath, withinBase, ipIsInternal } = await import('./server.mjs');

after(() => { rmSync(BASE, { recursive: true, force: true }); rmSync(OUTSIDE, { recursive: true, force: true }); });

// ─── F1: ipIsInternal ────────────────────────────────────────────────────────
test('ipIsInternal blocks loopback / private / link-local / metadata / CGNAT', () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3', '10.0.0.5', '10.43.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '169.254.0.1', '0.0.0.0', '100.64.0.1', '100.127.1.1',
    '::1', '::', 'fe80::1', 'fe90::1', 'feab::1', 'febf::1', 'fc00::1', 'fd12:3456::1',
    '2002:7f00:1::1', '2002:c0a8:0101::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
  ]) {
    assert.equal(ipIsInternal(ip), true, `${ip} should be internal`);
  }
});

test('ipIsInternal allows public addresses', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '2606:4700:4700::1111', 'fec0::1', '2001:db8::1']) {
    assert.equal(ipIsInternal(ip), false, `${ip} should be public`);
  }
});

test('ipIsInternal fails closed on non-IP input', () => {
  assert.equal(ipIsInternal('not-an-ip'), true);
  assert.equal(ipIsInternal(''), true);
});

// ─── F3: withinBase prefix check ──────────────────────────────────────────────
test('withinBase rejects sibling dirs that merely share the prefix', () => {
  assert.equal(withinBase(BASE), true);
  assert.equal(withinBase(BASE + '/x'), true);
  assert.equal(withinBase(BASE + '-evil/x'), false);
  assert.equal(withinBase(BASE + 'x'), false);
});

// ─── F2: safePath symlink confinement ─────────────────────────────────────────
test('safePath resolves a normal in-base path', async () => {
  const r = await safePath('ok/file.txt');
  assert.equal(r, join(BASE, 'ok', 'file.txt'));
});

test('safePath allows a symlink that stays inside BASE', async () => {
  const r = await safePath('inlink/file.txt');
  // realpath follows inlink -> ok, still inside BASE
  assert.equal(r, join(BASE, 'ok', 'file.txt'));
});

test('safePath REJECTS a symlink that escapes BASE (F2)', async () => {
  assert.equal(await safePath('escape/secret.txt'), null);
  assert.equal(await safePath('escape'), null);
});

test('safePath rejects lexical traversal and the prefix-sibling escape (F3)', async () => {
  assert.equal(await safePath('../etc/passwd'), null);
  assert.equal(await safePath('../../etc/passwd'), null);
  assert.equal(await safePath('../' + BASE.split('/').pop() + '-evil/x'), null);
});

test('safePath allows creating a new (non-existent) file under a real dir', async () => {
  const r = await safePath('ok/newfile.txt'); // leaf doesn't exist yet
  assert.equal(r, join(BASE, 'ok', 'newfile.txt'));
});

test('safePath rejects a new file UNDER an escaping symlink dir', async () => {
  // escape -> OUTSIDE; a not-yet-existing child must still be refused
  assert.equal(await safePath('escape/newfile.txt'), null);
});
