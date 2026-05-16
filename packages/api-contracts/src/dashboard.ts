import { z } from 'zod';

// ─── Response Schemas ────────────────────────────────────────────────────────

export const dashboardResponseSchema = z.object({
  total_tenants: z.number(),
  active_tenants: z.number(),
  total_domains: z.number(),
  total_backups: z.number(),
  platform_version: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
