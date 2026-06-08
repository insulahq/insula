import { describe, it, expect } from 'vitest';
import { deriveFmSecret } from './internal-secret.js';

describe('deriveFmSecret (F5 per-tenant file-manager secret)', () => {
  const master = 'super-secret-global-master-value';

  it('is deterministic for the same (master, namespace)', () => {
    expect(deriveFmSecret(master, 'tenant-abc')).toBe(deriveFmSecret(master, 'tenant-abc'));
  });

  it('differs per namespace', () => {
    expect(deriveFmSecret(master, 'tenant-abc')).not.toBe(deriveFmSecret(master, 'tenant-xyz'));
  });

  it('never equals the global master (so a leaked per-tenant value is useless against the internal endpoints)', () => {
    expect(deriveFmSecret(master, 'tenant-abc')).not.toBe(master);
  });

  it('changes when the master rotates', () => {
    expect(deriveFmSecret(master, 'tenant-abc')).not.toBe(deriveFmSecret('different-master', 'tenant-abc'));
  });

  it('produces a url-safe token of reasonable length', () => {
    const s = deriveFmSecret(master, 'tenant-abc');
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(s.length).toBeGreaterThanOrEqual(43); // 32-byte HMAC → 43 base64url chars
  });
});
