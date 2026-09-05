import { describe, it, expect, vi } from 'vitest';
import { encrypt, decrypt } from './crypto.js';
import { generatePkce, parseLogoutToken, findOrCreateOidcUser, isLocalAuthDisabled, getGlobalSettings, fetchDiscovery } from './service.js';

describe('OIDC crypto', () => {
  const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('should encrypt and decrypt a secret', () => {
    const plaintext = 'my-super-secret-tenant-secret';
    const encrypted = encrypt(plaintext, key);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toContain(':');
    expect(decrypt(encrypted, key)).toBe(plaintext);
  });

  it('should produce different ciphertext each time (random IV)', () => {
    const plaintext = 'same-input';
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe(plaintext);
    expect(decrypt(b, key)).toBe(plaintext);
  });
});

describe('generatePkce', () => {
  it('should return code_verifier and code_challenge', () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    expect(codeVerifier).toBeTruthy();
    expect(codeChallenge).toBeTruthy();
    expect(codeVerifier).not.toBe(codeChallenge);
  });

  it('should generate different values each call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe('parseLogoutToken', () => {
  function makeLogoutToken(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${payload}.fake-signature`;
  }

  it('should parse a valid backchannel logout token', () => {
    const token = makeLogoutToken({
      sub: 'user-123', iss: 'https://dex.example.com',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    });
    const claims = parseLogoutToken(token);
    expect(claims.sub).toBe('user-123');
  });

  it('should reject token without backchannel-logout event', () => {
    const token = makeLogoutToken({ sub: 'user-123', iss: 'https://dex', events: {} });
    expect(() => parseLogoutToken(token)).toThrow('Not a backchannel logout token');
  });

  it('should reject token without sub or sid', () => {
    const token = makeLogoutToken({
      iss: 'https://dex',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    });
    expect(() => parseLogoutToken(token)).toThrow('must contain sub or sid');
  });

  it('should reject malformed tokens', () => {
    expect(() => parseLogoutToken('onlyone')).toThrow('Invalid logout token format');
  });
});

describe('getGlobalSettings', () => {
  it('should return defaults when no settings exist', async () => {
    const db = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockResolvedValue([]) }),
    } as unknown as Parameters<typeof getGlobalSettings>[0];

    const result = await getGlobalSettings(db);
    expect(result.disableLocalAuthAdmin).toBe(false);
    expect(result.disableLocalAuthTenant).toBe(false);
    expect(result.hasBreakGlassSecret).toBe(false);
  });
});

describe('isLocalAuthDisabled', () => {
  it('should return false when no settings', async () => {
    const db = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockResolvedValue([]) }),
    } as unknown as Parameters<typeof isLocalAuthDisabled>[0];

    expect(await isLocalAuthDisabled(db, 'admin')).toBe(false);
    expect(await isLocalAuthDisabled(db, 'tenant')).toBe(false);
  });
});

describe('findOrCreateOidcUser', () => {
  const makeProvider = (overrides: Record<string, unknown> = {}) => ({
    id: 'prov-1',
    displayName: 'Test Provider',
    issuerUrl: 'https://dex',
    tenantId: 'tenant-id',
    clientSecretEncrypted: 'encrypted',
    panelScope: 'admin' as const,
    enabled: 1,
    backchannelLogoutEnabled: 0,
    autoProvision: 1,
    defaultRole: null as string | null,
    additionalClaims: null as string[] | null,
    discoveryMetadata: null as Record<string, unknown> | null,
    displayOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  it('should return existing user when matched by OIDC subject', async () => {
    const existingUser = { id: 'u1', email: 'test@example.com', oidcIssuer: 'https://dex', oidcSubject: 'sub-1' };
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([existingUser]);
      return Promise.resolve([]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = { select: selectFn, update: updateFn } as unknown as Parameters<typeof findOrCreateOidcUser>[0];

    const result = await findOrCreateOidcUser(db, {
      sub: 'sub-1', iss: 'https://dex', email: 'test@example.com',
      aud: 'hosting-platform', exp: 9999999999, iat: 1000000000,
    }, makeProvider());

    expect(result).toEqual(existingUser);
    expect(updateFn).toHaveBeenCalled();
  });

  it('should throw OIDC_USER_NOT_FOUND when autoProvision is disabled and user not found (admin)', async () => {
    const whereFn = vi.fn().mockResolvedValue([]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = { select: selectFn } as unknown as Parameters<typeof findOrCreateOidcUser>[0];

    await expect(findOrCreateOidcUser(db, {
      sub: 'sub-new', iss: 'https://dex', email: 'new@example.com',
      aud: 'hosting-platform', exp: 9999999999, iat: 1000000000,
    }, makeProvider({ autoProvision: 0 }))).rejects.toThrow('Your account is not registered on this platform');
  });

  it('should throw OIDC_USER_NOT_FOUND when autoProvision is disabled and user not found (client)', async () => {
    const whereFn = vi.fn().mockResolvedValue([]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = { select: selectFn } as unknown as Parameters<typeof findOrCreateOidcUser>[0];

    await expect(findOrCreateOidcUser(db, {
      sub: 'sub-new', iss: 'https://dex', email: 'new@example.com',
      aud: 'hosting-platform', exp: 9999999999, iat: 1000000000,
    }, makeProvider({ panelScope: 'tenant', autoProvision: 0 }))).rejects.toThrow('Your account is not registered on this platform');
  });
  // ── Cross-panel identity leak ─────────────────────────────────────────
  // The subject+issuer lookup runs FIRST and, unlike the email lookup right
  // after it, was not scoped to the panel being signed into. Combined with a
  // GLOBAL users_oidc_unique index, one IdP identity could be linked to only
  // one user row platform-wide — so a tenant-panel sign-in resolved to
  // whichever account linked that identity first, admin included. routes.ts
  // mints the JWT straight from this row (`panel`, `tenantId`), so the tenant
  // panel evaluated exactly one account instead of the tenant's own.
  //
  // Reads the real Drizzle condition rather than guessing from call order:
  // JSON.stringify on a SQL object does not expose the bound values.
  const paramValues = (node: unknown, out: string[], depth = 0): void => {
    if (node == null || depth > 8) return;
    if (Array.isArray(node)) { node.forEach((n) => paramValues(n, out, depth + 1)); return; }
    if (typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if (typeof o.value === 'string') out.push(o.value);
    if (Array.isArray(o.queryChunks)) paramValues(o.queryChunks, out, depth + 1);
  };

  it('does NOT return an admin-panel user when signing in to the tenant panel', async () => {
    const adminUser = {
      id: 'u-admin', email: 'person@example.test', panel: 'admin',
      roleName: 'super_admin', tenantId: null,
      oidcIssuer: 'https://dex', oidcSubject: 'sub-shared',
    };
    const tenantUser = {
      id: 'u-tenant', email: 'person-tenant@example.test', panel: 'tenant',
      roleName: 'tenant_admin', tenantId: 'tenant-1',
      oidcIssuer: 'https://dex', oidcSubject: 'sub-shared',
    };
    // Stands in for the DB: the admin row linked this identity first, so an
    // UNSCOPED subject lookup finds it. A panel-scoped one must not.
    const whereFn = vi.fn().mockImplementation((cond: unknown) => {
      const vals: string[] = [];
      paramValues(cond, vals);
      const bySubject = vals.includes('sub-shared');
      if (bySubject) return Promise.resolve(vals.includes('tenant') ? [] : [adminUser]);
      if (vals.includes('person-tenant@example.test')) return Promise.resolve([tenantUser]);
      // Re-select by id after the link is written.
      if (vals.includes('u-tenant')) return Promise.resolve([tenantUser]);
      return Promise.resolve([]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });
    const db = { select: selectFn, update: updateFn } as unknown as Parameters<typeof findOrCreateOidcUser>[0];

    const result = await findOrCreateOidcUser(db, {
      sub: 'sub-shared', iss: 'https://dex', email: 'person-tenant@example.test',
      aud: 'hosting-platform', exp: 9999999999, iat: 1000000000,
    }, makeProvider({ panelScope: 'tenant' }));

    expect(result.id).toBe('u-tenant');
    expect(result.panel).toBe('tenant');
  });
});
