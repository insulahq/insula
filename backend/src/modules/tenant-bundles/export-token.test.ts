import { describe, it, expect } from 'vitest';
import { signExportToken, verifyExportToken } from './export-token.js';

const KEY = '0'.repeat(64); // 32 bytes hex

describe('signExportToken / verifyExportToken', () => {
  it('round-trips bundleId + format + null password', () => {
    const token = signExportToken({ bundleId: 'bkp-1', format: 'tar' }, KEY);
    const r = verifyExportToken(token, 'bkp-1', KEY);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.bundleId).toBe('bkp-1');
      expect(r.value.format).toBe('tar');
      expect(r.value.password).toBeNull();
    }
  });

  it('round-trips a password through the AES-256-GCM envelope', () => {
    const token = signExportToken({ bundleId: 'bkp-2', format: 'zip', password: 's3cret' }, KEY);
    const r = verifyExportToken(token, 'bkp-2', KEY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.password).toBe('s3cret');
  });

  it('rejects a token bound to a different bundleId (BAD_BUNDLE)', () => {
    const token = signExportToken({ bundleId: 'bkp-A', format: 'tar' }, KEY);
    const r = verifyExportToken(token, 'bkp-B', KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_BUNDLE');
  });

  it('rejects a token signed with a different key (BAD_MAC)', () => {
    const token = signExportToken({ bundleId: 'bkp-1', format: 'tar' }, KEY);
    const otherKey = '1'.repeat(64);
    const r = verifyExportToken(token, 'bkp-1', otherKey);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_MAC');
  });

  it('rejects an expired token (EXPIRED)', () => {
    const token = signExportToken({ bundleId: 'bkp-1', format: 'tar' }, KEY, 1);
    const future = Date.now() + 60_000;
    const r = verifyExportToken(token, 'bkp-1', KEY, future);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('EXPIRED');
  });

  it('rejects a tampered payload (BAD_MAC)', () => {
    const token = signExportToken({ bundleId: 'bkp-1', format: 'tar' }, KEY);
    // Flip a single character in the payload portion
    const dot = token.indexOf('.');
    const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1, dot) + token.slice(dot);
    const r = verifyExportToken(flipped, 'bkp-1', KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BAD_MAC');
  });

  it('rejects a malformed token shape', () => {
    const r = verifyExportToken('garbage-no-separator', 'bkp-1', KEY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('MALFORMED');
  });

  it('treats an empty password as null (plaintext download)', () => {
    const token = signExportToken({ bundleId: 'bkp-1', format: 'tar', password: '' }, KEY);
    const r = verifyExportToken(token, 'bkp-1', KEY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.password).toBeNull();
  });

  it('encodes a unicode + special-char password without corruption', () => {
    const password = 'pässw0rd-with-!@#$%^&*()_+你好';
    const token = signExportToken({ bundleId: 'bkp-uni', format: 'tar', password }, KEY);
    const r = verifyExportToken(token, 'bkp-uni', KEY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.password).toBe(password);
  });

  it('produces distinct tokens for the same input (nonce randomness)', () => {
    const t1 = signExportToken({ bundleId: 'bkp-1', format: 'tar', password: 'x' }, KEY);
    const t2 = signExportToken({ bundleId: 'bkp-1', format: 'tar', password: 'x' }, KEY);
    expect(t1).not.toBe(t2);
  });
});
