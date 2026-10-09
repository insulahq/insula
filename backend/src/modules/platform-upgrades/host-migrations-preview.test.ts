import { describe, it, expect } from 'vitest';
import { interpretHostMigrationMode } from './host-migrations-preview.js';

describe('interpretHostMigrationMode', () => {
  it('absent CM → no policy, willRun false', () => {
    const r = interpretHostMigrationMode(null);
    expect(r.mode).toBe('absent');
    expect(r.willRun).toBe(false);
  });

  it('enforce → willRun true', () => {
    const r = interpretHostMigrationMode('enforce');
    expect(r.mode).toBe('enforce');
    expect(r.willRun).toBe(true);
    expect(r.note).toMatch(/Enabled/);
  });

  it('enforce never claims the scripts run DURING the upgrade', () => {
    // They do not: a node applies a release's host changes when its own CLI
    // updates, on the node's daily timer. The old text said "during the
    // upgrade" while every node still ran the previous CLI for hours.
    const r = interpretHostMigrationMode('enforce');
    expect(r.note).not.toMatch(/during the upgrade/i);
    expect(r.note).toMatch(/daily update timer/i);
  });

  it('observe (and empty) → willRun false', () => {
    expect(interpretHostMigrationMode('observe').willRun).toBe(false);
    expect(interpretHostMigrationMode('observe').mode).toBe('observe');
    expect(interpretHostMigrationMode('').mode).toBe('observe');
  });

  it('case-insensitive + trims', () => {
    expect(interpretHostMigrationMode('  ENFORCE ').mode).toBe('enforce');
  });

  it('an unrecognised mode → unknown, willRun false (never fail-open to running)', () => {
    const r = interpretHostMigrationMode('garbage');
    expect(r.mode).toBe('unknown');
    expect(r.willRun).toBe(false);
  });
});
