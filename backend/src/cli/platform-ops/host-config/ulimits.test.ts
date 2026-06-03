import { describe, it, expect } from 'vitest';
import { convergeUlimits, ulimitLineValid, renderUlimits } from './ulimits.js';
import type { UlimitDeps } from './types.js';

function fakeDeps(initial: string | null = null): { deps: UlimitDeps; writes: string[] } {
  const state = { current: initial };
  const writes: string[] = [];
  const deps: UlimitDeps = {
    readDesired: async () => null,
    readCurrent: () => state.current,
    writeDropIn: (c) => { writes.push(c); state.current = c; },
  };
  return { deps, writes };
}

describe('ulimitLineValid', () => {
  it('accepts valid limits.conf lines', () => {
    for (const l of [
      '* soft nofile 65536',
      '@dev hard nproc unlimited',
      'root - memlock -1',
      '%group soft stack 8192',
      '* hard nice -20', // negative value (nice/priority)
      '-bob soft nofile 1024', // single-dash pam negation prefix
    ]) {
      expect(ulimitLineValid(l)).toBe(true);
    }
  });
  it('rejects malformed / injection lines', () => {
    for (const l of [
      '* soft nofile',
      'evil; rm',
      '* bad nofile 1',
      '* soft nofile abc',
      '* soft nofile 1 2',
      'a b c d e',
      '--evil soft nofile 1', // double-dash flag-lookalike domain
    ]) {
      expect(ulimitLineValid(l)).toBe(false);
    }
  });
});

describe('renderUlimits', () => {
  it('keeps valid lines, drops invalid, skips comments/blanks, normalises whitespace', () => {
    const r = renderUlimits(['# c', '', '*   soft   nofile   65536', 'bad line', '@dev hard nproc unlimited']);
    expect(r.valid).toEqual(['* soft nofile 65536', '@dev hard nproc unlimited']);
    expect(r.invalid).toEqual(['bad line']);
    expect(r.content).toMatch(/^# Managed by platform-ops/);
    expect(r.content.endsWith('\n')).toBe(true);
  });
});

describe('convergeUlimits', () => {
  it('absent → benign', () => {
    expect(convergeUlimits(null, true, fakeDeps().deps).state).toBe('absent');
  });
  it('writes the drop-in when it drifts (enforce)', () => {
    const { deps, writes } = fakeDeps('# old\n');
    const r = convergeUlimits(['* soft nofile 65536'], true, deps);
    expect(r.state).toBe('written');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('* soft nofile 65536');
  });
  it('dry-run reports would-write, writes nothing', () => {
    const { deps, writes } = fakeDeps('# old\n');
    const r = convergeUlimits(['* soft nofile 65536'], false, deps);
    expect(r.state).toBe('would-write');
    expect(writes).toHaveLength(0);
  });
  it('idempotent — matching drop-in is ok, no write', () => {
    const { content } = renderUlimits(['* soft nofile 65536']);
    const { deps, writes } = fakeDeps(content);
    expect(convergeUlimits(['* soft nofile 65536'], true, deps).state).toBe('ok');
    expect(writes).toHaveLength(0);
  });
  it('surfaces invalid lines (dropped, never written)', () => {
    const { deps } = fakeDeps('# old\n');
    const r = convergeUlimits(['* soft nofile 65536', 'evil; rm -rf /'], true, deps);
    expect(r.invalidLines).toEqual(['evil; rm -rf /']);
    expect(r.state).toBe('written');
  });
  it('records a write failure', () => {
    const deps: UlimitDeps = { readDesired: async () => null, readCurrent: () => '# old\n', writeDropIn: () => { throw new Error('EACCES'); } };
    const r = convergeUlimits(['* soft nofile 65536'], true, deps);
    expect(r.ok).toBe(false);
    expect(r.state).toBe('write-failed');
  });
  it('refuses an oversized policy wholesale (ok=false, never written)', () => {
    const many = Array.from({ length: 250 }, (_, i) => `user${i} soft nofile 1024`);
    const { deps, writes } = fakeDeps('# old\n');
    const r = convergeUlimits(many, true, deps);
    expect(r.ok).toBe(false);
    expect(r.state).toBe('refused');
    expect(writes).toHaveLength(0);
  });
});
