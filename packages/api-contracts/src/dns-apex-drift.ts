import { z } from 'zod';
import { uuidField } from './shared.js';

/**
 * Route DNS drift (shown to operators as "Apex DNS drift").
 *
 * Every ingress route — apex, subdomain, wildcard, and its www companion —
 * resolves through A/AAAA records that point STRAIGHT at the ingress servers'
 * addresses, one record per server and family. Those records are copies, and
 * copies drift whenever the server set changes:
 *   - a server is ADDED (or a server's ingress is enabled): its address is
 *     missing, so it never receives traffic;
 *   - a server is REMOVED (or its ingress disabled, or made private): its
 *     address is stale, so visitors are sent to a server that no longer
 *     answers;
 *   - a server's address CHANGES: both at once.
 *
 * Detection never changes DNS. The repair — the same reconcile "Refresh route
 * DNS" runs for one domain — ADDS missing records and REMOVES stale ones.
 * Two kinds of record are never removed:
 *   - `held`: the address of a server that is only not Ready right now (a
 *     reboot must not cost it its DNS), or one a hand-made DNS record
 *     publishes (the operator's decision, not the platform's);
 *   - `foreign`: an address the platform cannot attribute to any of its
 *     servers (current or past) or to a record it created.
 */

// ─── Record shapes ──────────────────────────────────────────────────────────

export const apexRecordSchema = z.object({
  type: z.enum(['A', 'AAAA']),
  content: z.string().min(1).max(255),
});
export type ApexRecord = z.infer<typeof apexRecordSchema>;

/** An address with the servers (raw node names) it belongs to. */
export const attributedRecordSchema = apexRecordSchema.extend({
  /** Raw node names; the UI renders them through NodeName (aliases). Empty when unknown. */
  servers: z.array(z.string()).default([]),
});
export type AttributedRecord = z.infer<typeof attributedRecordSchema>;

export const STALE_REASONS = [
  'server-removed',
  'ingress-disabled',
  'private',
  'no-longer-ingress',
  'platform-created',
] as const;
export const staleRecordSchema = attributedRecordSchema.extend({
  /** Why the address is no longer an ingress address. */
  reason: z.enum(STALE_REASONS),
});
export type StaleRecord = z.infer<typeof staleRecordSchema>;

export const HELD_REASONS = [
  'server-not-ready', // the server is down for now — it may come back
  'manual-record',    // a hand-made DNS record publishes this address
] as const;
export const heldRecordSchema = attributedRecordSchema.extend({
  /** Why the address stays although it is not an ingress address now. */
  reason: z.enum(HELD_REASONS),
});
export type HeldRecord = z.infer<typeof heldRecordSchema>;

// ─── Servers ────────────────────────────────────────────────────────────────

export const SERVER_INGRESS_STATUSES = [
  'ingress',          // publishes ingress traffic — its addresses are expected
  'ingress-disabled', // ingress mode "none"
  'private',          // exposure: private
  'not-ready',        // node NotReady
  'no-public-ip',     // no ExternalIP to publish
  'removed',          // no longer in the cluster
  'not-in-override',  // eligible, but an operator override replaces discovery
] as const;
export const ingressServerSchema = z.object({
  /** Raw node name. */
  name: z.string(),
  ipv4: z.array(z.string()),
  ipv6: z.array(z.string()),
  status: z.enum(SERVER_INGRESS_STATUSES),
});
export type IngressServer = z.infer<typeof ingressServerSchema>;

// ─── Per hostname / per domain ──────────────────────────────────────────────

export const routeHostnameDriftSchema = z.object({
  hostname: z.string(),
  /** Zone-relative record name (`@`, `www`, `*.sites`). */
  recordName: z.string(),
  /** Expected addresses absent from the zone — the repair ADDS them. */
  missing: z.array(attributedRecordSchema),
  /** Addresses of servers that no longer serve ingress — the repair REMOVES them. */
  stale: z.array(staleRecordSchema),
  /** Not expected, but kept on purpose — the repair leaves them. */
  held: z.array(heldRecordSchema).default([]),
  /** Addresses the platform cannot attribute — reported, never touched. */
  foreign: z.array(apexRecordSchema),
  /** Expected addresses already in place. */
  ok: z.number().int().min(0),
});
export type RouteHostnameDrift = z.infer<typeof routeHostnameDriftSchema>;

