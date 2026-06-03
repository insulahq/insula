import { describe, it, expect } from 'vitest';
import { planUpgrade } from './upgrade-planner.js';

const base = { installed: '2026.6.2', available: '2026.7.0', autoUpdate: true, breaking: false } as const;

describe('planUpgrade — auto mode (the reconciler)', () => {
  it('upgrades when auto on + available newer + not breaking', () => {
    const d = planUpgrade({ ...base, mode: 'auto' });
    expect(d.action).toBe('upgrade');
    expect(d.target).toBe('2026.7.0');
    expect(d.proceed).toBe(true);
  });
  it('blocked when auto_update is off', () => {
    const d = planUpgrade({ ...base, autoUpdate: false, mode: 'auto' });
    expect(d.action).toBe('blocked-auto-off');
    expect(d.proceed).toBe(false);
  });
  it('blocked-breaking short-circuits the auto path', () => {
    const d = planUpgrade({ ...base, breaking: true, mode: 'auto' });
    expect(d.action).toBe('blocked-breaking');
    expect(d.proceed).toBe(false);
  });
  it('none when available is not newer (already current)', () => {
    const d = planUpgrade({ ...base, available: '2026.6.2', mode: 'auto' });
    expect(d.action).toBe('none');
    expect(d.proceed).toBe(false);
  });
  it('none when available is OLDER than installed', () => {
    const d = planUpgrade({ ...base, available: '2026.6.1', mode: 'auto' });
    expect(d.action).toBe('none');
  });
  it('blocked-no-candidate when nothing available', () => {
    expect(planUpgrade({ ...base, available: null, mode: 'auto' }).action).toBe('blocked-no-candidate');
  });
  it('blocked-bad-version when available is garbage', () => {
    expect(planUpgrade({ ...base, available: 'latest', mode: 'auto' }).action).toBe('blocked-bad-version');
  });
  it('blocked-installed-unknown — never auto-re-pins when installed is unparseable', () => {
    const d = planUpgrade({ ...base, installed: 'unknown', mode: 'auto' });
    expect(d.action).toBe('blocked-installed-unknown');
    expect(d.proceed).toBe(false);
  });
});

describe('planUpgrade — manual mode (operator)', () => {
  it('upgrades to an explicit requested version (ignores auto_update)', () => {
    const d = planUpgrade({ ...base, autoUpdate: false, requestedVersion: '2026.8.0', mode: 'manual' });
    expect(d.action).toBe('upgrade');
    expect(d.target).toBe('2026.8.0');
  });
  it('falls back to available when no explicit version', () => {
    const d = planUpgrade({ ...base, mode: 'manual' });
    expect(d.action).toBe('upgrade');
    expect(d.target).toBe('2026.7.0');
  });
  it('allows a manual upgrade to a BREAKING release but flags it', () => {
    const d = planUpgrade({ ...base, breaking: true, mode: 'manual' });
    expect(d.action).toBe('upgrade');
    expect(d.reason).toMatch(/BREAKING.*override/);
  });
  it('refuses a manual downgrade / no-op', () => {
    expect(planUpgrade({ ...base, requestedVersion: '2026.6.1', mode: 'manual' }).action).toBe('blocked-not-newer');
    expect(planUpgrade({ ...base, requestedVersion: '2026.6.2', mode: 'manual' }).action).toBe('blocked-not-newer');
  });
  it('refuses a bad requested version', () => {
    expect(planUpgrade({ ...base, requestedVersion: 'garbage', mode: 'manual' }).action).toBe('blocked-bad-version');
  });
  it('blocked-no-candidate when neither requested nor available', () => {
    expect(planUpgrade({ ...base, available: null, mode: 'manual' }).action).toBe('blocked-no-candidate');
  });
  it('manual override is permitted even when installed is unparseable (fresh cluster)', () => {
    const d = planUpgrade({ installed: 'unknown', available: null, autoUpdate: false, breaking: false, requestedVersion: '2026.6.5', mode: 'manual' });
    expect(d.action).toBe('upgrade');
    expect(d.target).toBe('2026.6.5');
  });
});
