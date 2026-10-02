import { describe, it, expect } from 'vitest';
import {
  EMPTY_TIMELINE,
  applyRevertStep,
  beginStep,
  endStep,
  failInFlight,
  parseTimeline,
  revertCompleted,
  type StepTimeline,
} from './restore-timeline.js';

const t0 = new Date('2026-01-01T00:00:00.000Z');
const at = (s: number): Date => new Date(t0.getTime() + s * 1000);

/** Drive the timeline exactly the way runRestoreFromSnapshot does for a
 *  successful run, with revertVolumeToSnapshot's real step names. */
function successfulRun(): StepTimeline {
  let t = beginStep(EMPTY_TIMELINE, 'quiesce', at(0));
  t = endStep(t, 'quiesce', true, null, at(10));
  t = beginStep(t, 'wait-detach', at(10));
  t = applyRevertStep(t, { step: 'wait-detach', ok: true, detail: 'final=detached' }, at(14));
  t = applyRevertStep(t, { step: 'attach-maintenance', ok: true, detail: 'node=node-a' }, at(15));
  t = applyRevertStep(t, { step: 'wait-maintenance', ok: true }, at(21));
  t = applyRevertStep(t, { step: 'longhorn-revert', ok: true }, at(23));
  t = applyRevertStep(t, { step: 'detach-maintenance', ok: true }, at(24));
  t = beginStep(t, 'unquiesce', at(24));
  return endStep(t, 'unquiesce', true, null, at(40));
}

describe('restore timeline — a successful run', () => {
  const t = successfulRun();

  it('records every step once, in run order, with nothing left in flight', () => {
    expect(t.steps.map((s) => s.key)).toEqual([
      'quiesce', 'wait-detach', 'attach-maintenance', 'wait-maintenance', 'revert', 'detach-maintenance', 'unquiesce',
    ]);
    expect(t.steps.every((s) => s.ok)).toBe(true);
    expect(t.inFlight).toBeNull();
  });

  it('times each revert sub-step from the end of the one before it', () => {
    const waitMaint = t.steps.find((s) => s.key === 'wait-maintenance')!;
    expect(waitMaint.startedAt).toBe(at(15).toISOString());
    expect(waitMaint.finishedAt).toBe(at(21).toISOString());
  });

  it('keeps the engine detail for the operator view', () => {
    expect(t.steps.find((s) => s.key === 'attach-maintenance')!.detail).toBe('node=node-a');
  });

  it('maps longhorn-revert onto the revert step', () => {
    expect(revertCompleted(t)).toBe(true);
  });

  it('never mutates the timeline it was given', () => {
    const before = beginStep(EMPTY_TIMELINE, 'quiesce', at(0));
    const frozen = JSON.stringify(before);
    endStep(before, 'quiesce', true, null, at(1));
    expect(JSON.stringify(before)).toBe(frozen);
    expect(EMPTY_TIMELINE).toEqual({ steps: [], inFlight: null });
  });
});

describe('restore timeline — failures', () => {
  function upToRevert(): StepTimeline {
    let t = beginStep(EMPTY_TIMELINE, 'quiesce', at(0));
    t = endStep(t, 'quiesce', true, null, at(10));
    return beginStep(t, 'wait-detach', at(10));
  }

  it('a failure inside the maintenance window closes the in-flight step as failed before the cleanup detach', () => {
    let t = upToRevert();
    t = applyRevertStep(t, { step: 'wait-detach', ok: true }, at(12));
    t = applyRevertStep(t, { step: 'attach-maintenance', ok: true }, at(13));
    // wait-maintenance times out → revertVolumeToSnapshot detaches and
    // reports ONLY the cleanup, tagged after-failure.
    t = applyRevertStep(t, { step: 'detach-maintenance', ok: true, detail: 'after-failure' }, at(80));
    const failed = t.steps.find((s) => s.key === 'wait-maintenance')!;
    expect(failed.ok).toBe(false);
    expect(failed.startedAt).toBe(at(13).toISOString());
    expect(t.steps[t.steps.length - 1]).toMatchObject({ key: 'detach-maintenance', ok: true });
    expect(t.inFlight).toBeNull();
    expect(revertCompleted(t)).toBe(false);
  });

  it('a failure the engine never reports (attach outside the try) is closed by failInFlight', () => {
    let t = upToRevert();
    t = applyRevertStep(t, { step: 'wait-detach', ok: true }, at(12));
    // attach POST fails → throw with no report; the orchestrator's catch:
    t = failInFlight(t, at(14));
    expect(t.steps[t.steps.length - 1]).toMatchObject({ key: 'attach-maintenance', ok: false });
    expect(t.inFlight).toBeNull();
  });

  it('a reported failed step opens nothing after it', () => {
    let t = upToRevert();
    t = applyRevertStep(t, { step: 'wait-detach', ok: false, detail: 'final=attached' }, at(300));
    expect(t.inFlight).toBeNull();
    expect(failInFlight(t, at(301))).toBe(t);
  });

  it('ignores a step name it does not know rather than inventing a step', () => {
    const t = upToRevert();
    expect(applyRevertStep(t, { step: 'something-new', ok: true }, at(11))).toBe(t);
  });
});

describe('parseTimeline', () => {
  it('round-trips what the orchestrator persists', () => {
    const t = successfulRun();
    expect(parseTimeline(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });

  it('reads anything that is not a timeline as null', () => {
    expect(parseTimeline(null)).toBeNull();
    expect(parseTimeline('x')).toBeNull();
    expect(parseTimeline({ steps: 'nope' })).toBeNull();
  });

  it('drops malformed steps and an unknown in-flight key instead of trusting them', () => {
    const parsed = parseTimeline({
      steps: [
        { key: 'quiesce', ok: true, startedAt: at(0).toISOString(), finishedAt: at(1).toISOString(), detail: null },
        { key: 'drop-tables', ok: true, startedAt: at(0).toISOString(), finishedAt: at(1).toISOString() },
        { key: 'revert', ok: 'yes', startedAt: at(0).toISOString(), finishedAt: at(1).toISOString() },
      ],
      inFlight: { key: 'bogus', startedAt: at(2).toISOString() },
    });
    expect(parsed?.steps.map((s) => s.key)).toEqual(['quiesce']);
    expect(parsed?.inFlight).toBeNull();
  });
});
