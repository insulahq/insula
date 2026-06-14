import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { users, tenants } from '../../db/schema.js';
import { invalidToken } from '../../shared/errors.js';

const SALT_ROUNDS = 12;

// bcrypt is a NATIVE module. An eager `import bcrypt from 'bcrypt'` loads the
// .node binding at module-evaluation time — which crashes inside the
// `platform-ops` SEA binary (no node_modules on a bare host) for ANY command
// whose import graph transitively reaches this module, even one that never
// hashes (e.g. `domain rename` → oidc/service → here). Load it lazily + cache
// so the binding is required only when a hash/verify ACTUALLY runs. The backend
// (always has node_modules) is unaffected; the CLI's domain-rename path imports
// this module but never calls these functions. See ADR-045 / the R18 plan.
let bcryptModule: typeof import('bcrypt') | null = null;
async function bcryptLib(): Promise<typeof import('bcrypt')> {
  if (!bcryptModule) bcryptModule = await import('bcrypt');
  return bcryptModule;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // Support legacy SHA-256 hashes (64 char hex) for migration
  if (hash.length === 64 && /^[a-f0-9]+$/.test(hash)) {
    const { createHash } = await import('crypto');
    return createHash('sha256').update(password).digest('hex') === hash;
  }
  return (await bcryptLib()).compare(password, hash);
}

export async function hashNewPassword(password: string): Promise<string> {
  return (await bcryptLib()).hash(password, SALT_ROUNDS);
}

export async function authenticateUser(
  db: Database,
  email: string,
  password: string,
) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
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

  // Archived tenants are terminal — block login for any user attached to one.
  // Suspended is allowed (user still sees the suspension banner in tenant-panel
  // and can request reactivation); archived is irreversible and the data is
  // pending purge, so authenticating offers nothing useful.
  if (user.tenantId) {
    const [c] = await db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, user.tenantId))
      .limit(1);
    if (c && c.status === 'archived') {
      throw invalidToken();
    }
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
    // Passkey integration: caller decides whether to issue tokens
    // immediately (NULL or 'alternative') or to require a second
    // factor ('second_factor').
    passkeyMode: user.passkeyMode as 'alternative' | 'second_factor' | null,
  };
}
