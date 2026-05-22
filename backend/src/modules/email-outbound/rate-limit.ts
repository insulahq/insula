/**
 * Phase 3 (post-Phase-3 hardening): rate-limit inspection helpers.
 *
 * Reads the effective email send rate limit for a tenant from:
 *   1. tenants.email_send_rate_limit (per-customer override)
 *   2. platform_settings.email_send_rate_limit_default
 *   3. HARDCODED_DEFAULT_LIMIT_PER_HOUR
 *
 * Suspended tenants are forced to limit = 0 regardless of the
 * configured override — same rule the email-outbound reconciler
 * applies when rendering [queue.throttle].
 *
 * The renderer in renderer.ts already does this calculation
 * inline. This module exposes it as a pure function so the
 * inspection endpoint can return the SAME numbers the rendered
 * Stalwart config uses, with no risk of drift.
 */

import { eq } from 'drizzle-orm';
import { tenants, platformSettings } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';

export const HARDCODED_DEFAULT_LIMIT_PER_HOUR = 100;

export type RateLimitSource =
  | 'tenant_override'
  | 'platform_default'
  | 'hardcoded_default'
  | 'suspended';

export interface EffectiveRateLimit {
  readonly limitPerHour: number;
  readonly source: RateLimitSource;
  readonly suspended: boolean;
}

export async function getEffectiveRateLimit(
  db: Database,
  tenantId: string,
): Promise<EffectiveRateLimit> {
  const [tenant] = await db
    .select({ status: tenants.status, emailSendRateLimit: tenants.emailSendRateLimit })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) {
    throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404);
  }

  if (tenant.status === 'suspended') {
    return { limitPerHour: 0, source: 'suspended', suspended: true };
  }

  if (typeof tenant.emailSendRateLimit === 'number' && tenant.emailSendRateLimit > 0) {
    return {
      limitPerHour: tenant.emailSendRateLimit,
      source: 'tenant_override',
      suspended: false,
    };
  }

  const [setting] = await db
    .select({ value: platformSettings.value })
    .from(platformSettings)
    .where(eq(platformSettings.key, 'email_send_rate_limit_default'));
  if (setting?.value) {
    const parsed = parseInt(setting.value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { limitPerHour: parsed, source: 'platform_default', suspended: false };
    }
  }

  return {
    limitPerHour: HARDCODED_DEFAULT_LIMIT_PER_HOUR,
    source: 'hardcoded_default',
    suspended: false,
  };
}
