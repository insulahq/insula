import { describe, it, expect } from 'vitest';
import { nodeChecksForUpdatesHourly } from './platform-updates.js';

describe('nodeChecksForUpdatesHourly', () => {
  it('hourly from CLI 2026.10.7 on — releases, candidates and later months', () => {
    for (const v of ['2026.10.7', '2026.10.7-rc.8', 'v2026.10.7', '2026.10.8', '2026.11.1', '2027.1.1']) {
      expect(nodeChecksForUpdatesHourly(v)).toBe(true);
    }
  });

  it('daily before it, and for a CLI too old to report its version', () => {
    for (const v of ['2026.10.6', '2026.9.30', '2025.12.31', null, undefined, '', 'unknown']) {
      expect(nodeChecksForUpdatesHourly(v)).toBe(false);
    }
  });
});
