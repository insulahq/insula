import { z } from 'zod';

// ─── R29a: request validation for a route that previously cast ─────────
//
// These fields are consumed by the service as `if (input.X !== undefined)`,
// so before this schema a MISSPELLED field was not a 400 — it was a field the
// service skipped, and the route answered 200 having changed nothing.
// `.strict()` is the point: Zod's default STRIPS unknown keys, which would
// preserve exactly that silence.

export const updateResourceQuotaSchema = z.object({
  cpu_cores_limit: z.number().positive().optional(),
  memory_gb_limit: z.number().positive().optional(),
  storage_gb_limit: z.number().positive().optional(),
  bandwidth_gb_limit: z.number().positive().optional(),
}).strict();
export type UpdateResourceQuota = z.infer<typeof updateResourceQuotaSchema>;
