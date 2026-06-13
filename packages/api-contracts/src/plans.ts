import { z } from 'zod';

export const createPlanSchema = z.object({
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  description: z.string().max(500).optional(),
  cpu_limit: z.string().min(1).max(20),
  memory_limit: z.string().min(1).max(20),
  storage_limit: z.string().min(1).max(20),
  monthly_price_usd: z.string().min(1).max(20),
  max_sub_users: z.number().int().min(0).max(100).optional(),
  max_mailboxes: z.number().int().min(0).max(10000).optional(),
  // Per-plan ceiling on an INDIVIDUAL mailbox's size (MB). Defaults the
  // quota of new mailboxes and caps quota edits. Omitted on create -> DB
  // default 1024 (1 GiB). Per-tenant override:
  // tenants.max_mailbox_size_mb_override.
  max_mailbox_size_mb: z.number().int().min(50).max(102400).optional(),
  // R6 PR 1: plan-level outbound send limits (messages/hour and
  // messages/day). Omitted on create -> DB defaults 50/h + 100/d.
  // Per-tenant overrides: tenants.email_send_rate_limit(_daily).
  email_hourly_send_limit: z.number().int().min(0).max(1000000).optional(),
  email_daily_send_limit: z.number().int().min(0).max(10000000).optional(),
  weekly_ai_budget_cents: z.number().int().min(0).max(100000).optional(),
  features: z.record(z.string(), z.unknown()).optional().default({}),
});

export const updatePlanSchema = createPlanSchema.partial().strict();

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
