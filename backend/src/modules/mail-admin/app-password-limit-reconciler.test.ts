import { describe, it, expect } from 'vitest';
import { MAIL_SERVER_APP_PASSWORD_LIMIT } from '@insula/api-contracts';
import {
  runAppPasswordLimitReconcilerTick,
  type AppPasswordLimitReconcilerDeps,
} from './app-password-limit-reconciler.js';

type Call = [string, Record<string, unknown>, string];

/** A fake Stalwart: x:Authentication singleton + x:Action reloads, recording every call. */
function fakeStalwart(auth: Record<string, unknown> | null, opts: { reloadFails?: boolean } = {}) {
  const calls: Call[] = [];
  const state = auth ? { ...auth } : null;
  const deps: AppPasswordLimitReconcilerDeps = {
    authHeader: 'Basic x',
    jmapPost: async (_auth, body) => {
      const { methodCalls } = body as { methodCalls: Call[] };
      calls.push(...methodCalls);
      return {
        methodResponses: methodCalls.map(([name, args, id]): Call => {
          if (name === 'x:Authentication/get') return [name, { list: state ? [state] : [] }, id];
          if (name === 'x:Authentication/set') {
            Object.assign(state ?? {}, (args.update as Record<string, Record<string, unknown>>).singleton);
            return [name, { updated: { singleton: null } }, id];
          }
          if (name === 'x:Action/set') {
            return [name, opts.reloadFails ? { notCreated: { r: { type: 'forbidden' } } } : { created: { r: { id: 'a1' } } }, id];
          }
          return ['error', { type: 'unknownMethod' }, id];
        }),
      };
    },
  };
  return { deps, calls, state };
}

describe('runAppPasswordLimitReconcilerTick', () => {
  it('is 10 login passwords plus one webmail session', () => {
    expect(MAIL_SERVER_APP_PASSWORD_LIMIT).toBe(11);
  });

  // Stalwart's default is 5, expired ones counted: "Initial" plus a few
  // webmail sessions filled it, and webmail stopped opening.
  it('raises Stalwart\'s default of 5 to 11 and reloads the settings', async () => {
    const s = fakeStalwart({ maxAppPasswords: 5, maxApiKeys: 5, passwordMinLength: 8 });
    const r = await runAppPasswordLimitReconcilerTick(s.deps);
    expect(r).toEqual({ outcome: 'updated', prior: 5, current: 11, reloaded: true });
    expect(s.calls.map((c) => c[0])).toEqual(['x:Authentication/get', 'x:Authentication/set', 'x:Action/set']);
    // Only the one property — the rest of the authentication settings are the operator's.
    expect(s.calls[1][1].update).toEqual({ singleton: { maxAppPasswords: 11 } });
    expect((s.calls[2][1].create as Record<string, unknown>).r).toEqual({ '@type': 'ReloadSettings' });
    expect(s.state?.maxAppPasswords).toBe(11);
  });

  it.each([
    ['already 11', 11],
    ['set higher by the operator', 25],
    ['no limit at all', null],
  ])('writes nothing when the limit is %s', async (_why, value) => {
    const s = fakeStalwart({ maxAppPasswords: value });
    const r = await runAppPasswordLimitReconcilerTick(s.deps);
    expect(r).toEqual({ outcome: 'unchanged', prior: value, current: value, reloaded: false });
    expect(s.calls.map((c) => c[0])).toEqual(['x:Authentication/get']);
  });

  it('treats a missing limit as no limit', async () => {
    const s = fakeStalwart({ passwordMinLength: 8 });
    expect(await runAppPasswordLimitReconcilerTick(s.deps)).toMatchObject({ outcome: 'unchanged', prior: null });
  });

  it('says so when the settings reload did not run', async () => {
    const s = fakeStalwart({ maxAppPasswords: 5 }, { reloadFails: true });
    expect(await runAppPasswordLimitReconcilerTick(s.deps)).toEqual({ outcome: 'updated', prior: 5, current: 11, reloaded: false });
  });

  it('refuses to guess when Stalwart returns no settings', async () => {
    const s = fakeStalwart(null);
    await expect(runAppPasswordLimitReconcilerTick(s.deps)).rejects.toThrow(/no singleton/);
    expect(s.calls.map((c) => c[0])).toEqual(['x:Authentication/get']);
  });

  it('refuses a limit that is not a number', async () => {
    const s = fakeStalwart({ maxAppPasswords: '5' });
    await expect(runAppPasswordLimitReconcilerTick(s.deps)).rejects.toThrow(/not a number/);
  });
});
