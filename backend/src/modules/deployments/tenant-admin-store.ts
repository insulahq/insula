/**
 * Where the tenant administrator's password lives (database_admin_accounts).
 *
 * The platform is the password's source of truth: tenant-admin.ts sets the
 * account back to it when the database disagrees, and the panel's rotate
 * writes a new one here first. AES-256-GCM with PLATFORM_ENCRYPTION_KEY, as
 * every other credential the platform keeps (oidc/crypto.ts).
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { databaseAdminAccounts } from '../../db/schema.js';
import { decrypt, encrypt } from '../oidc/crypto.js';
import { randomInt } from 'node:crypto';
import type { TenantAdminAccount } from './tenant-admin.js';

/** [a-zA-Z0-9_-]: safe in SQL literals, shells, URLs and connection strings alike. */
const PASSWORD_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';

/** A fresh tenant administrator password, 32 characters (~192 bits). */
export function newTenantAdminPassword(): string {
  let out = '';
  for (let i = 0; i < 32; i++) out += PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)];
  return out;
}

export async function loadTenantAdminAccount(
  db: Database,
  deploymentId: string,
  encryptionKey: string,
): Promise<TenantAdminAccount | null> {
  const [row] = await db.select().from(databaseAdminAccounts).where(eq(databaseAdminAccounts.deploymentId, deploymentId));
  if (!row) return null;
  return { username: row.username, password: decrypt(row.passwordCipher, encryptionKey) };
}

export async function saveTenantAdminAccount(
  db: Database,
  deploymentId: string,
  account: TenantAdminAccount,
  encryptionKey: string,
  opts: { readonly rotated?: boolean } = {},
): Promise<void> {
  const passwordCipher = encrypt(account.password, encryptionKey);
  await db.insert(databaseAdminAccounts)
    .values({ deploymentId, username: account.username, passwordCipher })
    .onConflictDoUpdate({
      target: databaseAdminAccounts.deploymentId,
      set: { username: account.username, passwordCipher, ...(opts.rotated ? { rotatedAt: new Date() } : {}) },
    });
}

/**
 * Record the first account for an instance — or, when another run recorded
 * one first, return that one. Two runs setting up the same new instance at
 * once (the scheduler and the credentials view) agree on one account.
 */
export async function recordFirstTenantAdminAccount(
  db: Database,
  deploymentId: string,
  candidate: TenantAdminAccount,
  encryptionKey: string,
): Promise<TenantAdminAccount> {
  await db.insert(databaseAdminAccounts)
    .values({ deploymentId, username: candidate.username, passwordCipher: encrypt(candidate.password, encryptionKey) })
    .onConflictDoNothing({ target: databaseAdminAccounts.deploymentId });
  return (await loadTenantAdminAccount(db, deploymentId, encryptionKey)) ?? candidate;
}

/** The account has been set up in the database at least once (ready_at). */
export async function tenantAdminReady(db: Database, deploymentId: string): Promise<boolean> {
  const [row] = await db.select({ readyAt: databaseAdminAccounts.readyAt }).from(databaseAdminAccounts)
    .where(eq(databaseAdminAccounts.deploymentId, deploymentId));
  return Boolean(row?.readyAt);
}

/** Stamp ready_at, once. */
export async function markTenantAdminReady(db: Database, deploymentId: string, at: Date): Promise<void> {
  await db.update(databaseAdminAccounts).set({ readyAt: at })
    .where(and(eq(databaseAdminAccounts.deploymentId, deploymentId), isNull(databaseAdminAccounts.readyAt)));
}
