import { describe, expect, it } from 'vitest';
import { detectMode, makeUi, type UiMode } from './ui';

/**
 * The plain-mode prefixes are a cross-runtime contract: scripts/lib/ui.sh emits
 * the identical strings, --remote streams them, and the VM harness log gate
 * greps them. These assertions are what stop the two halves drifting apart.
 * scripts/test-ui.sh asserts the same shapes on the bash side.
 */
function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sink: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

const plain = (mode: UiMode = 'plain') => ({ mode });

describe('detectMode', () => {
  it('is plain whenever stdout is not a terminal', () => {
    expect(detectMode({ isTTY: false, env: { TERM: 'xterm' } })).toBe('plain');
  });
  it('honours NO_COLOR on a terminal', () => {
    expect(detectMode({ isTTY: true, env: { TERM: 'xterm', NO_COLOR: '1' } })).toBe('plain');
  });
  it('honours TERM=dumb', () => {
    expect(detectMode({ isTTY: true, env: { TERM: 'dumb' } })).toBe('plain');
  });
  it('honours CI', () => {
    expect(detectMode({ isTTY: true, env: { TERM: 'xterm', CI: 'true' } })).toBe('plain');
  });
  it('is rich on a plain interactive terminal', () => {
    expect(detectMode({ isTTY: true, env: { TERM: 'xterm-256color' } })).toBe('rich');
  });
});

describe('plain-mode prefixes match the bash renderer', () => {
  it('emits the agreed prefixes', () => {
    const s = sink();
    const ui = makeUi(s.sink, plain());
    ui.phaseTotal(3);
    ui.phase('Installing');
    ui.step('pull image');
    ui.ok('pull image');
    ui.detail('endpoint https://admin.example.test');
    ui.warn('disk is 85% full');
    ui.fail('rollout did not complete');
    ui.summary('Done');

    expect(s.out).toContain('PHASE: [1/3] Installing');
    expect(s.out).toContain('STEP: pull image');
    expect(s.out).toContain('OK: pull image');
    expect(s.out).toContain('INFO: endpoint https://admin.example.test');
    expect(s.err).toContain('WARN: disk is 85% full');
    expect(s.err).toContain('ERROR: rollout did not complete');
  });

  it('routes warnings and errors to stderr, never stdout', () => {
    const s = sink();
    const ui = makeUi(s.sink, plain());
    ui.warn('w');
    ui.fail('e');
    expect(s.out).toHaveLength(0);
    expect(s.err).toHaveLength(2);
  });

  it('never emits escape sequences in plain mode', () => {
    const s = sink();
    const ui = makeUi(s.sink, plain());
    ui.phaseTotal(1);
    ui.phase('p');
    ui.ok('o');
    ui.summary('s');
    // eslint-disable-next-line no-control-regex
    expect([...s.out, ...s.err].join('\n')).not.toMatch(/\[/);
  });
});

describe('machine output stays byte-pure', () => {
  it('raw() does not decorate, count, or route to stderr', () => {
    const s = sink();
    const ui = makeUi(s.sink, plain());
    const payload = JSON.stringify({ ok: true, checks: 12 });
    ui.raw(payload);
    expect(s.out).toEqual([payload]);
    expect(s.err).toHaveLength(0);
    expect(ui.counts).toEqual({ warnings: 0, errors: 0 });
  });

  it('raw() is undecorated in rich mode too — a pipe may still be reading it', () => {
    const s = sink();
    const ui = makeUi(s.sink, { mode: 'rich' });
    ui.raw('{"a":1}');
    expect(s.out).toEqual(['{"a":1}']);
  });
});

describe('run()', () => {
  it('shows one line on success and hides the output', async () => {
    const s = sink();
    const ui = makeUi(s.sink, plain());
    const r = await ui.run('apply manifests', async () => ({ code: 0, output: 'noisy kubectl detail' }));
    expect(r.code).toBe(0);
    expect(s.out).toContain('OK: apply manifests');
    expect([...s.out, ...s.err].join('\n')).not.toContain('noisy kubectl detail');
  });

  it('replays the full output on failure, with the exit code', async () => {
    const s = sink();
    const ui = makeUi(s.sink, plain());
    const r = await ui.run('apply manifests', async () => ({
      code: 2,
      output: 'error: unable to recognize "x.yaml"\nsecond line',
    }));
    expect(r.code).toBe(2);
    expect(s.err).toContain('ERROR: apply manifests (exit 2)');
    const joined = s.err.join('\n');
    expect(joined).toContain('unable to recognize');
    expect(joined).toContain('second line');
  });

  it('passes the value through', async () => {
    const s = sink();
    const ui = makeUi(s.sink, plain());
    const r = await ui.run('read', async () => ({ code: 0, value: { nodes: 3 } }));
    expect(r.value).toEqual({ nodes: 3 });
  });
});

describe('summary', () => {
  it('reports phases actually reached, never a forced 100%', () => {
    const s = sink();
    const ui = makeUi(s.sink, plain());
    ui.phaseTotal(9);
    ui.phase('a');
    ui.phase('b');
    ui.phase('c');
    ui.fail('stopped');
    ui.summary('Upgrade stopped');
    const line = s.out.find((l) => l.startsWith('SUMMARY:'))!;
    expect(line).toContain('(3/9 phases)');
    expect(line).not.toContain('(9/9 phases)');
  });

  it('tallies warnings and errors so a noisy success cannot look clean', () => {
    const s = sink();
    const ui = makeUi(s.sink, plain());
    ui.phaseTotal(1);
    ui.phase('only');
    ui.warn('one');
    ui.warn('two');
    ui.summary('Finished');
    const line = s.out.find((l) => l.startsWith('SUMMARY:'))!;
    expect(line).toContain('2 warning(s)');
    expect(ui.counts).toEqual({ warnings: 2, errors: 0 });
  });

  it('says nothing about counts when there were none', () => {
    const s = sink();
    const ui = makeUi(s.sink, plain());
    ui.phaseTotal(2);
    ui.phase('a');
    ui.phase('b');
    ui.summary('Finished');
    expect(s.out.find((l) => l.startsWith('SUMMARY:'))).toBe('SUMMARY: Finished (2/2 phases)');
  });
});
