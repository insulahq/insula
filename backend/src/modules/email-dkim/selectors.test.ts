import { describe, it, expect } from 'vitest';
import {
  DKIM_SELECTOR_A,
  DKIM_SELECTOR_B,
  isAbSelector,
  nextDkimSelector,
} from './selectors.js';

describe('email-dkim/selectors', () => {
  it('exposes the fixed A/B pair', () => {
    expect(DKIM_SELECTOR_A).toBe('dkim-1');
    expect(DKIM_SELECTOR_B).toBe('dkim-2');
  });

  it('selector names are DNS-safe (RFC 6376 selector syntax)', () => {
    expect(DKIM_SELECTOR_A).toMatch(/^[a-z0-9-]+$/);
    expect(DKIM_SELECTOR_B).toMatch(/^[a-z0-9-]+$/);
  });

  it('isAbSelector accepts exactly the pair', () => {
    expect(isAbSelector('dkim-1')).toBe(true);
    expect(isAbSelector('dkim-2')).toBe(true);
    expect(isAbSelector('dkim-3')).toBe(false);
    expect(isAbSelector('dkim-20260506194233')).toBe(false);
    expect(isAbSelector('v1-rsa-20260101')).toBe(false);
    expect(isAbSelector(null)).toBe(false);
    expect(isAbSelector(undefined)).toBe(false);
    expect(isAbSelector('')).toBe(false);
  });

  it('nextDkimSelector alternates and converges legacy values onto dkim-1', () => {
    expect(nextDkimSelector('dkim-1')).toBe('dkim-2');
    expect(nextDkimSelector('dkim-2')).toBe('dkim-1');
    expect(nextDkimSelector(null)).toBe('dkim-1');
    expect(nextDkimSelector(undefined)).toBe('dkim-1');
    expect(nextDkimSelector('v1-rsa-20260101')).toBe('dkim-1');
    expect(nextDkimSelector('dkim-20260506194233')).toBe('dkim-1');
  });

  it('a full A→B→A cycle returns to the start (bounded selector set)', () => {
    const first = nextDkimSelector(null);
    const second = nextDkimSelector(first);
    const third = nextDkimSelector(second);
    expect(first).toBe('dkim-1');
    expect(second).toBe('dkim-2');
    expect(third).toBe(first);
  });
});
