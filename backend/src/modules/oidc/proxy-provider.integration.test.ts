/**
 * The panel OAuth2 Proxy provider rules, against a real Postgres: the save
 * validation that used to accept "protect" with no working proxy behind it, the
 * guards that keep a proxy's provider from vanishing under it, the login page's
 * `proxyProviderId`, and migration 0147's backfill.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { oidcProviders, oidcGlobalSettings } from '../../db/schema.js';
import * as service from './service.js';
import { encrypt } from './crypto.js';

const dbAvailable = await isDbAvailable();
const KEY = '0'.repeat(64);
const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const GOOGLE = '00000000-0000-4000-8000-0000000000b1';
const ACCOUNTS = '00000000-0000-4000-8000-0000000000b2';
const DISABLED = '00000000-0000-4000-8000-0000000000b3';

describe.skipIf(!dbAvailable)('panel OAuth2 Proxy provider (integration)', () => {
  const db = () => getTestDb();
  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await db().execute(sql.raw('TRUNCATE TABLE oidc_global_settings, oidc_providers CASCADE'));
    const provider = (id: string, panelScope: 'admin' | 'tenant', enabled: number, displayName: string) => ({
      id, displayName, issuerUrl: 'https://id.example.test', clientId: `client-${id.slice(-2)}`,
      clientSecretEncrypted: encrypt('secret', KEY), panelScope, enabled,
    });
    await db().insert(oidcProviders).values([
      provider(ADMIN, 'admin', 1, 'Admin SSO'),
      provider(GOOGLE, 'tenant', 1, 'Google'),
      provider(ACCOUNTS, 'tenant', 1, 'Accounts'),
      provider(DISABLED, 'tenant', 0, 'Old'),
    ] as Array<typeof oidcProviders.$inferInsert>);
  });

  async function rejects(p: Promise<unknown>, code: string) {
    await expect(p).rejects.toMatchObject({ code });
  }

  it('refuses protection without a provider, or with one that cannot serve the panel', async () => {
    await rejects(service.saveGlobalSettings(db(), { proxy_protect_tenant: true }, KEY), 'PROXY_PROVIDER_REQUIRED');
    await rejects(service.saveGlobalSettings(db(), { proxy_protect_tenant: true, proxy_tenant_provider_id: ADMIN }, KEY), 'PROXY_PROVIDER_INVALID');
    await rejects(service.saveGlobalSettings(db(), { proxy_protect_tenant: true, proxy_tenant_provider_id: DISABLED }, KEY), 'PROXY_PROVIDER_INVALID');
    expect((await service.getGlobalSettings(db())).protectTenantViaProxy).toBe(false);
  });

  it('saves the chosen provider and hands it to the login page for the automatic sign-in', async () => {
    const saved = await service.saveGlobalSettings(db(), { proxy_protect_tenant: true, proxy_tenant_provider_id: ACCOUNTS }, KEY);
    expect(saved).toMatchObject({ protectTenantViaProxy: true, proxyTenantProviderId: ACCOUNTS });
    const status = await service.getAuthStatus(db(), 'tenant');
    expect(status.proxyProtected).toBe(true);
    expect(status.proxyProviderId).toBe(ACCOUNTS);
    // Both tenant providers are still offered on the page.
    expect(status.providers.map((p) => p.id).sort()).toEqual([ACCOUNTS, GOOGLE].sort());
    expect((await service.getAuthStatus(db(), 'admin')).proxyProviderId).toBeNull();
    const proxy = await service.loadPanelProxyProvider(db(), ACCOUNTS, KEY);
    expect(proxy).toEqual({ issuerUrl: 'https://id.example.test', clientId: 'client-b2', clientSecret: 'secret' });
  });

  it('will not delete, disable or move the provider a live proxy signs in with', async () => {
    await service.saveGlobalSettings(db(), { proxy_protect_tenant: true, proxy_tenant_provider_id: ACCOUNTS }, KEY);
    await rejects(service.deleteProvider(db(), ACCOUNTS), 'PROXY_PROVIDER_IN_USE');
    await rejects(service.updateProvider(db(), ACCOUNTS, { enabled: false }, KEY), 'PROXY_PROVIDER_IN_USE');
    await rejects(service.updateProvider(db(), ACCOUNTS, { panel_scope: 'admin' }, KEY), 'PROXY_PROVIDER_IN_USE');
    // Harmless edits and the OTHER provider are unaffected.
    await service.updateProvider(db(), ACCOUNTS, { display_name: 'Accounts (EU)' }, KEY);
    await service.deleteProvider(db(), GOOGLE);
    // Once protection is off the provider is free again.
    await service.saveGlobalSettings(db(), { proxy_protect_tenant: false }, KEY);
    await service.deleteProvider(db(), ACCOUNTS);
    expect((await service.getGlobalSettings(db())).proxyTenantProviderId).toBeNull(); // ON DELETE SET NULL
  });

  it('restores the proxy fields when enabling fails on the cluster', async () => {
    const before = await service.getGlobalSettings(db());
    await service.saveGlobalSettings(db(), { proxy_protect_tenant: true, proxy_tenant_provider_id: GOOGLE }, KEY);
    await service.restoreProxySettings(db(), before);
    expect(await service.getGlobalSettings(db())).toMatchObject({ protectTenantViaProxy: false, proxyTenantProviderId: null });
  });

  describe('migration 0147 backfill', () => {
    const migration = readFileSync(
      fileURLToPath(new URL('../../db/migrations/0147_oidc_proxy_provider.sql', import.meta.url)), 'utf8');

    async function settingsRow(protectAdmin: number, protectTenant: number) {
      await db().insert(oidcGlobalSettings).values({
        id: 'settings-1', protectAdminViaProxy: protectAdmin, protectTenantViaProxy: protectTenant,
      } as typeof oidcGlobalSettings.$inferInsert);
    }

    it('adopts the only enabled provider and switches off a panel with several (idempotent re-run)', async () => {
      await settingsRow(1, 1); // admin: one enabled provider; tenant: two
      await db().execute(sql.raw(migration));
      await db().execute(sql.raw(migration));
      expect(await service.getGlobalSettings(db())).toMatchObject({
        protectAdminViaProxy: true, proxyAdminProviderId: ADMIN,
        protectTenantViaProxy: false, proxyTenantProviderId: null,
      });
    });

    it('leaves an unprotected panel untouched', async () => {
      await settingsRow(0, 0);
      await db().execute(sql.raw(migration));
      expect(await service.getGlobalSettings(db())).toMatchObject({
        protectAdminViaProxy: false, proxyAdminProviderId: null, protectTenantViaProxy: false,
      });
    });
  });
});
