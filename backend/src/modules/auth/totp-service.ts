/**
 * Authenticator-app second factor (TOTP) for PASSWORD sign-in.
 *
 * A user with TOTP on signs in with password + a 6-digit code, or password +
 * one of their single-use backup codes. Passkey sign-in is separate and not
 * affected (a passkey is already two factors). Nobody is required to enable
 * TOTP (operator decision).
 *
 * Invariants:
 *   • Enrolment is two-step: setup stores the secret with enabled_at NULL,
 *     and only a correct code from the app turns it on — so a half-finished
 *     setup never locks anyone out.
 *   • The secret is encrypted at rest (PLATFORM_ENCRYPTION_KEY, AES-256-GCM).
 *   • A code is good once: the accepted time step is recorded with an atomic
 *     "step greater than the last one" update, which holds across replicas.
 *   • Attempts are counted per USER in the database (not per IP, not per
 *     replica), and RESERVED before a code is looked at: one conditional
 *     UPDATE takes an attempt from the allowance or refuses, so even
 *     concurrent requests on one pre-auth token never get more than
 *     MAX_FAILED_ATTEMPTS evaluated inside FAILED_WINDOW_MS. A right code
 *     gives the attempt back; a locked factor is not evaluated at all.
 *   • Backup codes are random, shown once, stored as HMAC-SHA256 under a key
 *     derived from PLATFORM_ENCRYPTION_KEY, and burned with an atomic update.
 */
import { createHmac, hkdfSync, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { userTotp, userTotpBackupCodes } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { decrypt, encrypt } from '../oidc/crypto.js';
import {
  TOTP_SECRET_BYTES,
  base32Decode,
  base32Encode,
  matchTotp,
  otpauthUri,
} from './totp-core.js';

export const MAX_FAILED_ATTEMPTS = 10;
export const FAILED_WINDOW_MS = 15 * 60 * 1000;
export const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;
/** No 0/O, 1/I/L: codes get typed from paper. 31 symbols × 10 ≈ 49.5 bits each. */
const BACKUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export type TotpProof = { readonly code: string } | { readonly backupCode: string };
export type TotpFactorUsed = 'code' | 'backup_code';

function backupCodeKey(encryptionKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(encryptionKey, 'hex'), Buffer.alloc(0), 'insula/totp-backup-codes', 32));
}

export function normalizeBackupCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

function hashBackupCode(encryptionKey: string, code: string): string {
  return createHmac('sha256', backupCodeKey(encryptionKey)).update(normalizeBackupCode(code)).digest('hex');
}

function newBackupCode(): string {
  let raw = '';
  for (let i = 0; i < BACKUP_CODE_LENGTH; i += 1) raw += BACKUP_CODE_ALPHABET[randomInt(BACKUP_CODE_ALPHABET.length)];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

async function replaceBackupCodes(db: Database, encryptionKey: string, userId: string): Promise<string[]> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, newBackupCode);
  await db.delete(userTotpBackupCodes).where(eq(userTotpBackupCodes.userId, userId));
  await db.insert(userTotpBackupCodes).values(codes.map((c) => ({
    id: randomUUID(), userId, codeHash: hashBackupCode(encryptionKey, c),
  })));
  return codes;
}

async function loadRow(db: Database, userId: string) {
  const [row] = await db.select().from(userTotp).where(eq(userTotp.userId, userId)).limit(1);
  return row ?? null;
}

export async function isTotpEnabled(db: Database, userId: string): Promise<boolean> {
  const row = await loadRow(db, userId);
  return Boolean(row?.enabledAt);
}

export async function getTotpStatus(db: Database, userId: string): Promise<{
  enabled: boolean; enabledAt: string | null; backupCodesRemaining: number;
}> {
  const row = await loadRow(db, userId);
  if (!row?.enabledAt) return { enabled: false, enabledAt: null, backupCodesRemaining: 0 };
  const [{ n }] = await db.select({ n: count() }).from(userTotpBackupCodes)
    .where(and(eq(userTotpBackupCodes.userId, userId), isNull(userTotpBackupCodes.usedAt)));
  return { enabled: true, enabledAt: row.enabledAt.toISOString(), backupCodesRemaining: Number(n) };
}

