/**
 * Tests for readStalwartMasterCredentials — the helper that resolves
 * the platform's Stalwart master account user + password from the
 * `mail/mail-secrets` Secret so the notification worker can send
 * stalwart-internal-provider emails without an operator-supplied
 * password.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  readStalwartMasterCredentials,
  _resetCacheForTests,
  MAIL_SECRET_NAME,
  MAIL_SECRET_NAMESPACE,
  MASTER_PASSWORD_KEY,
  MASTER_USER_KEY,
} from './stalwart-master-creds.js';

beforeEach(() => { _resetCacheForTests(); });

describe('readStalwartMasterCredentials', () => {
  it('returns null when no k8s client is available', async () => {
    const r = await readStalwartMasterCredentials(null);
    expect(r).toBeNull();
  });

  it('returns user + password when both Secret keys are populated', async () => {
    const readSecret = vi.fn().mockImplementation(async (_ns, _name, key) => {
      if (key === MASTER_USER_KEY) return 'master@mail.staging.test';
      if (key === MASTER_PASSWORD_KEY) return 'super-secret';
      return null;
    });
    const r = await readStalwartMasterCredentials(null, { readSecret });
    expect(r).toEqual({ user: 'master@mail.staging.test', password: 'super-secret' });
    expect(readSecret).toHaveBeenCalledWith(MAIL_SECRET_NAMESPACE, MAIL_SECRET_NAME, MASTER_USER_KEY);
    expect(readSecret).toHaveBeenCalledWith(MAIL_SECRET_NAMESPACE, MAIL_SECRET_NAME, MASTER_PASSWORD_KEY);
  });

  it('returns null when password is missing (user alone is useless)', async () => {
    const readSecret = vi.fn().mockImplementation(async (_ns, _name, key) => {
      if (key === MASTER_USER_KEY) return 'master@mail.staging.test';
      return null;
    });
    const r = await readStalwartMasterCredentials(null, { readSecret });
    expect(r).toBeNull();
  });

  it('returns null when user is missing (password alone is useless)', async () => {
    const readSecret = vi.fn().mockImplementation(async (_ns, _name, key) => {
      if (key === MASTER_PASSWORD_KEY) return 'pw';
      return null;
    });
    const r = await readStalwartMasterCredentials(null, { readSecret });
    expect(r).toBeNull();
  });

  it('returns null when Secret read throws (cluster API down, RBAC denied)', async () => {
    const readSecret = vi.fn().mockRejectedValue(new Error('forbidden'));
    const r = await readStalwartMasterCredentials(null, { readSecret });
    expect(r).toBeNull();
  });

  it('caches the result for the TTL window', async () => {
    let calls = 0;
    const readSecret = vi.fn().mockImplementation(async (_ns, _name, key) => {
      calls++;
      if (key === MASTER_USER_KEY) return 'master@mail.staging.test';
      if (key === MASTER_PASSWORD_KEY) return 'pw';
      return null;
    });
    const nowMs = vi.fn().mockReturnValue(1_000_000);
    const r1 = await readStalwartMasterCredentials(null, { readSecret, nowMs });
    const r2 = await readStalwartMasterCredentials(null, { readSecret, nowMs });
    expect(r1).toEqual(r2);
    // First call reads 2 keys; second call hits the cache for both.
    expect(calls).toBe(2);
  });

  it('refreshes after the cache expires', async () => {
    let calls = 0;
    const readSecret = vi.fn().mockImplementation(async (_ns, _name, key) => {
      calls++;
      if (key === MASTER_USER_KEY) return 'master@mail.staging.test';
      if (key === MASTER_PASSWORD_KEY) return 'pw';
      return null;
    });
    const t0 = 1_000_000;
    const t1 = t0 + 10 * 60 * 1000; // 10 min later, past 5-min TTL
    await readStalwartMasterCredentials(null, { readSecret, nowMs: () => t0 });
    await readStalwartMasterCredentials(null, { readSecret, nowMs: () => t1 });
    expect(calls).toBe(4);
  });

  it('trims whitespace from Secret values', async () => {
    const readSecret = vi.fn().mockImplementation(async (_ns, _name, key) => {
      if (key === MASTER_USER_KEY) return '  master@apex\n';
      if (key === MASTER_PASSWORD_KEY) return ' pw \n';
      return null;
    });
    const r = await readStalwartMasterCredentials(null, { readSecret });
    expect(r).toEqual({ user: 'master@apex', password: 'pw' });
  });
});
