// Dirty-data governor: slow a heavy write down instead of letting it OOM.
//
// Everything a transfer writes is charged to THIS container's memory cgroup
// (256Mi): rsync / scp / sftp-serve run in here (the SFTP gateway execs them),
// and so do the archive tools this server spawns. Data written faster than the
// tenant's Longhorn volume can absorb piles up as DIRTY and WRITEBACK pages —
// memory the kernel cannot free until the disk catches up. In production
// a site-migration rsync filled the cgroup with 100 MiB dirty + 40 MiB
// writeback (process memory was 24 MB) and a filesystem allocation that may not
// wait for writeback OOM-killed the container, aborting the upload.
//
// The kernel's own answer — a cgroup `memory.high` that throttles instead of
// killing — is not set by Kubernetes (memory.high reads `max` in here) and
// cannot be set from inside the container. So this does the same thing in user
// space, from the container's own counters:
//
//   pending = file_dirty + file_writeback        (memory.stat)
//   pending > FLUSH_AT  * memory.max  → start one flush of the volume (sync -f)
//   pending > PAUSE_AT  * memory.max  → also SIGSTOP the writer processes
//   pending < RESUME_AT * memory.max  → SIGCONT them (or after MAX_PAUSE_MS)
//
// A paused writer stops reading its input, so the backlog travels back through
// the SFTP gateway's exec stream to the client's SSH connection: the upload
// slows to the speed the volume really writes at. Nothing is lost; no per-file
// fsync, no kernel or kubelet setting, and nothing happens while idle.

import { readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

export const DEFAULTS = Object.freeze({
  flushAt: 0.25,
  pauseAt: 0.40,
  resumeAt: 0.15,
  intervalMs: 250,
  // A volume that cannot drain at all must not freeze a transfer forever: after
  // this long the writers run again (and are paused again on the next tick if
  // the backlog is still above the mark — a crawl, never a hang).
  maxPauseMs: 30_000,
});

/** Processes whose writes the governor may pause (/proc/<pid>/comm values). */
export const WRITER_COMMS = Object.freeze(new Set([
  'rsync', 'scp', 'sftp-serve', 'sftp-server', 'tar', 'unzip', 'git', 'cp',
]));

/** `memory.stat` text → { dirty, writeback } in bytes (0 when absent). */
export function parsePending(statText) {
  let dirty = 0;
  let writeback = 0;
  for (const line of statText.split('\n')) {
    const [key, value] = line.split(' ');
    if (key === 'file_dirty') dirty = Number(value) || 0;
    else if (key === 'file_writeback') writeback = Number(value) || 0;
  }
  return { dirty, writeback };
}

/** `memory.max` text → bytes, or null when unlimited / unreadable. */
export function parseLimit(maxText) {
  const v = maxText.trim();
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

/**
 * The decision for one tick. Pure.
 * state: { paused: boolean, pausedAt: number|null, flushing: boolean }
 * → { flush: boolean, pause: boolean, resume: boolean }
 */
export function decide({ pending, limit, now, state, opts = DEFAULTS }) {
  const flush = !state.flushing && pending > opts.flushAt * limit;
  if (state.paused) {
    const drained = pending < opts.resumeAt * limit;
    const tooLong = state.pausedAt !== null && now - state.pausedAt >= opts.maxPauseMs;
    return { flush, pause: false, resume: drained || tooLong };
  }
  return { flush, pause: pending > opts.pauseAt * limit, resume: false };
}

function procWriters(selfPid) {
  const pids = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === selfPid) continue;
    try {
      if (WRITER_COMMS.has(readFileSync(`/proc/${name}/comm`, 'utf8').trim())) pids.push(pid);
    } catch { /* exited between readdir and read */ }
  }
  return pids;
}

const MiB = (b) => (b / 1048576).toFixed(0);

/**
 * Wire the decision to the real system. Every dependency is injectable so the
 * behaviour can be tested without a cgroup, /proc or a volume.
 */
export function createDirtyGovernor(deps = {}) {
  const opts = { ...DEFAULTS, ...(deps.opts ?? {}) };
  const cgroup = deps.cgroupDir ?? '/sys/fs/cgroup';
  const readStat = deps.readStat ?? (() => readFileSync(`${cgroup}/memory.stat`, 'utf8'));
  const readMax = deps.readMax ?? (() => readFileSync(`${cgroup}/memory.max`, 'utf8'));
  const listWriters = deps.listWriters ?? (() => procWriters(process.pid));
  const signal = deps.signal ?? ((pid, sig) => process.kill(pid, sig));
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((msg) => console.log(`[dirty-governor] ${msg}`));
  const volume = deps.volume ?? '/data';
  const flush = deps.flush ?? (() => new Promise((resolve) => {
    const child = spawn('sync', ['-f', volume], { stdio: 'ignore' });
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  }));

  const state = { paused: false, pausedAt: null, flushing: false, pausedPids: new Set() };
  let timer = null;

  const send = (pid, sig) => {
    try { signal(pid, sig); return true; } catch { return false; } // ESRCH: already gone
  };

  function pauseWriters(pending) {
    for (const pid of listWriters()) {
      if (!state.pausedPids.has(pid) && send(pid, 'SIGSTOP')) state.pausedPids.add(pid);
    }
    if (!state.paused && state.pausedPids.size > 0) {
      state.paused = true;
      state.pausedAt = now();
      log(`paused ${state.pausedPids.size} writer(s): ${MiB(pending)} MiB not yet on disk`);
    }
  }

  function resumeWriters(pending, reason) {
    for (const pid of state.pausedPids) send(pid, 'SIGCONT');
    const held = state.pausedAt === null ? 0 : now() - state.pausedAt;
    if (state.pausedPids.size > 0) log(`resumed ${state.pausedPids.size} writer(s) after ${held} ms (${reason}; ${MiB(pending)} MiB pending)`);
    state.pausedPids.clear();
    state.paused = false;
    state.pausedAt = null;
  }

  /** One evaluation. Returns what it did (for tests and logs). */
  function tick() {
    let limit;
    let pending;
    try {
      limit = parseLimit(readMax());
      const { dirty, writeback } = parsePending(readStat());
      pending = dirty + writeback;
    } catch {
      return { skipped: 'unreadable' };
    }
    if (limit === null) return { skipped: 'unlimited' };

    // While paused, a writer that started after the pause is held too.
    if (state.paused && pending > opts.pauseAt * limit) pauseWriters(pending);

    const d = decide({ pending, limit, now: now(), state, opts });
    if (d.flush) {
      state.flushing = true;
      Promise.resolve(flush()).finally(() => { state.flushing = false; });
    }
    if (d.pause) pauseWriters(pending);
    if (d.resume) resumeWriters(pending, pending < opts.resumeAt * limit ? 'drained' : 'max pause reached');
    return { pending, limit, ...d };
  }

  function start() {
    if (timer) return;
    try {
      if (parseLimit(readMax()) === null) { log('memory.max is unlimited — governor idle'); return; }
      readStat();
    } catch {
      log('cgroup v2 memory counters not readable — governor idle');
      return;
    }
    timer = setInterval(tick, opts.intervalMs);
    timer.unref?.();
    log(`watching ${volume}: flush at ${opts.flushAt * 100}%, pause writers at ${opts.pauseAt * 100}%, resume below ${opts.resumeAt * 100}% of memory.max (${MiB(parseLimit(readMax()))} MiB)`);
  }

  /** Stop ticking and never leave a writer stopped. */
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (state.paused) resumeWriters(0, 'governor stopped');
  }

  return { tick, start, stop, state };
}
