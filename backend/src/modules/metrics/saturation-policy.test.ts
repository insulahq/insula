import { describe, it, expect } from 'vitest';
import {
  decideEpisodeAction,
  durationText,
  levelWithHysteresis,
  reminderDelayMs,
  saturationLevel,
  HYSTERESIS,
  SATURATION_WARN,
  SATURATION_CRITICAL,
  STORAGE_SATURATION_CRITICAL,
} from './saturation-policy.js';

const W = SATURATION_WARN;
const C = SATURATION_CRITICAL;
const SC = STORAGE_SATURATION_CRITICAL;

describe('saturationLevel', () => {
  it('null below warn', () => {
    expect(saturationLevel(0, W, C)).toBeNull();
    expect(saturationLevel(0.89, W, C)).toBeNull();
    expect(saturationLevel(NaN, W, C)).toBeNull();
  });
  it('warning between warn and crit', () => {
    expect(saturationLevel(0.9, W, C)).toBe('warning');
    expect(saturationLevel(0.99, W, C)).toBe('warning');
  });
  it('critical at/over crit', () => {
    expect(saturationLevel(1.0, W, C)).toBe('critical');
    expect(saturationLevel(1.5, W, C)).toBe('critical');
    expect(saturationLevel(0.95, W, SC)).toBe('critical');
  });
});

describe('levelWithHysteresis', () => {
  it('enters on the hard threshold, not the hysteresis band', () => {
    // 87% has never alerted, and must not start alerting just because the
    // band below 90 is sticky for episodes that already exist.
    expect(levelWithHysteresis(0.87, null, W, SC)).toBeNull();
    expect(levelWithHysteresis(0.9, null, W, SC)).toBe('warning');
  });

  it('holds a warning through the hysteresis band', () => {
    expect(levelWithHysteresis(0.87, 'warning', W, SC)).toBe('warning');
    // Below warn - 5pp it finally lets go.
    expect(levelWithHysteresis(0.849, 'warning', W, SC)).toBeNull();
  });

  it('escalates immediately — hysteresis never delays bad news', () => {
    expect(levelWithHysteresis(0.95, 'warning', W, SC)).toBe('critical');
    expect(levelWithHysteresis(1.0, null, W, C)).toBe('critical');
  });

  it('holds critical through its own band, then steps down one level', () => {
    // storage critical is 0.95, so it stays critical down to 0.90.
    expect(levelWithHysteresis(0.91, 'critical', W, SC)).toBe('critical');
    expect(levelWithHysteresis(0.89, 'critical', W, SC)).toBe('warning');
  });

  it('a crash from critical straight to healthy resolves, not "warning"', () => {
    // The naive step-down returns 'warning' for ANY sub-critical ratio, which
    // would leave a tenant at 3% usage holding an open warning episode.
    expect(levelWithHysteresis(0.03, 'critical', W, SC)).toBeNull();
  });

  it('is null for a non-finite ratio, matching saturationLevel', () => {
    // The caller guards `available > 0`, so neither of these is reachable in
    // production. They are pinned because the two level functions must agree:
    // a divergence here would open an episode that can never be evaluated
    // again, and so could never be resolved.
    expect(levelWithHysteresis(NaN, 'critical', W, SC)).toBeNull();
    expect(levelWithHysteresis(Infinity, null, W, SC)).toBeNull();
    expect(saturationLevel(Infinity, W, SC)).toBeNull();
  });

  it('hysteresis is 5 points of the limit', () => {
    expect(HYSTERESIS).toBe(0.05);
  });
});

describe('reminderDelayMs', () => {
  it('walks 1h → 6h → daily and then stays daily', () => {
    expect(reminderDelayMs(1)).toBe(3_600_000);
    expect(reminderDelayMs(2)).toBe(6 * 3_600_000);
    expect(reminderDelayMs(3)).toBe(24 * 3_600_000);
    expect(reminderDelayMs(99)).toBe(24 * 3_600_000);
  });
  it('clamps a nonsense count instead of returning undefined', () => {
    expect(reminderDelayMs(0)).toBe(3_600_000);
    expect(reminderDelayMs(-5)).toBe(3_600_000);
  });
});

