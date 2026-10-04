import { describe, expect, it } from 'vitest';
import { cappedList } from './list-items.js';

describe('cappedList', () => {
  it('keeps a short list whole', () => {
    expect(cappedList(['a', 'b'], 3)).toEqual(['a', 'b']);
  });
  it('counts what it leaves out, as its own item', () => {
    expect(cappedList(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b', '…and 2 more.']);
  });
});
