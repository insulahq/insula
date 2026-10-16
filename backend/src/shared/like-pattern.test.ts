import { describe, it, expect } from 'vitest';
import { likePattern, likePrefixPattern } from './like-pattern.js';

describe('likePattern', () => {
  it('wraps the escaped term for a substring match', () => {
    expect(likePattern('acme')).toBe('%acme%');
    expect(likePattern('a_b%c\\')).toBe('%a\\_b\\%c\\\\%');
  });
});

describe('likePrefixPattern', () => {
  it('anchors the escaped term at the start', () => {
    expect(likePrefixPattern('sv2.cluster')).toBe('sv2.cluster%');
    expect(likePrefixPattern('a_b%c\\')).toBe('a\\_b\\%c\\\\%');
  });
});
