import { describe, it, expect } from 'vitest';
import { keepReturnPath, safeNextPath, takeReturnPath } from './safe-next-path';

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

describe('the return path kept across an SSO sign-in', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  };

  it('brings the consent page back with its request, once', () => {
    const s = memory();
    keepReturnPath(s, '/oauth/consent?request=abc');
    expect(takeReturnPath(s)).toBe('/oauth/consent?request=abc');
    expect(takeReturnPath(s)).toBeNull();
  });

  it('keeps nothing unsafe, and nothing for the home page', () => {
    const s = memory();
    keepReturnPath(s, 'https://evil.test/x');
    expect(takeReturnPath(s)).toBeNull();
    keepReturnPath(s, '/files');
    keepReturnPath(s, '/');
    expect(takeReturnPath(s)).toBeNull();
  });
});
