/**
 * Break-glass sign-in against a real Postgres: right secret + right password
 * gets an active admin in; a DISABLED admin stays out even with both.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { oidcGlobalSettings, users } from '../../db/schema.js';
import { breakGlassLogin } from './service.js';

const skipIntegration = !await isDbAvailable();

describe.skipIf(skipIntegration)('break-glass sign-in (integration)', () => {
  const userId = crypto.randomUUID();
  const email = `${userId}@test.local`;
  let db: ReturnType<typeof getTestDb>;
  let settingsBefore: Array<typeof oidcGlobalSettings.$inferSelect>;

  beforeAll(async () => {
    await runMigrations();
    db = getTestDb();
    settingsBefore = await db.select().from(oidcGlobalSettings);
    const secretHash = await bcrypt.hash('emergency-secret', 4);
    if (settingsBefore.length === 0) {
      await db.insert(oidcGlobalSettings).values({ id: crypto.randomUUID(), breakGlassSecretHash: secretHash });
    } else {
      await db.update(oidcGlobalSettings).set({ breakGlassSecretHash: secretHash });
    }
    await db.insert(users).values({
      id: userId, email, passwordHash: await bcrypt.hash('pw-123', 4), fullName: 'BG',
      roleName: 'super_admin', panel: 'admin', status: 'active',
    });
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, userId));
    if (settingsBefore.length === 0) await db.delete(oidcGlobalSettings);
    else await db.update(oidcGlobalSettings).set({ breakGlassSecretHash: settingsBefore[0].breakGlassSecretHash });
  });

  it('lets an active admin in with the secret and the password', async () => {
    await expect(breakGlassLogin(db, email, 'pw-123', 'emergency-secret')).resolves.toMatchObject({ id: userId });
  });

  it('keeps a disabled admin out, secret or not', async () => {
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, userId));
    await expect(breakGlassLogin(db, email, 'pw-123', 'emergency-secret')).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });
});
