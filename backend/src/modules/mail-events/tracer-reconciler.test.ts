import { describe, it, expect, vi, beforeEach } from 'vitest';

const tracerGet = vi.fn();
const tracerSet = vi.fn();
const actionReloadSettings = vi.fn();

vi.mock('../stalwart-jmap/client.js', () => ({
  tracerGet: (...a: unknown[]) => tracerGet(...a),
  tracerSet: (...a: unknown[]) => tracerSet(...a),
  actionReloadSettings: (...a: unknown[]) => actionReloadSettings(...a),
}));

const { planStdoutTracer, desiredStdoutTracer, ensureStalwartStdoutTracer, TRACER_TYPE } =
  await import('./tracer-reconciler.js');

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const log = (over: Record<string, unknown> = {}) => ({
  id: 'i1', enable: true, '@type': 'Log', level: 'info', path: '/var/log/stalwart', ...over,
});
const stdout = (over: Record<string, unknown> = {}) => ({
  id: 's1', enable: true, '@type': 'Stdout', level: 'info', ...over,
});

beforeEach(() => {
  tracerGet.mockReset(); tracerSet.mockReset(); actionReloadSettings.mockReset();
  tracerSet.mockResolvedValue({});
  actionReloadSettings.mockResolvedValue(undefined);
});

describe('planStdoutTracer', () => {
  it('creates one when only the default file Log tracer exists', () => {
    // This IS the shipped state: a Log tracer pointing at a directory
    // the container does not have, so nothing is logged anywhere.
    expect(planStdoutTracer([log()])).toEqual({ action: 'create' });
  });

  it('does nothing when an enabled info Stdout tracer is already present', () => {
    expect(planStdoutTracer([log(), stdout()])).toEqual({ action: 'none' });
  });

  it('re-enables a disabled Stdout tracer rather than creating a second one', () => {
    expect(planStdoutTracer([stdout({ enable: false })])).toEqual({ action: 'enable', id: 's1' });
  });

  it('never removes the operator/default Log tracer', () => {
    const plan = planStdoutTracer([log()]);
    expect(JSON.stringify(plan)).not.toContain('destroy');
  });
});

describe('ensureStalwartStdoutTracer', () => {
  it('creates the tracer and reloads so it takes effect without a pod roll', async () => {
    tracerGet.mockResolvedValue([log()]);
    const res = await ensureStalwartStdoutTracer(silent);
    expect(res.changed).toBe(true);
    const arg = tracerSet.mock.calls[0][0] as { create: Record<string, Record<string, unknown>> };
    expect(arg.create.stdout['@type']).toBe(TRACER_TYPE);
    expect(arg.create.stdout.enable).toBe(true);
    expect(actionReloadSettings).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on the second pass (converged, not thrashing)', async () => {
    tracerGet.mockResolvedValue([log(), stdout()]);
    const res = await ensureStalwartStdoutTracer(silent);
    expect(res.changed).toBe(false);
    expect(tracerSet).not.toHaveBeenCalled();
    expect(actionReloadSettings).not.toHaveBeenCalled();
  });

  it('degrades to a logged skip when Stalwart is unreachable', async () => {
    tracerGet.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await ensureStalwartStdoutTracer(silent);
    expect(res.changed).toBe(false);
    expect(tracerSet).not.toHaveBeenCalled();
  });

  it('does not claim success when Stalwart rejects the create', async () => {
    tracerGet.mockResolvedValue([log()]);
    tracerSet.mockResolvedValue({ notCreated: { stdout: { type: 'invalidPatch' } } });
    const res = await ensureStalwartStdoutTracer(silent);
    expect(res.changed).toBe(false);
    expect(actionReloadSettings).not.toHaveBeenCalled();
  });
});

describe('desiredStdoutTracer', () => {
  it('uses the @type Stalwart actually accepts', () => {
    // Probed live against v0.16.20: "Console" and "Stderr" are both
    // rejected with invalidPatch; "Stdout" is the accepted spelling.
    expect(desiredStdoutTracer()['@type']).toBe('Stdout');
  });
});
