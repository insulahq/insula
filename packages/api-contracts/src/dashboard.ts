import { z } from 'zod';

/**
 * Dashboard payloads for both panels.
 *
 * Split in two on purpose. The dashboard needs roughly two dozen distinct
 * facts; asking for them one endpoint at a time costs 23 requests on open and
 * 46 a minute while polling, against a per-user limit of 100 — two browser
 * tabs and an operator is throttling themselves. Worse, eleven of those reads
 * leave the API for the kube API or Stalwart, so the cost scales with the
 * number of people watching rather than with the rate the data changes.
 *
 *   `summary`  everything answerable from the platform database. Cheap, polled
 *              on a short interval.
 *   `live`     everything that has to leave the API — nodes, capacity, live
 *              metrics, mail, WAF. Expensive, polled on a long interval.
 *
 * Every section carries its own `SectionState`, so one slow or failing source
 * degrades a single tile rather than emptying the page. A section that is
 * `failed` still renders — with its last known shape and an explicit reason —
 * because a blank tile and a broken tile look identical to an operator.
 */

export const sectionStateEnum = z.enum(['ok', 'stale', 'failed']);
export type SectionState = z.infer<typeof sectionStateEnum>;

export const dashboardSectionSchema = z.object({
  state: sectionStateEnum,
  /** Present when state !== 'ok'. Operator-facing, never a raw stack. */
  reason: z.string().nullable().default(null),
  /** When the underlying source was last read successfully. */
  observedAt: z.string().nullable().default(null),
});
export type DashboardSection = z.infer<typeof dashboardSectionSchema>;

/** Wraps a payload with the state of the source that produced it. */
function section<T extends z.ZodTypeAny>(data: T) {
  return dashboardSectionSchema.extend({ data: data.nullable() });
}

// ── alerts ──────────────────────────────────────────────────────────
//
// An alert tile may only exist where a notification category exists to raise
// it. `categoryId` is that link, and it is REQUIRED: a tile with no category
// is a tile nothing can ever produce, which is how the first draft of this
// dashboard grew a "low free memory" warning that no code path could fire.

export const dashboardAlertSchema = z.object({
  /** The notification category this alert corresponds to. */
  categoryId: z.string().min(1),
  severity: z.enum(['warning', 'critical']),
  /** Headline figure — a count, or a percentage like "94%". */
  value: z.string().min(1),
  title: z.string().min(1),
  /** One line naming the subject. */
  subtitle: z.string(),
  /** Panel-relative path this tile opens. */
  href: z.string().min(1),
  /** Label/value pairs for the hover card. */
  detail: z.array(z.tuple([z.string(), z.string()])).default([]),
  /** Closing line: what to do, or why it is not as bad as it looks. */
  note: z.string().nullable().default(null),
});
export type DashboardAlert = z.infer<typeof dashboardAlertSchema>;

// ── shared resource shapes ──────────────────────────────────────────

/**
 * The triad. `inUse` is what is actually consumed; `committed` is what has
 * been reserved and cannot be handed to anything else even while idle;
 * `total` is the ceiling. The gap between the first two is the whole point —
 * production runs at 12% CPU usage and 92% CPU commitment.
 */
export const resourceTriadSchema = z.object({
  inUse: z.number(),
  committed: z.number(),
  total: z.number(),
  unit: z.string(),
  /** storage is consumed, not reserved — the UI hides the committed band. */
  kind: z.enum(['reserve', 'consume']).default('reserve'),
});
export type ResourceTriad = z.infer<typeof resourceTriadSchema>;

// ── admin ───────────────────────────────────────────────────────────

export const adminNodeSchema = z.object({
  name: z.string(),
  role: z.string(),
  ready: z.boolean(),
  cpu: resourceTriadSchema,
  memory: resourceTriadSchema,
  diskUsedPct: z.number().nullable(),
  pods: z.number(),
  calico: z.enum(['ok', 'warn', 'crit', 'unknown']),
  csi: z.enum(['ok', 'warn', 'crit', 'unknown']),
  evictionsLastHour: z.number(),
  pressures: z.array(z.string()),
  kubeletVersion: z.string().nullable(),
  ingressMode: z.string().nullable(),
  tenantWorkloads: z.boolean(),
});
export type AdminNode = z.infer<typeof adminNodeSchema>;

