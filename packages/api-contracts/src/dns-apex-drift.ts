import { z } from 'zod';
import { uuidField } from './shared.js';

/**
 * Apex ingress-record drift.
 *
 * A tenant apex (`example.test` itself) cannot CNAME into the platform's
 * ingress chain — CNAME is illegal at a zone apex — so its A/AAAA records are
 * *copies* of the cluster's ingress addresses living inside the tenant zone.
 * Copies drift: add an ingress-capable node and every apex still points at the
 * old set. Subdomains are unaffected; they CNAME to `<slug>.ingress.<apex>`
 * and inherit whatever the tail of that chain resolves to.
 *
 * Detection is READ-ONLY and never repairs on its own. Fixes are explicitly
 * operator-invoked and **additive**: missing ingress addresses are added,
 * nothing is ever deleted. Anything else already present at the apex is
 * reported as `unmanaged` so the operator can see it, but is left alone — it
 * may be a deliberate CDN origin, a legacy host, or another platform's record.
 */

// ─── Record shape ────────────────────────────────────────────────────────────

export const apexRecordSchema = z.object({
  type: z.enum(['A', 'AAAA']),
  content: z.string().min(1).max(255),
});
export type ApexRecord = z.infer<typeof apexRecordSchema>;

// ─── Per-domain drift ────────────────────────────────────────────────────────

export const dnsApexDriftDomainSchema = z.object({
  domainId: uuidField,
  domainName: z.string().min(1).max(255),
  /** Ingress addresses the platform expects to be present at the apex. */
  expected: z.array(apexRecordSchema),
  /** Expected records absent from the zone — what a fix would ADD. */
  missing: z.array(apexRecordSchema),
  /**
   * Apex A/AAAA present in the zone that the platform did not put there.
   * Reported for visibility only; an additive fix never removes them.
   */
  unmanaged: z.array(apexRecordSchema),
  /**
   * Set when this domain could not be read (provider unreachable, zone
   * missing, credentials rejected). The domain is reported rather than
   * silently skipped — an unreadable zone is drift you cannot rule out.
   */
  error: z.string().max(500).nullable().default(null),
});
export type DnsApexDriftDomain = z.infer<typeof dnsApexDriftDomainSchema>;

// ─── Report ──────────────────────────────────────────────────────────────────

export const dnsApexDriftReportSchema = z.object({
  scannedAt: z.string(),
  /** How the scan was started — a manual run is never silent. */
  trigger: z.enum(['manual', 'scheduled']),
  /** The ingress address set the scan compared against. */
  expected: z.array(apexRecordSchema),
  /**
   * Where `expected` came from — an operator override, live node discovery,
   * a deployment env var, or the local fallback. Shown in the UI so
   * "why is my apex pointing there?" is answerable without reading code.
   * Optional: reports stored before provenance was tracked lack it.
   */
  ingressSource: z.enum(['override', 'discovered', 'env', 'fallback']).optional(),
  /** Nodes that produced a `discovered` set. Empty for other sources. */
  ingressDiscoveredNodes: z.array(z.string()).optional(),
  domains: z.array(dnsApexDriftDomainSchema),
  /** Domains with at least one missing record. Drives the banner. */
  driftCount: z.number().int().min(0),
  /** Domains carrying at least one unmanaged apex record. */
  unmanagedCount: z.number().int().min(0),
  /** Domains that could not be read at all. */
  errorCount: z.number().int().min(0),
  /**
   * Set when the scan could not run at all (e.g. no ingress IPs configured),
   * as opposed to running and finding nothing.
   */
  scanError: z.string().max(500).nullable().default(null),
});
export type DnsApexDriftReport = z.infer<typeof dnsApexDriftReportSchema>;

export const dnsApexDriftReportResponseSchema = z.object({
  /** Null when no scan has ever run — distinct from "scanned, no drift". */
  data: dnsApexDriftReportSchema.nullable(),
});
export type DnsApexDriftReportResponse = z.infer<typeof dnsApexDriftReportResponseSchema>;

// ─── Fix request ─────────────────────────────────────────────────────────────

export const fixDnsApexDriftSchema = z
  .object({
    /**
     * Domains to repair. Omit (or pass `all: true`) to repair every domain
     * with missing records in the latest report.
     */
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