describe('decideEpisodeAction', () => {
  const now = new Date('2026-09-21T18:00:00Z');
  const base = { lastNotifiedAt: null, notifyCount: 1, now };

  it('opens when the condition first appears', () => {
    expect(decideEpisodeAction({ ...base, prevLevel: null, newLevel: 'warning' })).toBe('open');
  });

  it('says nothing when there is nothing to say', () => {
    expect(decideEpisodeAction({ ...base, prevLevel: null, newLevel: null })).toBe('none');
  });

  it('resolves when an open episode clears', () => {
    expect(decideEpisodeAction({ ...base, prevLevel: 'critical', newLevel: null })).toBe('resolve');
  });

  it('escalates on a level change in EITHER direction', () => {
    expect(decideEpisodeAction({ ...base, prevLevel: 'warning', newLevel: 'critical' })).toBe('escalate');
    expect(decideEpisodeAction({ ...base, prevLevel: 'critical', newLevel: 'warning' })).toBe('escalate');
  });

  it('stays silent inside the ladder window — this is the whole fix', () => {
    // One hour scheduler tick, an episode that already sent its opening
    // alert 5 minutes ago. The old code fired here. The new code must not.
    expect(decideEpisodeAction({
      prevLevel: 'warning',
      newLevel: 'warning',
      lastNotifiedAt: new Date(now.getTime() - 5 * 60_000),
      notifyCount: 1,
      now,
    })).toBe('none');
  });

  it('reminds once the ladder rung elapses', () => {
    expect(decideEpisodeAction({
      prevLevel: 'warning',
      newLevel: 'warning',
      lastNotifiedAt: new Date(now.getTime() - 61 * 60_000),
      notifyCount: 1,
      now,
    })).toBe('remind');
    // ...but a second reminder has to wait six hours, not another one.
    expect(decideEpisodeAction({
      prevLevel: 'warning',
      newLevel: 'warning',
      lastNotifiedAt: new Date(now.getTime() - 61 * 60_000),
      notifyCount: 2,
      now,
    })).toBe('none');
  });

  it('treats an unusable timestamp as DUE, never as never-due', () => {
    // A deadline computed from a bad clock must fail loud, not silent.
    expect(decideEpisodeAction({
      prevLevel: 'warning',
      newLevel: 'warning',
      lastNotifiedAt: new Date('nonsense'),
      notifyCount: 1,
      now,
    })).toBe('remind');
  });

  it('a 24h sustained episode produces 3 messages, not 24', () => {
    // Walk a full day of hourly ticks through the real policy.
    const t0 = new Date('2026-09-21T00:00:00Z').getTime();
    let lastNotifiedAt: Date | null = null;
    let notifyCount = 0;
    let sent = 0;
    for (let h = 0; h < 24; h++) {
      const tick = new Date(t0 + h * 3_600_000);
      const action = decideEpisodeAction({
        prevLevel: h === 0 ? null : 'warning',
        newLevel: 'warning',
        lastNotifiedAt,
        notifyCount,
        now: tick,
      });
      if (action === 'open' || action === 'remind') {
        sent += 1;
        notifyCount = action === 'open' ? 1 : notifyCount + 1;
        lastNotifiedAt = tick;
      }
    }
    // open at h0, remind at h1 (1h rung), remind at h7 (6h rung) — then the
    // daily rung carries past the end of the day.
    expect(sent).toBe(3);
  });
});

describe('durationText', () => {
  const t = Date.parse('2026-09-21T00:00:00Z');
  it('minutes, hours, days', () => {
    expect(durationText(t, t + 60_000)).toBe('1 minute');
    expect(durationText(t, t + 45 * 60_000)).toBe('45 minutes');
    expect(durationText(t, t + 3 * 3_600_000)).toBe('3 hours');
    expect(durationText(t, t + 72 * 3_600_000)).toBe('3 days');
  });
  it('never renders a negative duration from clock skew', () => {
    expect(durationText(t, t - 99_000)).toBe('0 minutes');
  });
});