export const dnsApexDriftDomainSchema = z.object({
  domainId: uuidField,
  domainName: z.string().min(1).max(255),
  hostnames: z.array(routeHostnameDriftSchema),
  missingCount: z.number().int().min(0),
  staleCount: z.number().int().min(0),
  heldCount: z.number().int().min(0).default(0),
  foreignCount: z.number().int().min(0),
  /**
   * Set when this domain could not be read (provider unreachable, zone
   * missing, credentials rejected) — drift you cannot rule out.
   */
  error: z.string().max(500).nullable().default(null),
});
export type DnsApexDriftDomain = z.infer<typeof dnsApexDriftDomainSchema>;

// ─── Report ─────────────────────────────────────────────────────────────────

export const dnsApexDriftReportSchema = z.object({
  /** Report layout; v2 = per-hostname, attributed, with stale records. */
  version: z.literal(2),
  scannedAt: z.string(),
  trigger: z.enum(['manual', 'scheduled']),
  /** The ingress address set every route hostname should carry. */
  expected: z.array(attributedRecordSchema),
  ingressSource: z.enum(['override', 'discovered', 'env', 'fallback']),
  /**
   * Every current server with its ingress status, plus removed servers that
   * a stale record still points at.
   */
  servers: z.array(ingressServerSchema),
  domains: z.array(dnsApexDriftDomainSchema),
  /** Domains with at least one missing or stale record. Drives banner + tile. */
  driftCount: z.number().int().min(0),
  missingCount: z.number().int().min(0),
  staleCount: z.number().int().min(0),
  heldCount: z.number().int().min(0).default(0),
  foreignCount: z.number().int().min(0),
  /** Domains that could not be read at all. */
  errorCount: z.number().int().min(0),
  /** Set when the scan could not run at all (e.g. no ingress address known). */
  scanError: z.string().max(500).nullable().default(null),
});
export type DnsApexDriftReport = z.infer<typeof dnsApexDriftReportSchema>;

export const dnsApexDriftReportResponseSchema = z.object({
  /** Null when no (current-format) scan has run — distinct from "scanned, no drift". */
  data: dnsApexDriftReportSchema.nullable(),
});
export type DnsApexDriftReportResponse = z.infer<typeof dnsApexDriftReportResponseSchema>;

// ─── Fix ────────────────────────────────────────────────────────────────────

export const fixDnsApexDriftSchema = z
  .object({
    /** Domains to repair. Omit and pass `all: true` for every drifting domain. */
    domainIds: z.array(uuidField).max(1000).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.all === true || (v.domainIds !== undefined && v.domainIds.length > 0), {
    message: 'Provide domainIds or set all=true',
  });
export type FixDnsApexDriftInput = z.infer<typeof fixDnsApexDriftSchema>;

export const fixDnsApexDriftResponseSchema = z.object({
  data: z.object({
    taskId: z.string().uuid(),
    domainCount: z.number().int().min(0),
  }),
});
export type FixDnsApexDriftResponse = z.infer<typeof fixDnsApexDriftResponseSchema>;

/** What the repair did to one domain — the task's `details.results[]`. */
export const routeDnsChangeSchema = attributedRecordSchema.extend({ hostname: z.string() });
export const routeDnsDomainResultSchema = z.object({
  domainId: uuidField,
  domainName: z.string(),
  added: z.array(routeDnsChangeSchema),
  removed: z.array(routeDnsChangeSchema.extend({ reason: z.enum(STALE_REASONS) })),
  failures: z.array(z.object({ hostname: z.string(), detail: z.string() })),
});
export type RouteDnsDomainResult = z.infer<typeof routeDnsDomainResultSchema>;
