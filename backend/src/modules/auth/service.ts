import { eq, sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import type { Database } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { invalidToken } from '../../shared/errors.js';
import { normalizeEmail } from '../../lib/email-normalize.js';

const SALT_ROUNDS = 12;

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // Support legacy SHA-256 hashes (64 char hex) for migration
  if (hash.length === 64 && /^[a-f0-9]+$/.test(hash)) {
    const { createHash } = await import('crypto');
    return createHash('sha256').update(password).digest('hex') === hash;
  }
  return bcrypt.compare(password, hash);
}

export async function hashNewPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function authenticateUser(
  db: Database,
  email: string,
  password: string,
) {
  // Case-insensitive, exact match preferred. Addresses are stored lowercased
  // (migration 0103) but a cluster upgraded mid-flight can still hold mixed
  // case, and operators type their address however they please.
  const lookupEmail = normalizeEmail(email);
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${lookupEmail}`)
    .orderBy(sql`(${users.email} = ${lookupEmail}) DESC`)
    .limit(1);

  if (!user) {
    throw invalidToken();
  }

  if (!user.passwordHash) {
    throw invalidToken();
  }

  if (!await verifyPassword(password, user.passwordHash)) {
    throw invalidToken();
  }

  if (user.status !== 'active') {
    throw invalidToken();
  }

  // An archived tenant is closed to its users. Suspended is allowed (the user
  // sees the suspension banner in the tenant panel and can ask for
  // reactivation). Said as it is, after the password checked out: the account
  // is closed, not the password wrong.
  if (user.tenantId) {
    const { assertTenantOpenForSignIn } = await import('../tenant-archive/sessions.js');
    await assertTenantOpenForSignIn(db, user.tenantId);
  }

  // Re-hash legacy SHA-256 passwords to bcrypt on successful login
  const isLegacyHash = user.passwordHash.length === 64 && /^[a-f0-9]+$/.test(user.passwordHash);
  const now = new Date();
  const updateValues: Record<string, unknown> = {
    lastLoginAt: now,
    lastCredentialCheckAt: now,
  };
  if (isLegacyHash) {
    updateValues.passwordHash = await hashNewPassword(password);
  }

  await db
    .update(users)
    .set(updateValues)
    .where(eq(users.id, user.id));

  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.roleName,
    panel: user.panel ?? 'admin',
    tenantId: user.tenantId ?? undefined,
    // Whether passkey sign-in is on; a password sign-in's second factor is
    // TOTP, checked by the login route (totp-service.ts).
    passkeyMode: user.passkeyMode as 'alternative' | 'second_factor' | null,
  };
}
