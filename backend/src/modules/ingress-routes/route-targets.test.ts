import { describe, it, expect } from 'vitest';
import { isRoutable, isRedirectOnly } from './route-targets.js';
import {
  updateRedirectSettingsSchema,
  updateSecuritySettingsSchema,
} from '@insula/api-contracts';

// WHY THIS EXISTS: an operator configured an ingress route with no deployment
// and a permanent redirect, and got Traefik's 404. Two independent faults:
//
//  1. The panel sent `custom_redirect_url` while the API accepts
//     `redirect_url`. Zod strips unknown keys by default, so the PATCH
//     returned 200 and wrote nothing — on every route of every cluster.
//  2. The reconciler admitted a route only when it had a deployment or a
//     private worker, so a redirect-only row never became an IngressRoute.

const NOTHING = { deploymentId: null, privateWorkerId: null, redirectUrl: null };

describe('route target classification', () => {
  it('admits a redirect-only route — the case that used to 404', () => {
    const route = { ...NOTHING, redirectUrl: 'https://example.test/' };
    expect(isRoutable(route)).toBe(true);
    expect(isRedirectOnly(route)).toBe(true);
  });

  it('still admits deployment- and worker-backed routes', () => {
    expect(isRoutable({ ...NOTHING, deploymentId: 'dep-1' })).toBe(true);
    expect(isRoutable({ ...NOTHING, privateWorkerId: 'pw-1' })).toBe(true);
  });

  it('rejects a route with neither a target nor a redirect', () => {
    // Half-configured: an IngressRoute here could only ever 503.
    expect(isRoutable(NOTHING)).toBe(false);
  });

  it('does not call a deployment-backed route redirect-only', () => {
    // A redirect composes with a real backend; only the sink backend is
    // reserved for routes that have nothing of their own to serve.
    const route = { ...NOTHING, deploymentId: 'dep-1', redirectUrl: 'https://example.test/' };
    expect(isRoutable(route)).toBe(true);
    expect(isRedirectOnly(route)).toBe(false);
  });
});

describe('settings schemas reject unknown keys', () => {
  it('accepts the real redirect field', () => {
    const parsed = updateRedirectSettingsSchema.safeParse({ redirect_url: 'https://example.test/' });
    expect(parsed.success).toBe(true);
  });

  it('rejects the panel\'s old custom_redirect_url instead of silently dropping it', () => {
    const parsed = updateRedirectSettingsSchema.safeParse({ custom_redirect_url: 'https://example.test/' });
    expect(parsed.success).toBe(false);
  });

  it('rejects the panel\'s old rate_limit_burst instead of silently dropping it', () => {
    expect(updateSecuritySettingsSchema.safeParse({ rate_limit_burst: 2 }).success).toBe(false);
    expect(updateSecuritySettingsSchema.safeParse({ rate_limit_burst_multiplier: 2 }).success).toBe(true);
  });
});
