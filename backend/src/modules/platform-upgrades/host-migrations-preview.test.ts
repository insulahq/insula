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

  it('enforce says the upgrade updates the nodes first, and how a left-out node catches up', () => {
    // ADR-064: the run updates each node before the services roll. The P0 text
    // said "daily timer, up to ~25 h" — true before runs, false after.
    const r = interpretHostMigrationMode('enforce');
    expect(r.note).toMatch(/updates each node first/i);
    expect(r.note).toMatch(/before the services/i);
    expect(r.note).toMatch(/excluded node catches up on its own update check/i);
    expect(r.note).not.toMatch(/daily|25 h/i);
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
