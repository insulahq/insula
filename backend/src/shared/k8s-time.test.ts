import { describe, it, expect } from 'vitest';
import { k8sTimeIso, k8sTimeMs } from './k8s-time.js';

describe('k8sTimeMs / k8sTimeIso', () => {
  const iso = '2026-10-18T10:26:19.000Z';

  it('reads the string a raw read returns and the Date the typed client returns alike', () => {
    expect(k8sTimeMs(iso)).toBe(Date.parse(iso));
    expect(k8sTimeMs(new Date(iso))).toBe(Date.parse(iso));
    expect(k8sTimeIso(new Date(iso))).toBe(iso);
  });

  it('is null for absent or unparseable input, never NaN', () => {
    expect(k8sTimeMs(undefined)).toBeNull();
    expect(k8sTimeMs(null)).toBeNull();
    expect(k8sTimeMs('not a time')).toBeNull();
    expect(k8sTimeMs(new Date('nope'))).toBeNull();
    expect(k8sTimeIso(undefined)).toBeNull();
  });
});
