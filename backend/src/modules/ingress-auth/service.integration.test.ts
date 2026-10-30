/**
 * Route sign-in settings against a REAL Postgres: what a save actually writes
 * and refuses, and which routes the gate serves.
 *
 * Runs in the integration suite (DATABASE_URL). Tables live in this file's own
 * schema.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ingressAuthConfigPatchSchema, ingressAuthConfigSchema, oidcProviderUpdateSchema } from '@insula/api-contracts';
import { getAuthConfig, listEnabledForTenant, upsertAuthConfig } from './service.js';
import { createProvider, listProviders, updateProvider } from './providers-service.js';

const url = process.env.DATABASE_URL;
const KEY = { encryptionKey: 'a'.repeat(64) };
const T = 'tttttttt-0000-4000-8000-00000000000a';
const input = (over: Record<string, unknown>) => ingressAuthConfigSchema.parse({ enabled: true, ...over });

describe.skipIf(!url)('route sign-in settings (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, options: '-c search_path=route_oidc_test', max: 4 });
    await pool.query('DROP SCHEMA IF EXISTS route_oidc_test CASCADE');
    await pool.query('CREATE SCHEMA route_oidc_test');
    await pool.query(`CREATE TABLE tenants (id varchar(36) PRIMARY KEY, status text NOT NULL, kubernetes_namespace text NOT NULL)`);
    await pool.query(`CREATE TABLE domains (id varchar(36) PRIMARY KEY, tenant_id varchar(36) NOT NULL, domain_name text NOT NULL)`);
    await pool.query(`CREATE TABLE ingress_routes (id varchar(36) PRIMARY KEY, domain_id varchar(36) NOT NULL,
      hostname text NOT NULL, www_redirect text NOT NULL DEFAULT 'none', status text NOT NULL DEFAULT 'active')`);
    await pool.query(`CREATE TABLE tenant_oidc_providers (id varchar(36) PRIMARY KEY, tenant_id varchar(36) NOT NULL,
      name varchar(120) NOT NULL, issuer_url varchar(500) NOT NULL, oauth_client_id varchar(255) NOT NULL,
      oauth_client_secret_encrypted text NOT NULL, use_pkce boolean NOT NULL DEFAULT true,
      default_scopes varchar(500) NOT NULL DEFAULT 'openid profile email',
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE ingress_auth_configs (id varchar(36) PRIMARY KEY, ingress_route_id varchar(36) NOT NULL UNIQUE,
      enabled boolean NOT NULL DEFAULT false, provider_id varchar(36) NOT NULL REFERENCES tenant_oidc_providers(id),
      post_login_redirect_url varchar(2048), allowed_emails text, allowed_email_domains text, allowed_groups text,
      claim_rules jsonb, pass_authorization_header boolean NOT NULL DEFAULT false, pass_access_token boolean NOT NULL DEFAULT false,
      pass_id_token boolean NOT NULL DEFAULT false, pass_user_headers boolean NOT NULL DEFAULT true,
      set_xauthrequest boolean NOT NULL DEFAULT true, cookie_domain varchar(255),
      cookie_refresh_seconds integer NOT NULL DEFAULT 0, cookie_expire_seconds integer NOT NULL DEFAULT 86400,
      last_error text, last_reconciled_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now())`);
    db = drizzle(pool, { schema }) as unknown as Database;
  });

  afterAll(async () => {
    await pool?.query('DROP SCHEMA IF EXISTS route_oidc_test CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE tenants, domains, ingress_routes, ingress_auth_configs, tenant_oidc_providers');
    await pool.query("INSERT INTO tenants VALUES ($1, 'active', 'tenant-a')", [T]);
    await pool.query("INSERT INTO domains VALUES ('dom-1', $1, 'example.test')", [T]);
    await pool.query(`INSERT INTO ingress_routes (id, domain_id, hostname, www_redirect) VALUES
      ('r-app', 'dom-1', 'app.example.test', 'none'),
      ('r-site', 'dom-1', 'example.test', 'add-www'),
      ('r-wild', 'dom-1', '*.example.test', 'none')`);
  });

  const inline = { issuerUrl: 'https://accounts.example.test', clientId: 'client-1', clientSecret: 'secret-1' };

  it('★ inline credentials (clientId / clientSecret, as the panel sends them) create the provider', async () => {
    const res = await upsertAuthConfig(db, KEY, T, 'r-app', input(inline));
    expect(res).toMatchObject({ enabled: true, issuerUrl: 'https://accounts.example.test', clientId: 'client-1', clientSecretSet: true });
    expect(res.providerName).toBe('Created for app.example.test');
    expect(res.callbackUrl).toBe('https://app.example.test/oauth2/callback');
  });

  it('inline credentials on a route create a NEW provider; the shared one is left alone', async () => {
    const shared = await createProvider(db, KEY, T, { name: 'Shared', issuerUrl: 'https://idp.example.test', oauthClientId: 'shared', oauthClientSecret: 's' });
    await upsertAuthConfig(db, KEY, T, 'r-app', input({ enabled: false, providerId: shared.id }));
    await upsertAuthConfig(db, KEY, T, 'r-app', input({ enabled: false, ...inline }));
    const providers = await listProviders(db, T);
    expect(providers.find((p) => p.id === shared.id)).toMatchObject({ oauthClientId: 'shared', consumerCount: 0 });
    expect(providers).toHaveLength(2);
  });

  it('★ a second provider among the tenant\'s enabled routes is refused, naming the other route', async () => {
    await upsertAuthConfig(db, KEY, T, 'r-app', input(inline));
    const other = await createProvider(db, KEY, T, { name: 'Other', issuerUrl: 'https://idp2.example.test', oauthClientId: 'o', oauthClientSecret: 's' });
    await expect(upsertAuthConfig(db, KEY, T, 'r-site', input({ providerId: other.id })))
      .rejects.toMatchObject({ code: 'OIDC_PROVIDER_CONFLICT', status: 409, message: expect.stringContaining('app.example.test') });
    // The same provider is fine, and a disabled route never conflicts.
    const first = (await getAuthConfig(db, 'r-app'))!.providerId;
    await expect(upsertAuthConfig(db, KEY, T, 'r-site', input({ providerId: first }))).resolves.toBeTruthy();
    await expect(upsertAuthConfig(db, KEY, T, 'r-site', input({ enabled: false, providerId: other.id }))).resolves.toBeTruthy();
  });

  it('the redirect URI is on the host a www-redirect route serves', async () => {
    const res = await upsertAuthConfig(db, KEY, T, 'r-site', input(inline));
    expect(res.callbackUrl).toBe('https://www.example.test/oauth2/callback');
    expect((await listProviders(db, T))[0]!.callbackUrls).toEqual(['https://www.example.test/oauth2/callback']);
  });

  it('refuses a wildcard route, a cookie domain that does not cover the host, and a malformed allow list', async () => {
    await expect(upsertAuthConfig(db, KEY, T, 'r-wild', input(inline))).rejects.toMatchObject({ code: 'OIDC_WILDCARD_ROUTE' });
    await expect(upsertAuthConfig(db, KEY, T, 'r-app', input({ ...inline, cookieDomain: 'other.test' }))).rejects.toMatchObject({ status: 422 });
    await expect(upsertAuthConfig(db, KEY, T, 'r-app', input({ ...inline, cookieDomain: '.example.test' }))).resolves.toBeTruthy();
    await expect(upsertAuthConfig(db, KEY, T, 'r-app', input({ ...inline, allowedEmails: 'not-an-address' }))).rejects.toMatchObject({ status: 422 });
  });

  it('the gate serves enabled, active routes of a serving tenant, on their served host', async () => {
    await upsertAuthConfig(db, KEY, T, 'r-site', input(inline));
    const rows = await listEnabledForTenant(db, T);
    expect(rows.map((r) => [r.cfg.ingressRouteId, r.host])).toEqual([['r-site', 'www.example.test']]);
    await pool.query("UPDATE tenants SET status = 'archived'");
    expect(await listEnabledForTenant(db, T)).toEqual([]);
    await pool.query("UPDATE tenants SET status = 'active'; UPDATE ingress_routes SET status = 'pending'");
    expect(await listEnabledForTenant(db, T)).toEqual([]);
  });

  it('★ a PATCH that names only the provider keeps the allow lists (an API client cannot open the site by omission)', async () => {
    await upsertAuthConfig(db, KEY, T, 'r-app', input({ ...inline, allowedEmails: 'alice@example.test', claimRules: [{ claim: 'hd', operator: 'equals', value: 'example.test' }] }));
    const providerId = (await getAuthConfig(db, 'r-app'))!.providerId;
    const res = await upsertAuthConfig(db, KEY, T, 'r-app', ingressAuthConfigPatchSchema.parse({ enabled: true, providerId }));
    expect(res.allowedEmails).toBe('alice@example.test');
    expect(res.claimRules).toHaveLength(1);
    // null clears explicitly.
    const cleared = await upsertAuthConfig(db, KEY, T, 'r-app', ingressAuthConfigPatchSchema.parse({ allowedEmails: null }));
    expect(cleared.allowedEmails).toBeNull();
  });

  it('cookie domain and post-login page stay within the tenant\'s own domains and sites', async () => {
    // The tenant owns shop.shared.test only; .shared.test covers the host but is shared with others.
    await pool.query("INSERT INTO domains VALUES ('dom-2', $1, 'shop.shared.test')", [T]);
    await pool.query("INSERT INTO ingress_routes (id, domain_id, hostname) VALUES ('r-shop', 'dom-2', 'shop.shared.test')");
    await expect(upsertAuthConfig(db, KEY, T, 'r-shop', input({ ...inline, cookieDomain: '.shared.test' })))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining("not within one of this tenant's domains") });
    await expect(upsertAuthConfig(db, KEY, T, 'r-app', input({ ...inline, postLoginRedirectUrl: 'https://evil.test/' }))).rejects.toMatchObject({ status: 422 });
    await expect(upsertAuthConfig(db, KEY, T, 'r-app', input({ ...inline, postLoginRedirectUrl: 'https://www.example.test/home' }))).resolves.toBeTruthy();
  });

  it('★ two enables with different providers at the same time: exactly one wins', async () => {
    const a = await createProvider(db, KEY, T, { name: 'A', issuerUrl: 'https://a.example.test', oauthClientId: 'a', oauthClientSecret: 's' });
    const b = await createProvider(db, KEY, T, { name: 'B', issuerUrl: 'https://b.example.test', oauthClientId: 'b', oauthClientSecret: 's' });
    const results = await Promise.allSettled([
      upsertAuthConfig(db, KEY, T, 'r-app', input({ providerId: a.id })),
      upsertAuthConfig(db, KEY, T, 'r-site', input({ providerId: b.id })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'OIDC_PROVIDER_CONFLICT' });
  });

  it('★ a partial provider update keeps what it does not name', async () => {
    const p = await createProvider(db, KEY, T, { name: 'P', issuerUrl: 'https://idp.example.test', oauthClientId: 'c', oauthClientSecret: 's', usePkce: false, defaultScopes: 'openid email groups' });
    const patch = oidcProviderUpdateSchema.parse({ oauthClientSecret: 'rotated' });
    expect(patch).toEqual({ oauthClientSecret: 'rotated' });
    const after = await updateProvider(db, KEY, T, p.id, patch);
    expect(after).toMatchObject({ usePkce: false, defaultScopes: 'openid email groups', oauthClientId: 'c' });
  });
});