export const adminDashboardSummarySchema = z.object({
  generatedAt: z.string(),
  alerts: section(z.array(dashboardAlertSchema)),
  tenants: section(z.object({
    active: z.number(), total: z.number(),
    routes: z.number(), domains: z.number(),
    provisioningInFlight: z.number(),
  })),
  backups: section(z.object({
    /** One entry per shim class: system, tenant, mail. */
    classes: z.array(z.object({
      backupClass: z.enum(['system', 'tenant', 'mail']),
      lastSuccessAt: z.string().nullable(),
      targetName: z.string().nullable(),
      targetKind: z.string().nullable(),
      healthy: z.boolean(),
    })),
    bundles: z.number(),
    repoBytes: z.number().nullable(),
    tenantsNeverBackedUp: z.number(),
  })),
  certificates: section(z.object({
    issued: z.number(), wildcards: z.number(),
    nearestExpiryDays: z.number().nullable(), failing: z.number(),
  })),
  database: section(z.object({
    archivingHealthy: z.boolean(), walBytes: z.number().nullable(),
    volumeBytes: z.number().nullable(), pressurePct: z.number().nullable(),
    breakerTripped: z.boolean(),
  })),
  updates: section(z.object({
    platformCurrent: z.boolean(), deploymentsBehind: z.number(),
    autoUpgradeEnabled: z.number(), eolRuntimes: z.number(),
  })),
  scheduledTasks: section(z.object({
    total: z.number(), enabled: z.number(),
    failed24h: z.number(), overdue: z.number(),
  })),
  recentChanges: section(z.array(z.object({
    severity: z.enum(['ok', 'warning', 'critical']),
    label: z.string(), actor: z.string(), at: z.string(),
  }))),
});
export type AdminDashboardSummary = z.infer<typeof adminDashboardSummarySchema>;

export const adminDashboardLiveSchema = z.object({
  generatedAt: z.string(),
  cluster: section(z.object({
    cpu: resourceTriadSchema,
    memory: resourceTriadSchema,
    storage: resourceTriadSchema,
    nodeCount: z.number(),
    survivesSingleNodeLoss: z.boolean(),
    worstNode: z.string().nullable(),
  })),
  nodes: section(z.array(adminNodeSchema)),
  mail: section(z.object({
    sent7d: z.number(), queueDepth: z.number(), queueReachable: z.boolean(),
    mailboxes: z.number(), emailDomains: z.number(),
    rateLimited7d: z.number(), overQuotaMailboxes: z.number(),
  })),
  /* Alerts that only the cluster can answer — volume fullness and orphaned
     pods. They arrive on the slow refresh and the UI appends them to the fast
     band, so the attention row fills in two stages rather than waiting. */
  clusterAlerts: section(z.array(dashboardAlertSchema)),
  webDefence: section(z.object({
    blocked24h: z.number(), critical24h: z.number(),
    distinctSources: z.number(), activeBans: z.number(),
    topRuleId: z.string().nullable(), wafEnabled: z.boolean(),
    recent: z.array(z.object({
      severity: z.enum(['warning', 'critical']),
      label: z.string(), source: z.string(), at: z.string(),
    })),
  })),
});
export type AdminDashboardLive = z.infer<typeof adminDashboardLiveSchema>;

// ── tenant ──────────────────────────────────────────────────────────

export const tenantSiteSchema = z.object({
  host: z.string(),
  application: z.string(),
  status: z.string(),
  tlsState: z.enum(['valid', 'pending', 'expired', 'none']),
  tlsDaysRemaining: z.number().nullable(),
  trafficGb7d: z.number(),
  requests7d: z.number().nullable(),
  blocked7d: z.number(),
  diskGb: z.number().nullable(),
  cronJobs: z.number(),
  lastDeployedAt: z.string().nullable(),
});
export type TenantSite = z.infer<typeof tenantSiteSchema>;

export const tenantDashboardSummarySchema = z.object({
  generatedAt: z.string(),
  alerts: section(z.array(dashboardAlertSchema)),
  plan: section(z.object({
    name: z.string(),
    bandwidthUsedGb: z.number(), bandwidthLimitGb: z.number(),
    bandwidthResetDays: z.number().nullable(), bandwidthCapped: z.boolean(),
  })),
  mail: section(z.object({
    mailboxes: z.number(), maxMailboxes: z.number(),
    storageUsedGb: z.number(), storageLimitGb: z.number(),
    /** The largest single mailbox, as a fraction of its own quota. */
    fullestMailboxPct: z.number().nullable(),
    fullestMailboxAddress: z.string().nullable(),
    sentToday: z.number(), dailyLimit: z.number(),
  })),
  domains: section(z.object({
    domains: z.number(), verified: z.number(),
    certificates: z.number(), nearestRenewalDays: z.number().nullable(),
  })),
  backups: section(z.object({
    restorePoints: z.number(),
    newestAt: z.string().nullable(), oldestAt: z.string().nullable(),
    coversFiles: z.boolean(), coversDatabases: z.boolean(),
  })),
  scheduledTasks: section(z.object({
    total: z.number(), enabled: z.number(),
    failed24h: z.number(), nextRunAt: z.string().nullable(),
  })),
  recentChanges: section(z.array(z.object({
    severity: z.enum(['ok', 'warning', 'critical']),
    label: z.string(), actor: z.string(), at: z.string(),
  }))),
});
export type TenantDashboardSummary = z.infer<typeof tenantDashboardSummarySchema>;

export const tenantDashboardLiveSchema = z.object({
  generatedAt: z.string(),
  resources: section(z.object({
    cpu: resourceTriadSchema,
    memory: resourceTriadSchema,
    storage: resourceTriadSchema,
  })),
  sites: section(z.array(tenantSiteSchema)),
  blocked: section(z.array(z.object({
    severity: z.enum(['warning', 'critical']),
    label: z.string(), host: z.string(), at: z.string(),
  }))),
});
export type TenantDashboardLive = z.infer<typeof tenantDashboardLiveSchema>;
