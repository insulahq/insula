/**
 * The security notifications that existed and never fired.
 *
 * `security.password_changed` and
 * `account.sub_account_added` both had templates on every channel, both were
 * marked mandatory or security-class, and NOTHING in the codebase called
 * either emitter. The two notifications a person most needs — your password
 * changed, someone was added to your account — were the two that never
 * arrived.
 *
 * This guards the WIRING, not the wording: it asserts the call sites exist, so
 * a refactor that drops them fails here instead of going quietly unnoticed for
 * another year.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const AUTH_ROUTES = readFileSync('src/modules/auth/routes.ts', 'utf8');
const TENANT_ROUTES = readFileSync('src/modules/tenants/routes.ts', 'utf8');

describe('security notices are actually wired', () => {
  it('a password change notifies the account holder', () => {
    expect(AUTH_ROUTES).toContain('notifyTenantPasswordChanged');
  });

  it('the password-change notification cannot fail the password change', () => {
    // A 5xx here would leave the user believing their password did not change
    // while it had — worse than a missing notification.
    const idx = AUTH_ROUTES.indexOf('notifyTenantPasswordChanged');
    const window = AUTH_ROUTES.slice(Math.max(0, idx - 700), idx + 400);
    expect(window).toMatch(/void \(async \(\) => \{/);
    expect(window).toMatch(/catch/);
  });

  it('adding a sub-account notifies the tenant', () => {
    expect(TENANT_ROUTES).toContain('notifyTenantSubAccountAdded');
  });

  it('the sub-account notification cannot fail the creation', () => {
    const idx = TENANT_ROUTES.indexOf('notifyTenantSubAccountAdded');
    const window = TENANT_ROUTES.slice(Math.max(0, idx - 700), idx + 400);
    expect(window).toMatch(/void \(async \(\) => \{/);
    expect(window).toMatch(/catch/);
  });

  it('the password-changed emitter does not pass an id as a display name', () => {
    // It passed `userName: userId`, which would have rendered "Hi 3fd54013-…".
    const events = readFileSync('src/modules/notifications/events.ts', 'utf8');
    const idx = events.indexOf('security.password_changed');
    const line = events.slice(idx - 200, idx + 200);
    expect(line).not.toContain('userName: userId');
  });
});
