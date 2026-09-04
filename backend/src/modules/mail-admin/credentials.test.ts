import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readStalwartCredentials, readStalwartCredentialsAuthoritative } from './credentials.js';

describe('readStalwartCredentials', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'stalwart-creds-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('prefers the mounted Secret file over env vars (live rotation support)', () => {
    writeFileSync(join(tmp, 'ADMIN_SECRET_PLAIN'), 'rotated-from-secret\n');
    expect(readStalwartCredentials({
      STALWART_ADMIN_CREDS_DIR: tmp,
      STALWART_ADMIN_PASSWORD: 'stale-from-env',
    })).toEqual({ username: 'admin', password: 'rotated-from-secret' });
  });

  it('returns STALWART_ADMIN_USER + STALWART_ADMIN_PASSWORD when both set', () => {
    expect(readStalwartCredentials({
      STALWART_ADMIN_USER: 'svc-admin',
      STALWART_ADMIN_PASSWORD: 'hunter2',
    })).toEqual({ username: 'svc-admin', password: 'hunter2' });
  });

  it('falls back to ADMIN_SECRET_PLAIN when STALWART_ADMIN_PASSWORD is not set', () => {
    expect(readStalwartCredentials({
      ADMIN_SECRET_PLAIN: 'legacy-password',
    })).toEqual({ username: 'admin', password: 'legacy-password' });
  });

  it('ignores an empty/whitespace-only secret file and falls through to env', () => {
    writeFileSync(join(tmp, 'ADMIN_SECRET_PLAIN'), '\n  \n');
    expect(readStalwartCredentials({
      STALWART_ADMIN_CREDS_DIR: tmp,
      STALWART_ADMIN_PASSWORD: 'env-win',
    })).toEqual({ username: 'admin', password: 'env-win' });
  });

  it('prefers STALWART_ADMIN_PASSWORD over legacy env names', () => {
    expect(readStalwartCredentials({
      STALWART_ADMIN_PASSWORD: 'new-env-password',
      STALWART_ADMIN_SECRET_PLAIN: 'old-env-1',
      ADMIN_SECRET_PLAIN: 'old-env-2',
    })).toEqual({ username: 'admin', password: 'new-env-password' });
  });

  it('defaults username to "admin" when STALWART_ADMIN_USER is empty/missing', () => {
    expect(readStalwartCredentials({ STALWART_ADMIN_PASSWORD: 'pw' })).toEqual({
      username: 'admin',
      password: 'pw',
    });
    expect(readStalwartCredentials({
      STALWART_ADMIN_USER: '',
      STALWART_ADMIN_PASSWORD: 'pw',
    })).toEqual({ username: 'admin', password: 'pw' });
  });

  it('throws when no password-like source is configured', () => {
    expect(() => readStalwartCredentials({})).toThrow(/Stalwart admin password/i);
  });

  it('throws when password env var is whitespace only', () => {
    expect(() => readStalwartCredentials({ STALWART_ADMIN_PASSWORD: '   ' })).toThrow();
  });
});

/**
 * Guards the "rotate shows the OLD password" bug.
 *
 * Rotation patches the Secret, but platform-api mounts it and kubelet refreshes
 * a mounted Secret up to ~60s late. The admin panel's credentials query is
 * staleTime:0 / refetchOnMount:'always', so the refetch fired right after a
 * rotation read the stale FILE and overwrote the correct password the mutation
 * had just seeded. Reading the Secret itself removes the window.
 */
describe('readStalwartCredentialsAuthoritative', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const staleEnv = {
    STALWART_ADMIN_PASSWORD: 'OLD-password-from-the-stale-mount',
    STALWART_ADMIN_USER: 'admin',
  };

  it('prefers the Secret over the stale mounted value', async () => {
    const read = vi.fn(async () => ({ ADMIN_SECRET_PLAIN: b64('NEW-password') }));
    await expect(readStalwartCredentialsAuthoritative(staleEnv, read))
      .resolves.toEqual({ username: 'admin', password: 'NEW-password' });
  });

  it('reads the platform mirror Secret by default', async () => {
    const read = vi.fn(async () => ({ ADMIN_SECRET_PLAIN: b64('x') }));
    await readStalwartCredentialsAuthoritative(staleEnv, read);
    expect(read).toHaveBeenCalledWith('platform', 'platform-stalwart-creds');
  });

  it('honours namespace/name overrides', async () => {
    const read = vi.fn(async () => ({ ADMIN_SECRET_PLAIN: b64('x') }));
    await readStalwartCredentialsAuthoritative(
      { ...staleEnv, STALWART_CREDS_SECRET_NAMESPACE: 'ns', STALWART_CREDS_SECRET_NAME: 'sec' },
      read,
    );
    expect(read).toHaveBeenCalledWith('ns', 'sec');
  });

  // Degrade, never break: a missing RBAC grant or an API blip must fall back to
  // the previous behaviour rather than failing the reveal outright.
  it.each([
    ['the API throws', async () => { throw new Error('forbidden'); }],
    ['the Secret has no such key', async () => ({ OTHER: b64('x') })],
    ['the value is empty', async () => ({ ADMIN_SECRET_PLAIN: b64('   ') })],
    ['the Secret is missing', async () => undefined],
  ])('falls back to the mounted/env value when %s', async (_label, read) => {
    await expect(readStalwartCredentialsAuthoritative(staleEnv, read as never))
      .resolves.toEqual({ username: 'admin', password: 'OLD-password-from-the-stale-mount' });
  });

  it('still takes the username from env, not the Secret', async () => {
    const read = vi.fn(async () => ({ ADMIN_SECRET_PLAIN: b64('pw'), username: b64('ignored') }));
    const r = await readStalwartCredentialsAuthoritative(
      { ...staleEnv, STALWART_ADMIN_USER: 'recovery-admin' }, read,
    );
    expect(r.username).toBe('recovery-admin');
  });
});
