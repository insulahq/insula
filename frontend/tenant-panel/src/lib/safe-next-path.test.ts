import { describe, it, expect } from 'vitest';
import { safeNextPath } from './safe-next-path';

describe('safeNextPath', () => {
  it('keeps a path inside the panel, with its query and hash', () => {
    expect(safeNextPath('/email/mailboxes')).toBe('/email/mailboxes');
    expect(safeNextPath('/email/mailboxes?mailbox=abc#x')).toBe('/email/mailboxes?mailbox=abc#x');
    expect(safeNextPath('/domains/1234')).toBe('/domains/1234');
  });

  it('falls back to the home page when there is nothing to follow', () => {
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
    expect(safeNextPath('')).toBe('/');
  });

  it('never follows a value that leaves this panel', () => {
    for (const bad of [
      'https://evil.test/',
      'http:/evil.test',
      '//evil.test/path',
      '/\\evil.test',
      'javascript:alert(1)',
      'email/mailboxes',
      '/\tevil',
      ' /email',
    ]) {
      expect(safeNextPath(bad), bad).toBe('/');
    }
  });

  it('does not land on the login page again', () => {
    expect(safeNextPath('/login')).toBe('/');
    expect(safeNextPath('/login?token=x')).toBe('/');
  });

  it('normalises dot segments instead of escaping with them', () => {
    expect(safeNextPath('/email/../domains')).toBe('/domains');
    expect(safeNextPath('/../../etc')).toBe('/etc');
  });
});
