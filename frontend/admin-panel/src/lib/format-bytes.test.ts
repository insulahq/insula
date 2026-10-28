import { describe, it, expect } from 'vitest';
import { formatBytes, formatVolumeBytes } from './format-bytes';

describe('formatBytes', () => {
  it('counts decimally, as the target reports it', () => {
    // Production's tenant folder: 204,376,364,099 bytes. Divided by 1024³ it
    // printed "190.3 GB" — 7% short of the target's own figure.
    expect(formatBytes(204_376_364_099)).toBe('204.4 GB');
    expect(formatBytes(1_099_511_627_776)).toBe('1.1 TB');
    expect(formatBytes(18_076_058)).toBe('18.1 MB');
    expect(formatBytes(1_500)).toBe('1.5 kB');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('carries a value that rounds up to the next unit', () => {
    expect(formatBytes(999_960)).toBe('1.0 MB');
    expect(formatBytes(999_949)).toBe('999.9 kB');
    // An average over bundles is fractional.
    expect(formatBytes(999.6)).toBe('1.0 kB');
    expect(formatBytes(12.4)).toBe('12 B');
  });

  it('tells a measured zero from no figure', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatVolumeBytes', () => {
  it('shows a size set in GiB as that number', () => {
    expect(formatVolumeBytes(10 * 1024 ** 3)).toBe('10.0 GiB');
    expect(formatVolumeBytes(512 * 1024 ** 2)).toBe('512.0 MiB');
    expect(formatVolumeBytes(1024 ** 4)).toBe('1.0 TiB');
  });

  it('carries a value that rounds up to the next unit', () => {
    expect(formatVolumeBytes(1024 ** 3 - 1)).toBe('1.0 GiB');
  });

  it('has no figure for a missing or impossible size', () => {
    expect(formatVolumeBytes(0)).toBe('0 B');
    expect(formatVolumeBytes(null)).toBe('—');
  });
});