/** Start (or restart) enrolment with a fresh secret. Refused while TOTP is on. */
export async function beginTotpSetup(
  db: Database,
  encryptionKey: string,
  input: { readonly userId: string; readonly account: string; readonly issuer: string },
): Promise<{ secret: string; otpauthUri: string }> {
  const existing = await loadRow(db, input.userId);
  if (existing?.enabledAt) {
    throw new ApiError('TOTP_ALREADY_ENABLED', 'Two-step sign-in is already on. Turn it off first to set up a new app.', 409);
  }
  const secret = randomBytes(TOTP_SECRET_BYTES);
  const secretB32 = base32Encode(secret);
  const secretEncrypted = encrypt(secretB32, encryptionKey);
  await db.insert(userTotp).values({ userId: input.userId, secretEncrypted })
    .onConflictDoUpdate({
      target: userTotp.userId,
      set: { secretEncrypted, enabledAt: null, lastUsedStep: null, failedAttempts: 0, failedWindowStartedAt: null, updatedAt: new Date() },
    });
  return { secret: secretB32, otpauthUri: otpauthUri({ issuer: input.issuer, account: input.account, secret }) };
}

/**
 * Take one attempt from the user's allowance — atomically, BEFORE the code is
 * evaluated. Postgres re-checks the WHERE against the newest row version after
 * waiting on the row lock, so concurrent requests serialise here and at most
 * MAX_FAILED_ATTEMPTS pass per window. (Checking first and counting a failure
 * afterwards let 30 parallel guesses all through.) Returns false when locked.
 */
async function reserveAttempt(db: Database, userId: string, nowMs: number): Promise<boolean> {
  const now = new Date(nowMs);
  const windowFloor = new Date(nowMs - FAILED_WINDOW_MS);
  const windowOver = sql`(${userTotp.failedWindowStartedAt} IS NULL OR ${userTotp.failedWindowStartedAt} < ${windowFloor})`;
  const rows = await db.update(userTotp).set({
    failedAttempts: sql`CASE WHEN ${windowOver} THEN 1 ELSE ${userTotp.failedAttempts} + 1 END`,
    failedWindowStartedAt: sql`CASE WHEN ${windowOver} THEN ${now} ELSE ${userTotp.failedWindowStartedAt} END`,
    updatedAt: now,
  }).where(and(
    eq(userTotp.userId, userId),
    sql`(${windowOver} OR ${userTotp.failedAttempts} < ${MAX_FAILED_ATTEMPTS})`,
  )).returning({ userId: userTotp.userId });
  return rows.length === 1;
}

async function lockedError(db: Database, userId: string, nowMs: number): Promise<ApiError> {
  const row = await loadRow(db, userId);
  const windowStart = row?.failedWindowStartedAt?.getTime() ?? nowMs;
  const retryAfter = Math.max(1, Math.ceil((windowStart + FAILED_WINDOW_MS - nowMs) / 1000));
  return new ApiError('TOTP_LOCKED', 'Too many wrong codes. Try again later.', 429, { retry_after: retryAfter });
}

/** A right code gives back the attempts this window used. */
async function clearAttempts(db: Database, userId: string, nowMs: number): Promise<void> {
  await db.update(userTotp).set({ failedAttempts: 0, failedWindowStartedAt: null, updatedAt: new Date(nowMs) })
    .where(eq(userTotp.userId, userId));
}

const wrongCode = () => new ApiError('TOTP_CODE_INVALID', 'That code is not right. Check the app and try again.', 401);

/**
 * Accept a code for `step` only if no code at that step or later was accepted
 * before — one conditional UPDATE, so two replicas cannot both accept it.
 */
async function claimStep(db: Database, userId: string, step: number, nowMs: number): Promise<boolean> {
  const rows = await db.update(userTotp)
    .set({ lastUsedStep: step, failedAttempts: 0, failedWindowStartedAt: null, updatedAt: new Date(nowMs) })
    .where(and(eq(userTotp.userId, userId), sql`(${userTotp.lastUsedStep} IS NULL OR ${userTotp.lastUsedStep} < ${step})`))
    .returning({ userId: userTotp.userId });
  return rows.length === 1;
}

