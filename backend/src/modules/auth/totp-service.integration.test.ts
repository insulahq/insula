/**
 * The TOTP factor against a real Postgres: enrolment, single use across the
 * replay barrier, backup codes, the per-user lockout, and the migration that
 * retires passkey-as-second-factor.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { users, userTotp, userTotpBackupCodes } from '../../db/schema.js';
import { base32Decode, totpAt } from './totp-core.js';
import {
  BACKUP_CODE_COUNT, FAILED_WINDOW_MS, MAX_FAILED_ATTEMPTS,
  beginTotpSetup, clearTotp, disableTotp, enableTotp, getTotpStatus, isTotpEnabled,
  regenerateBackupCodes, verifyTotpFactor,
} from './totp-service.js';

const skipIntegration = !await isDbAvailable();
const KEY = crypto.randomBytes(32).toString('hex');
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

describe.skipIf(skipIntegration)('TOTP second factor (integration)', () => {
  const userId = crypto.randomUUID();
  let db: ReturnType<typeof getTestDb>;
  let secret: Buffer;

  const errCode = async (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: string }) => e.code);

  beforeAll(async () => {
    await runMigrations();
    db = getTestDb();
    await db.insert(users).values({
      id: userId, email: `${userId}@test.local`, passwordHash: 'unused', fullName: 'T',
      roleName: 'admin', panel: 'admin', status: 'active',
    });
  });

  beforeEach(async () => {
    await clearTotp(db, userId);
    const setup = await beginTotpSetup(db, KEY, { userId, account: 'ada@example.test', issuer: 'Insula' });
    secret = base32Decode(setup.secret);
  });

  afterAll(async () => { await db.delete(users).where(eq(users.id, userId)); });

  it('stores the secret encrypted, and stays off until a code from the app confirms it', async () => {
    const [row] = await db.select().from(userTotp).where(eq(userTotp.userId, userId));
    expect(row.enabledAt).toBeNull();
    expect(row.secretEncrypted).not.toContain(secret.toString('hex'));
    expect(await isTotpEnabled(db, userId)).toBe(false);
    expect(await errCode(enableTotp(db, KEY, userId, '000000', T0))).toBe('TOTP_CODE_INVALID');
    expect(await isTotpEnabled(db, userId)).toBe(false);

    const codes = await enableTotp(db, KEY, userId, totpAt(secret, T0), T0);
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
    expect(codes.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c))).toBe(true);
    expect(await getTotpStatus(db, userId)).toMatchObject({ enabled: true, backupCodesRemaining: BACKUP_CODE_COUNT });
    const stored = await db.select({ h: userTotpBackupCodes.codeHash }).from(userTotpBackupCodes).where(eq(userTotpBackupCodes.userId, userId));
    expect(stored.some((r) => codes.some((c) => r.h.includes(c.replace('-', ''))))).toBe(false);
  });

  it('accepts a code once — the enabling code and a replay are refused, the next step works', async () => {
    await enableTotp(db, KEY, userId, totpAt(secret, T0), T0);
    // The code that turned it on is spent.
    expect(await errCode(verifyTotpFactor(db, KEY, userId, { code: totpAt(secret, T0) }, T0 + 1000))).toBe('TOTP_CODE_INVALID');
    const next = T0 + 30_000;
    expect(await verifyTotpFactor(db, KEY, userId, { code: totpAt(secret, next) }, next)).toBe('code');
    expect(await errCode(verifyTotpFactor(db, KEY, userId, { code: totpAt(secret, next) }, next + 2000))).toBe('TOTP_CODE_INVALID');
    // An OLDER step inside the window is refused too once a later one was used.
    expect(await errCode(verifyTotpFactor(db, KEY, userId, { code: totpAt(secret, T0) }, next + 2000))).toBe('TOTP_CODE_INVALID');
  });

  it('burns a backup code once, in any case or spacing the user types it', async () => {
    const codes = await enableTotp(db, KEY, userId, totpAt(secret, T0), T0);
    const typed = ` ${codes[3].toLowerCase().replace('-', ' ')} `;
    expect(await verifyTotpFactor(db, KEY, userId, { backupCode: typed }, T0 + 60_000)).toBe('backup_code');
    expect(await errCode(verifyTotpFactor(db, KEY, userId, { backupCode: codes[3] }, T0 + 61_000))).toBe('TOTP_CODE_INVALID');
    expect((await getTotpStatus(db, userId)).backupCodesRemaining).toBe(BACKUP_CODE_COUNT - 1);
  });

  it('locks the factor after too many wrong codes — even a right code is not evaluated — until the window ends', async () => {
    await enableTotp(db, KEY, userId, totpAt(secret, T0), T0);
    const t = T0 + 90_000;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      expect(await errCode(verifyTotpFactor(db, KEY, userId, { code: '000000' }, t + i))).toBe('TOTP_CODE_INVALID');
    }
    expect(await errCode(verifyTotpFactor(db, KEY, userId, { code: totpAt(secret, t) }, t + 100))).toBe('TOTP_LOCKED');
    expect(await errCode(verifyTotpFactor(db, KEY, userId, { backupCode: 'AAAAA-AAAAA' }, t + 100))).toBe('TOTP_LOCKED');
    const later = t + FAILED_WINDOW_MS + 1000;
    expect(await verifyTotpFactor(db, KEY, userId, { code: totpAt(secret, later) }, later)).toBe('code');
  });

  it('refuses a new setup while on; disabling needs a factor and removes everything', async () => {
    const codes = await enableTotp(db, KEY, userId, totpAt(secret, T0), T0);
    expect(await errCode(beginTotpSetup(db, KEY, { userId, account: 'a', issuer: 'b' }))).toBe('TOTP_ALREADY_ENABLED');
    expect(await errCode(disableTotp(db, KEY, userId, { code: '000000' }, T0 + 30_000))).toBe('TOTP_CODE_INVALID');
    expect(await isTotpEnabled(db, userId)).toBe(true);
    await disableTotp(db, KEY, userId, { backupCode: codes[0] }, T0 + 30_000);
    expect(await getTotpStatus(db, userId)).toEqual({ enabled: false, enabledAt: null, backupCodesRemaining: 0 });
    const left = await db.select().from(userTotpBackupCodes).where(eq(userTotpBackupCodes.userId, userId));
    expect(left).toHaveLength(0);
  });

  it('regenerating backup codes voids the old set', async () => {
    const old = await enableTotp(db, KEY, userId, totpAt(secret, T0), T0);
    const fresh = await regenerateBackupCodes(db, KEY, userId, { code: totpAt(secret, T0 + 30_000) }, T0 + 30_000);
    expect(fresh.some((c) => old.includes(c))).toBe(false);
    expect(await errCode(verifyTotpFactor(db, KEY, userId, { backupCode: old[1] }, T0 + 31_000))).toBe('TOTP_CODE_INVALID');
    expect(await verifyTotpFactor(db, KEY, userId, { backupCode: fresh[1] }, T0 + 32_000)).toBe('backup_code');
  });

  it('a factor that is not on cannot be verified — a pending setup does not count', async () => {
    expect(await errCode(verifyTotpFactor(db, KEY, userId, { code: totpAt(secret, T0) }, T0))).toBe('TOTP_NOT_ENABLED');
  });
});

describe.skipIf(skipIntegration)('migration 0151 retires passkey-as-second-factor', () => {
  it('turns second_factor users into plain passkey users and is safe to re-run', async () => {
    await runMigrations();
    const db = getTestDb();
    const id = crypto.randomUUID();
    await db.insert(users).values({
      id, email: `${id}@test.local`, passwordHash: 'unused', fullName: 'P', roleName: 'admin', panel: 'admin',
      status: 'active', passkeyMode: 'second_factor',
    });
    const file = path.resolve(__dirname, '../../db/migrations/0151_totp_second_factor.sql');
    await db.execute(sql.raw(fs.readFileSync(file, 'utf8')));
    const [row] = await db.select({ mode: users.passkeyMode }).from(users).where(eq(users.id, id));
    expect(row.mode).toBe('alternative');
    await db.delete(users).where(eq(users.id, id));
  });
});
