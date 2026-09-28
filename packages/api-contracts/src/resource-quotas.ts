import { z } from 'zod';

// ─── R29a: request validation for a route that previously cast ─────────
//
// These fields are consumed by the service as `if (input.X !== undefined)`,
// so before this schema a MISSPELLED field was not a 400 — it was a field the
// service skipped, and the route answered 200 having changed nothing.
// `.strict()` is the point: Zod's default STRIPS unknown keys, which would
// preserve exactly that silence.

// ★ `.int()` on the three that back INTEGER columns.
//
// `memory_gb_limit`, `storage_gb_limit` and `bandwidth_gb_limit` are
// `integer` in Postgres; `cpu_cores_limit` is `numeric(5,2)` and is
// genuinely fractional. Without `.int()` a request for 1.5 GB passed
// validation and then failed in the driver as `invalid input syntax for
// type integer` — a 500 for an input the API had already declared it was
// checking. Refusing it here names the field instead.
export const updateResourceQuotaSchema = z.object({
  cpu_cores_limit: z.number().positive().optional(),
  memory_gb_limit: z.number().int().positive().optional(),
  storage_gb_limit: z.number().int().positive().optional(),
  bandwidth_gb_limit: z.number().int().positive().optional(),
}).strict();
export type UpdateResourceQuota = z.infer<typeof updateResourceQuotaSchema>;
