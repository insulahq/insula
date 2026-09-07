/**
 * The FM drift check compares memory limits NUMERICALLY. A string compare is
 * what made an operator's emergency raise impossible to keep (production
 * 2026-09-06), so the parser it depends on is worth pinning directly.
 */
import { describe, it, expect } from 'vitest';
import { parseMemoryToBytes, FM_MEMORY_LIMIT, FM_MEMORY_REQUEST } from './k8s-lifecycle.js';

describe('parseMemoryToBytes', () => {
  it('parses the binary suffixes Kubernetes actually emits', () => {
    expect(parseMemoryToBytes('64Mi')).toBe(64 * 1024 ** 2);
    expect(parseMemoryToBytes('256Mi')).toBe(256 * 1024 ** 2);
    expect(parseMemoryToBytes('1Gi')).toBe(1024 ** 3);
    expect(parseMemoryToBytes('512Ki')).toBe(512 * 1024);
  });

  it('parses decimal suffixes and bare byte counts', () => {
    // A limit set via the API may come back normalised as plain bytes.
    expect(parseMemoryToBytes('268435456')).toBe(268435456);
    expect(parseMemoryToBytes('500M')).toBe(500e6);
  });

  it('returns null for anything it cannot read', () => {
    // The caller treats null as drift: an unreadable limit is not evidence of
    // a correct one, so it must NOT be mistaken for "big enough".
    for (const bad of ['', '   ', 'lots', '12Xi', undefined, null, '1.2.3Mi']) {
      expect(parseMemoryToBytes(bad as string), String(bad)).toBeNull();
    }
  });

  it('orders the values the drift check relies on', () => {
    const want = parseMemoryToBytes(FM_MEMORY_LIMIT)!;
    expect(parseMemoryToBytes('1Gi')!).toBeGreaterThan(want);   // override: keep
    expect(parseMemoryToBytes('128Mi')!).toBeLessThan(want);    // shortfall: fix
    expect(parseMemoryToBytes(FM_MEMORY_REQUEST)!).toBeLessThan(want);
  });
});
