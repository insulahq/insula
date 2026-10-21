import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * An account archived while its panel is open: the next request is refused
 * with 403 TENANT_ARCHIVED, and the session ends there — tokens gone, the
 * sign-in page saying why — instead of every page failing one by one.
 */

async function freshClient() {
  vi.resetModules();
  return import('../lib/api-client');
}

const MESSAGE = 'This account has been archived and can no longer be signed in to.';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('auth_token', 'valid-token');
  localStorage.setItem('auth_refresh_token', 'valid-refresh');
  localStorage.setItem('auth_user', '{}');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function refuse(status: number, code: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: '',
    text: () => Promise.resolve(JSON.stringify({ error: { code, message: MESSAGE, status } })),
  }));
}

describe('a TENANT_ARCHIVED refusal', () => {
  it('ends the session and sends the user to sign-in with the reason', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, set href(v: string) { assign(v); }, get href() { return '/'; } });
    refuse(403, 'TENANT_ARCHIVED');
    const { apiFetch } = await freshClient();
    await expect(apiFetch('/api/v1/tenants/t1/deployments')).rejects.toMatchObject({ code: 'TENANT_ARCHIVED' });
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('auth_refresh_token')).toBeNull();
    expect(assign).toHaveBeenCalledWith(`/login?error=tenant_archived&message=${encodeURIComponent(MESSAGE)}`);
  });

  it('any other 403 keeps the session', async () => {
    refuse(403, 'INSUFFICIENT_PERMISSIONS');
    const { apiFetch } = await freshClient();
    await expect(apiFetch('/api/v1/tenants/t1/deployments')).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(localStorage.getItem('auth_token')).toBe('valid-token');
  });
});
