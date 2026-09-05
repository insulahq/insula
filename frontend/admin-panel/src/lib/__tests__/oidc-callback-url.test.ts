/**
 * The redirect URI an IdP must have registered, per panel scope.
 *
 * `docs/operations/DEX_OIDC_STAGING.md` listed the **tenant-panel** Dex client
 * with `https://admin.<domain>/api/v1/auth/oidc/callback` — the admin host.
 * Following it produces `Unregistered redirect_uri` at the IdP. The mistake is
 * natural: the admin panel's own origin is the one in front of you, and the
 * tenant host never appears on that screen.
 *
 * These pin the property the doc got wrong: **tenant scope never resolves to
 * the admin origin**, under any fallback.
 */

import { describe, it, expect } from 'vitest';
import { oidcCallbackUrl, resolvePanelOrigin, OIDC_CALLBACK_PATH } from '../oidc-callback-url';

const URLS = {
  adminPanelUrl: 'https://admin.example.test',
  tenantPanelUrl: 'https://tenant.example.test',
};

describe('oidcCallbackUrl', () => {
  it('uses the TENANT host for a tenant-scoped provider', () => {
    expect(oidcCallbackUrl('tenant', URLS)).toBe(
      'https://tenant.example.test/api/v1/auth/oidc/callback',
    );
  });

  it('uses the ADMIN host for an admin-scoped provider', () => {
    expect(oidcCallbackUrl('admin', URLS)).toBe(
      'https://admin.example.test/api/v1/auth/oidc/callback',
    );
  });

  it('never hands back the admin origin for tenant scope, even with none configured', () => {
    // The regression the doc encoded: falling back to "where I am" for a
    // tenant provider. Empty is correct here — the UI then tells the operator
    // to configure the tenant panel URL, rather than giving them a wrong one.
    const url = oidcCallbackUrl('tenant', { adminPanelUrl: 'https://admin.example.test', tenantPanelUrl: null }, 'https://admin.example.test');
    expect(url).not.toContain('admin.example.test');
    expect(url).toBe('');
  });

  it('falls back to the current origin for admin scope only', () => {
    expect(oidcCallbackUrl('admin', { adminPanelUrl: null, tenantPanelUrl: null }, 'https://admin.example.test'))
      .toBe('https://admin.example.test/api/v1/auth/oidc/callback');
  });

  it('strips a trailing slash so the URL never doubles up', () => {
    expect(oidcCallbackUrl('tenant', { tenantPanelUrl: 'https://tenant.example.test/' }))
      .toBe('https://tenant.example.test/api/v1/auth/oidc/callback');
  });

  it('prefers the operator-configured URL over anything else', () => {
    // System Settings is what the ingress reconciler points at, so it wins.
    expect(resolvePanelOrigin('tenant', { tenantPanelUrl: 'https://my.example.test' }))
      .toBe('https://my.example.test');
  });

  it('uses the path the backend actually serves', () => {
    // oidc/routes.ts registers GET /auth/oidc/callback under the /api/v1 prefix.
    expect(OIDC_CALLBACK_PATH).toBe('/api/v1/auth/oidc/callback');
  });
});