/**
 * Check a live code or a backup code for a user whose TOTP is ON. On a wrong
 * proof the failure is counted and TOTP_CODE_INVALID thrown; on success the
 * code's step (or the backup code) is used up and the counter reset.
 */
export async function verifyTotpFactor(
  db: Database,
  encryptionKey: string,
  userId: string,
  proof: TotpProof,
  nowMs: number = Date.now(),
): Promise<TotpFactorUsed> {
  const row = await loadRow(db, userId);
  if (!row?.enabledAt) {
    throw new ApiError('TOTP_NOT_ENABLED', 'Two-step sign-in is not on for this account.', 409);
  }
  if (!(await reserveAttempt(db, userId, nowMs))) throw await lockedError(db, userId, nowMs);

  if ('code' in proof) {
    const secret = base32Decode(decrypt(row.secretEncrypted, encryptionKey));
    const step = matchTotp(secret, proof.code, nowMs);
    // claimStep also clears the attempts. A replayed code stays counted: it proves nothing new.
    if (step === null || !(await claimStep(db, userId, step, nowMs))) throw wrongCode();
    return 'code';
  }

  const burned = await db.update(userTotpBackupCodes)
    .set({ usedAt: new Date(nowMs) })
    .where(and(
      eq(userTotpBackupCodes.userId, userId),
      eq(userTotpBackupCodes.codeHash, hashBackupCode(encryptionKey, proof.backupCode)),
      isNull(userTotpBackupCodes.usedAt),
    ))
    .returning({ id: userTotpBackupCodes.id });
  if (burned.length !== 1) throw wrongCode();
  await clearAttempts(db, userId, nowMs);
  return 'backup_code';
}

/** Turn TOTP on with a code from the app; returns the backup codes (shown once). */
export async function enableTotp(
  db: Database,
  encryptionKey: string,
  userId: string,
  code: string,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const row = await loadRow(db, userId);
  if (!row) throw new ApiError('TOTP_SETUP_REQUIRED', 'Start the setup first.', 409);
  if (row.enabledAt) throw new ApiError('TOTP_ALREADY_ENABLED', 'Two-step sign-in is already on.', 409);
  if (!(await reserveAttempt(db, userId, nowMs))) throw await lockedError(db, userId, nowMs);
  const secret = base32Decode(decrypt(row.secretEncrypted, encryptionKey));
  const step = matchTotp(secret, code, nowMs);
  if (step === null) throw wrongCode();
  const turnedOn = await db.update(userTotp)
    .set({ enabledAt: new Date(nowMs), lastUsedStep: step, failedAttempts: 0, failedWindowStartedAt: null, updatedAt: new Date(nowMs) })
    .where(and(eq(userTotp.userId, userId), isNull(userTotp.enabledAt)))
    .returning({ userId: userTotp.userId });
  if (turnedOn.length !== 1) throw new ApiError('TOTP_ALREADY_ENABLED', 'Two-step sign-in is already on.', 409);
  return replaceBackupCodes(db, encryptionKey, userId);
}

/** Turn TOTP off — needs a live code or a backup code, so a hijacked session alone cannot. */
export async function disableTotp(
  db: Database, encryptionKey: string, userId: string, proof: TotpProof, nowMs: number = Date.now(),
): Promise<void> {
  await verifyTotpFactor(db, encryptionKey, userId, proof, nowMs);
  await clearTotp(db, userId);
}

/** New backup codes, old ones void — needs a live code or a backup code. */
export async function regenerateBackupCodes(
  db: Database, encryptionKey: string, userId: string, proof: TotpProof, nowMs: number = Date.now(),
): Promise<string[]> {
  await verifyTotpFactor(db, encryptionKey, userId, proof, nowMs);
  return replaceBackupCodes(db, encryptionKey, userId);
}

/** Remove TOTP and its backup codes. Returns whether the user had it ON. */
export async function clearTotp(db: Database, userId: string): Promise<boolean> {
  await db.delete(userTotpBackupCodes).where(eq(userTotpBackupCodes.userId, userId));
  const removed = await db.delete(userTotp).where(eq(userTotp.userId, userId))
    .returning({ enabledAt: userTotp.enabledAt });
  return Boolean(removed[0]?.enabledAt);
}
