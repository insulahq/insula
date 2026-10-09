import { describe, it, expect } from 'vitest';
import type { AutoUpdateStatus } from '@insula/api-contracts';
import { autoUpdateTick, channelCatchUpTick, type AutoUpdateDeps } from './auto-update.js';
import { planUpgrade } from './upgrade-planner.js';

const SUNDAY_3AM = new Date('2026-10-11T03:00:00Z');
const MONDAY = new Date('2026-10-12T12:00:00Z');
const window = { days: [0], start: '02:00', end: '05:00', timeZone: 'UTC' };

function harness(over: {
  installed?: string; available?: string | null; autoUpdate?: boolean; breaking?: boolean;
  now?: Date; win?: typeof window | null; running?: boolean; preflightOk?: boolean; startOk?: boolean;
} = {}) {
  const calls = { notices: [] as string[], started: [] as string[], statuses: [] as AutoUpdateStatus[] };
  const deps: AutoUpdateDeps = {
    now: () => over.now ?? SUNDAY_3AM,
    decide: async () => planUpgrade({
      installed: over.installed ?? '2026.10.7', available: over.available === undefined ? '2026.10.8' : over.available,
      autoUpdate: over.autoUpdate ?? true, breaking: over.breaking ?? false, mode: 'auto',
    }),
    window: async () => (over.win === undefined ? window : over.win),
    runInFlight: async () => over.running ?? false,
    preflight: async () => (over.preflightOk ?? true)
      ? { gates: [], ok: true, failures: 0, warnings: 0 }
      : { gates: [{ id: 'cnpg-healthy', label: 'Database healthy', status: 'fail', detail: 'no primary' }], ok: false, failures: 1, warnings: 0 },
    start: async (t) => { calls.started.push(t); return (over.startOk ?? true) ? { started: true, message: '' } : { started: false, message: 'already running' }; },
    notify: async (key) => { calls.notices.push(key); },
    saveStatus: async (s) => { calls.statuses.push(s); },
  };
  return { deps, calls };
}

describe('autoUpdateTick', () => {
  it('off → records it, starts nothing', async () => {
    const h = harness({ autoUpdate: false });
    expect((await autoUpdateTick(h.deps)).state).toBe('off');
    expect(h.calls.started).toEqual([]);
  });

  it('inside the window with a green pre-flight → starts the run and notifies', async () => {
    const h = harness();
    const s = await autoUpdateTick(h.deps);
    expect(s).toMatchObject({ state: 'started', target: '2026.10.8' });
    expect(h.calls.started).toEqual(['2026.10.8']);
    expect(h.calls.notices).toEqual(['auto-update:2026.10.8:started']);
  });

  it('outside the window → waits, saying when', async () => {
    const h = harness({ now: MONDAY });
    const s = await autoUpdateTick(h.deps);
    expect(s.state).toBe('waiting-window');
    expect(s.detail).toMatch(/next maintenance window: Sun 02:00–05:00 \(UTC\)/);
    expect(h.calls.started).toEqual([]);
  });

  it('no window set → never acts, and says what is missing', async () => {
    const h = harness({ win: null });
    const s = await autoUpdateTick(h.deps);
    expect(s.state).toBe('held');
    expect(s.detail).toMatch(/set a maintenance window/);
    expect(h.calls.started).toEqual([]);
  });

  it('a failing pre-flight skips the window and notifies once per target + gates', async () => {
    const h = harness({ preflightOk: false });
    const s = await autoUpdateTick(h.deps);
    expect(s.state).toBe('blocked');
    expect(s.detail).toMatch(/Database healthy/);
    expect(h.calls.started).toEqual([]);
    expect(h.calls.notices).toEqual(['auto-update:2026.10.8:preflight:cnpg-healthy']);
  });

  it('never applies a release candidate or a BREAKING release', async () => {
    const rc = harness({ available: '2026.10.8-rc.1' });
    expect(await autoUpdateTick(rc.deps)).toMatchObject({ state: 'held' });
    expect(rc.calls.started).toEqual([]);
    const breaking = harness({ breaking: true });
    expect(await autoUpdateTick(breaking.deps)).toMatchObject({ state: 'held' });
    expect(breaking.calls.started).toEqual([]);
    expect(breaking.calls.notices).toEqual(['auto-update:2026.10.8:breaking']);
  });

  it('an upgrade already in flight → waits for it', async () => {
    const h = harness({ running: true });
    expect((await autoUpdateTick(h.deps)).state).toBe('running');
    expect(h.calls.started).toEqual([]);
  });

  it('already current → says so', async () => {
    const h = harness({ available: '2026.10.7' });
    expect((await autoUpdateTick(h.deps)).state).toBe('current');
  });

  it('a start that is refused → blocked, notified', async () => {
    const h = harness({ startOk: false });
    expect(await autoUpdateTick(h.deps)).toMatchObject({ state: 'blocked', detail: 'already running' });
    expect(h.calls.notices).toEqual(['auto-update:2026.10.8:start']);
  });
});

describe('channelCatchUpTick (ADR-064 §9)', () => {
  const deps = (over: Partial<Parameters<typeof channelCatchUpTick>[0]> = {}) => {
    const started: Array<[string, readonly string[]]> = [];
    const notices: string[] = [];
    return {
      started,
      notices,
      deps: {
        followsChannel: async () => true,
        installed: async () => '2026.10.8-rc.1',
        runInFlight: async () => false,
        latestRunTarget: async () => '2026.10.7',
        nodesBehind: async () => ({ behind: ['sv1', 'w1'], notReady: ['w1'] }),
        start: async (v: string, ex: readonly string[]) => { started.push([v, ex]); return { started: true, message: '' }; },
        preflight: async () => ({ gates: [], ok: true, failures: 0, warnings: 0 }),
        notify: async (key: string) => { notices.push(key); },
        ...over,
      },
    };
  };

  it('a channel rolled the services and nodes lag → one run for that version, leaving out nodes that are down', async () => {
    const h = deps();
    expect(await channelCatchUpTick(h.deps)).toMatch(/catch up with 2026\.10\.8-rc\.1/);
    expect(h.started).toEqual([['2026.10.8-rc.1', ['w1']]]);
  });

  it('not on a channel (a pinned release: production) → never', async () => {
    const h = deps({ followsChannel: async () => false });
    expect(await channelCatchUpTick(h.deps)).toBeNull();
    expect(h.started).toEqual([]);
  });

  it('one catch-up per version — never a loop; nothing while a run is in flight or no node lags', async () => {
    for (const over of [
      { latestRunTarget: async () => '2026.10.8-rc.1' },
      { runInFlight: async () => true },
      { nodesBehind: async () => ({ behind: ['w1'], notReady: ['w1'] }) },
      { nodesBehind: async () => ({ behind: [], notReady: [] }) },
    ]) {
      const h = deps(over);
      expect(await channelCatchUpTick(h.deps)).toBeNull();
      expect(h.started).toEqual([]);
    }
  });

  it('a failing pre-flight holds the catch-up and notifies once (the nodes still update hourly)', async () => {
    const h = deps({ preflight: async () => ({ gates: [{ id: 'cnpg-healthy', label: 'Database healthy', status: 'fail', detail: 'no primary\x1b[2J' }], ok: false, failures: 1, warnings: 0 }) });
    expect(await channelCatchUpTick(h.deps)).toBeNull();
    expect(h.started).toEqual([]);
    expect(h.notices).toEqual(['channel-catch-up:2026.10.8-rc.1:preflight:cnpg-healthy']);
  });
});

