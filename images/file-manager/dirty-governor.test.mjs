// dirty-governor.mjs — `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEFAULTS, createDirtyGovernor, decide, parseLimit, parsePending } from './dirty-governor.mjs';

const MiB = 1048576;
const LIMIT = 256 * MiB;

test('parsePending reads file_dirty + file_writeback from memory.stat', () => {
  const stat = 'anon 24326144\nfile 146931712\nfile_dirty 104857600\nfile_writeback 42074112\nslab 95441416\n';
  assert.deepEqual(parsePending(stat), { dirty: 104857600, writeback: 42074112 });
  assert.deepEqual(parsePending('anon 1\n'), { dirty: 0, writeback: 0 });
});

test('parseLimit: bytes, or null for "max" / garbage', () => {
  assert.equal(parseLimit('268435456\n'), 268435456);
  assert.equal(parseLimit('max\n'), null);
  assert.equal(parseLimit(''), null);
});

test('decide: flush early, pause later, resume when drained or after the cap', () => {
  const idle = { paused: false, pausedAt: null, flushing: false };
  const at = (mib, state = idle, now = 0) => decide({ pending: mib * MiB, limit: LIMIT, now, state });
  assert.deepEqual(at(10), { flush: false, pause: false, resume: false });     // ~4 %
  assert.deepEqual(at(70), { flush: true, pause: false, resume: false });      // > 25 %
  assert.deepEqual(at(110), { flush: true, pause: true, resume: false });      // > 40 %
  assert.equal(at(110, { ...idle, flushing: true }).flush, false);             // one flush at a time
  const paused = { paused: true, pausedAt: 1000, flushing: true };
  assert.deepEqual(at(60, paused, 2000), { flush: false, pause: false, resume: false }); // between marks: hold
  assert.equal(at(30, paused, 2000).resume, true);                              // < 15 %: drained
  assert.equal(at(200, paused, 1000 + DEFAULTS.maxPauseMs).resume, true);       // cap: never hang
});

function harness({ pendings, writers }) {
  let i = 0;
  let t = 0;
  const signals = [];
  const logs = [];
  let flushes = 0;
  let release;
  const gov = createDirtyGovernor({
    readMax: () => String(LIMIT),
    readStat: () => `file_dirty ${pendings[Math.min(i, pendings.length - 1)] * MiB}\nfile_writeback 0\n`,
    listWriters: () => writers.slice(),
    signal: (pid, sig) => {
      if (pid === 999) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
      signals.push(`${sig}:${pid}`);
    },
    flush: () => { flushes += 1; return new Promise((r) => { release = r; }); },
    now: () => t,
    log: (m) => logs.push(m),
  });
  const step = (ms = 250) => { const r = gov.tick(); i += 1; t += ms; return r; };
  return { gov, step, signals, logs, flushes: () => flushes, finishFlush: () => release?.(), writers };
}

test('pauses the writers above the mark, holds new ones, resumes once drained', async () => {
  const h = harness({ pendings: [10, 70, 110, 120, 60, 30], writers: [101, 102] });
  h.step();                                    // 10 MiB: nothing
  assert.equal(h.flushes(), 0);
  h.step();                                    // 70 MiB: flush starts
  assert.equal(h.flushes(), 1);
  h.step();                                    // 110 MiB: pause
  assert.deepEqual(h.signals, ['SIGSTOP:101', 'SIGSTOP:102']);
  h.writers.push(103);                         // a writer that started during the pause
  h.step();                                    // 120 MiB: still above → the newcomer is held too
  assert.deepEqual(h.signals.slice(2), ['SIGSTOP:103']);
  h.step();                                    // 60 MiB: between the marks → hold
  assert.equal(h.signals.length, 3);
  h.step();                                    // 30 MiB: drained → continue all three
  assert.deepEqual(h.signals.slice(3).sort(), ['SIGCONT:101', 'SIGCONT:102', 'SIGCONT:103']);
  assert.equal(h.gov.state.paused, false);
  assert.match(h.logs.join('\n'), /paused 2 writer\(s\): 110 MiB/);
  assert.match(h.logs.join('\n'), /resumed 3 writer\(s\) after \d+ ms \(drained/);
  h.finishFlush();
});

test('a backlog that never drains is released after the cap, not held forever', () => {
  const pendings = Array(200).fill(200);
  const h = harness({ pendings, writers: [101] });
  h.step();                                    // pause at t=0
  assert.ok(h.gov.state.paused);
  for (let k = 0; k < DEFAULTS.maxPauseMs / 250; k += 1) h.step();
  assert.ok(h.signals.includes('SIGCONT:101'));
  assert.match(h.logs.join('\n'), /max pause reached/);
});

test('stop() always continues a paused writer; a vanished process is ignored', () => {
  const h = harness({ pendings: [150], writers: [101, 999] });
  h.step();
  assert.deepEqual(h.signals, ['SIGSTOP:101']); // 999 already exited (ESRCH) — not tracked
  h.gov.stop();
  assert.deepEqual(h.signals, ['SIGSTOP:101', 'SIGCONT:101']);
  assert.equal(h.gov.state.paused, false);
});

test('idle when the cgroup is unlimited or unreadable', () => {
  const unlimited = createDirtyGovernor({ readMax: () => 'max', readStat: () => '', log: () => {} });
  assert.deepEqual(unlimited.tick(), { skipped: 'unlimited' });
  const unreadable = createDirtyGovernor({ readMax: () => { throw new Error('ENOENT'); }, readStat: () => '', log: () => {} });
  assert.deepEqual(unreadable.tick(), { skipped: 'unreadable' });
});

test('really stops and continues a process (Linux)', { skip: process.platform !== 'linux' }, async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    await sleep(100);
    const state = () => readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1][0];
    let pending = 150;
    const gov = createDirtyGovernor({
      readMax: () => String(LIMIT),
      readStat: () => `file_dirty ${pending * MiB}\n`,
      listWriters: () => [child.pid],
      flush: async () => {},
      log: () => {},
    });
    gov.tick();
    await sleep(50);
    assert.equal(state(), 'T');                 // stopped
    pending = 10;
    gov.tick();
    await sleep(50);
    assert.notEqual(state(), 'T');              // running (sleeping) again
  } finally {
    child.kill('SIGKILL');
  }
});
