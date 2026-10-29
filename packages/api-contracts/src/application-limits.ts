import { z } from 'zod';

/**
 * The subscription's application limit (`hosting_plans.max_applications`,
 * per-tenant `tenants.max_applications_override`). Counts what the tenant's
 * Applications page lists — catalog apps, custom containers, compose stacks
 * and private workers, stopped ones included, deleted applications and
 * revoked workers not — and never the platform's own pods in the namespace.
 */
export const applicationLimitSourceSchema = z.enum(['plan', 'tenant_override']);
export type ApplicationLimitSource = z.infer<typeof applicationLimitSourceSchema>;

export const applicationUsageSchema = z.object({
  limit: z.number().int().min(0),
  /** Everything that counts, private workers included. */
  current: z.number().int().min(0),
  /** How many of `current` are private workers (not revoked). */
  privateWorkers: z.number().int().min(0),
  /** max(0, limit - current): a tenant over its limit (a plan lowered) has 0, not a negative. */
  remaining: z.number().int().min(0),
  source: applicationLimitSourceSchema,
});
export type ApplicationUsage = z.infer<typeof applicationUsageSchema>;

/** Plan presets for a fresh install (seed) and the migration that introduced the limit. */
export const DEFAULT_PLAN_MAX_APPLICATIONS = { starter: 2, premium: 5, ultimate: 20 } as const;
