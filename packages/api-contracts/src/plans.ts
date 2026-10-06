import { z } from 'zod';
import { cpuTierSchema } from './cpu-migration.js';

export const createPlanSchema = z.object({
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  description: z.string().max(500).optional(),
  /**
   * LEGACY (ADR-062). Despite the name this feeds `requests.cpu` — a
   * reservation that neither caps nor guarantees. Read only by tenants still
   * in legacy mode, and kept unchanged so upgrading a plan cannot move a
   * tenant that has not been migrated.
   */
  cpu_limit: z.string().min(1).max(20),
  /**
   * ADR-062 tiered mode: the share a workload gets under contention, and the
   * ceiling one may burst to. Optional — a plan that says nothing falls
   * through to the derived defaults, which is what every existing plan does.
   */
  cpu_tier: cpuTierSchema.nullable().optional(),
  cpu_burst_cores: z.number().min(0.1).max(256).nullable().optional(),
  memory_limit: z.string().min(1).max(20),
  storage_limit: z.string().min(1).max(20),
  /** Monthly data-transfer cap in GB (default 100 when omitted). */
  bandwidth_gb_limit: z.number().int().min(1).max(1_000_000).optional(),
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
  // Plan-level toggle for the ADR-036 custom-container (bring-your-own image)
  // path. Omitted on create -> DB default FALSE (no plan grants it unless an
  // admin opts in). Per-tenant override: tenants.allow_custom_containers_override.
  allow_custom_containers: z.boolean().optional(),
  features: z.record(z.string(), z.unknown()).optional().default({}),
});

export const updatePlanSchema = createPlanSchema.partial().strict();

export type CreatePlanInput = z.infer<typeof createPlanSchema>;

// ─── Request (wire) types ────────────────────────────────────────────────────
//
// `z.infer` is the OUTPUT type: a field declared `.default(x)` is REQUIRED
// there, because after parsing it always has a value. On the wire it is
// optional — the client may omit it and the backend fills it in.
//
// Typing a request body with the output type therefore marks every defaulted
// field as mandatory. Doing that surfaced three "missing required field"
// compile errors in working forms (catalog-repo sync interval, cron http_method,
// plan features) — all three fields have defaults, and all three forms were
// correct. A migration that trusted those errors would have changed working
// code to satisfy a type that was wrong.
//
// So: frontends type request bodies with `…Request` (= z.input), and the
// backend keeps using the `…Input` (= z.infer) type for `parsed.data`.
export type CreatePlanRequest = z.input<typeof createPlanSchema>;

export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
