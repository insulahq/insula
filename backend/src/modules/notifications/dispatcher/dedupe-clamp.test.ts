import { describe, it, expect } from 'vitest';
import { clampDedupeKey, DEDUPE_KEY_MAX } from './dispatch.js';

describe('clampDedupeKey', () => {
  it('leaves undefined and short keys untouched', () => {
    expect(clampDedupeKey(undefined)).toBeUndefined();
    const short = 'cdfail:abc:1234';
    expect(clampDedupeKey(short)).toBe(short);
  });

  it('leaves a key of exactly the max length untouched', () => {
    const exact = 'x'.repeat(DEDUPE_KEY_MAX);
    expect(clampDedupeKey(exact)).toBe(exact);
  });

  it('clamps an over-long key to fit the varchar(128) column', () => {
    const long = 'custom-deploy-failed:' + 'y'.repeat(400);
    const out = clampDedupeKey(long)!;
    expect(out.length).toBe(DEDUPE_KEY_MAX);
  });

  it('is deterministic and keeps distinct long keys distinct (hash discriminates)', () => {
    const a = 'k:' + 'a'.repeat(300);
    const b = 'k:' + 'a'.repeat(299) + 'b';
    expect(clampDedupeKey(a)).toBe(clampDedupeKey(a)); // stable
    expect(clampDedupeKey(a)).not.toBe(clampDedupeKey(b)); // collision-resistant
  });

  it('preserves a readable prefix so the key stays greppable', () => {
    const out = clampDedupeKey('cdfail:d5a6b6bd:' + 'z'.repeat(300))!;
    expect(out.startsWith('cdfail:d5a6b6bd:')).toBe(true);
  });
});
