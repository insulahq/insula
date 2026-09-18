import { z } from 'zod';

/**
 * GET /admin/mail/health
 *
 * Real, verified mail-server health. Replaces the cosmetic "Mail Server
 * Status" tile that just echoed the operator's intent (placement +
 * port-exposure settings) without ever talking to the cluster. The
 * 2026-05-14 streamline made this an actual probe set.
 *
 * Each component reports `healthy: boolean` independently — the
 * top-level `healthy` is the AND of all components. Operator UI
 * (Phase-5 banner drill-down) renders the components in order:
 *
 *   pod        — does the Stalwart pod exist + is its `stalwart`
 *                container ready? Returns node name + phase. This
 *                catches CrashLoopBackOff, ImagePullBackOff, restore-
 *                state initContainer hangs, etc.
 *
 *   jmap       — does Stalwart actually answer JMAP? We call
 *                `Server/get` and report the response time + version.
 *                Catches "pod ready but RocksDB lock failed" and
 *                similar split-brain shapes.
 *
 *   rocksdb    — exec `stalwart -e check` inside the pod (or
 *                equivalent open-only validation). Catches DataStore
 *                corruption while pod and JMAP are both green. SHIPS
 *                as null/`not_implemented` in Phase 3a; populated in
 *                Phase 3b once the read-only check helper is wired
 *                into the Stalwart pod's command surface.
 *
 *   cert       — TLS cert serving on each mail port: validity window,
 *                issuer, days-until-expiry. SHIPS as null in Phase 3a;
 *                Phase 3b reuses the existing ssl-status cache.
 *
 *   tcp        — TCP reach (from the platform-api pod, which is on a
 *                different node) on every mail port. SHIPS as null in
 *                Phase 3a; Phase 3b implements with node-mode-aware
 *                target selection (Service VIP in allServerNodes mode,
 *                hostPort in thisNodeOnly mode).
 *
 * Backend caches the full response for `cachedFor` seconds (default
 * 30s). UI must NOT poll faster than the cache window — instead use
 * an explicit `?refresh=1` query param when the operator clicks
 * "Re-check now".
 */

const componentStatusSchema = z.object({
  healthy: z.boolean(),
  error: z.string().nullable(),
});

export const mailHealthPodComponentSchema = componentStatusSchema.extend({
  podName: z.string().nullable(),
  node: z.string().nullable(),
  phase: z.enum(['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']).nullable(),
  containerReady: z.boolean().nullable(),
  restartCount: z.number().int().nonnegative().nullable(),
  initContainerStatus: z.string().nullable(),
});

export const mailHealthJmapComponentSchema = componentStatusSchema.extend({
  durationMs: z.number().int().nonnegative().nullable(),
  serverName: z.string().nullable(),
  serverVersion: z.string().nullable(),
});

/**
 * Status enum shared by the optional Phase-3b probes (rocksdb / cert / tcp):
 *   `ok`              — probe ran AND result was good
 *   `fail`            — probe ran AND result was bad (see `error`)
 *   `not_implemented` — probe didn't run on this platform/build
 */
export const optionalProbeStatusSchema = z.enum(['ok', 'fail', 'not_implemented']);

export const mailHealthRocksdbComponentSchema = componentStatusSchema.extend({
  status: optionalProbeStatusSchema,
  /** RocksDB CURRENT sentinel file exists in /var/lib/stalwart/data. */
  currentFile: z.boolean().nullable(),
  /** RocksDB LOCK file exists (only present while DB is open). */
  lockFile: z.boolean().nullable(),
});

export const mailHealthCertPortSchema = z.object({
  port: z.number().int(),
  protocol: z.enum(['smtps', 'submission', 'imaps', 'imap', 'pop3s', 'managesieve', 'smtp']),
  daysUntilExpiry: z.number().int().nullable(),
  issuer: z.string().nullable(),
  error: z.string().nullable(),
});

export const mailHealthCertComponentSchema = componentStatusSchema.extend({
  status: optionalProbeStatusSchema,
  ports: z.array(mailHealthCertPortSchema),
});

export const mailHealthTcpPortSchema = z.object({
  port: z.number().int(),
  reachable: z.boolean(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
});

export const mailHealthTcpComponentSchema = componentStatusSchema.extend({
  status: optionalProbeStatusSchema,
  ports: z.array(mailHealthTcpPortSchema),
});

// ── Deliverability sub-probes (forward DNS, reverse DNS / FCrDNS, DNSBL,
// cert SAN match, SMTP banner). These hit *external* infrastructure
// (recursor + DNSBL providers) so they are inherently slower and
// noisier than the cluster-internal probes above. Each sub-probe carries
// the full advice payload — severity, expected vs actual, and a
// remediation string the operator can act on — because the UI surfaces
// them in a drill-down modal with per-row guidance.
//
// severity meanings:
//   `ok`        — assertion held; no action needed
//   `warning`   — assertion partially held or returned soft-fail; deliverability
//                 may degrade for some recipients (e.g. listed on a single
//                 mid-trust DNSBL)
//   `fail`      — assertion failed; mail flow likely broken or rejected
//                 (e.g. PTR doesn't match HELO, listed on Spamhaus ZEN)
//   `advisory`  — informational only; not factored into top-level `healthy`
//   `skipped`   — probe couldn't run (no hostname configured, no resolver,
//                 etc.); shown in modal but doesn't count against the
//                 deliverability rollup

export const deliverabilityProbeSeveritySchema = z.enum(['ok', 'warning', 'fail', 'advisory', 'skipped']);
export type DeliverabilityProbeSeverity = z.infer<typeof deliverabilityProbeSeveritySchema>;

const deliverabilityProbeBaseSchema = z.object({
  severity: deliverabilityProbeSeveritySchema,
  /** What the probe asserts (short imperative, e.g. "mail hostname has a PTR"). */
  assertion: z.string(),
  /** What was actually observed (free text). */
  actual: z.string().nullable(),
  /** What was expected (free text). */
  expected: z.string().nullable(),
  /** Operator-facing remediation steps when severity != 'ok'. */
  remediation: z.string().nullable(),
});

export const mailHealthForwardDnsProbeSchema = deliverabilityProbeBaseSchema.extend({
  hostname: z.string(),
  resolvedIps: z.array(z.string()),
  expectedIps: z.array(z.string()),
  missingIps: z.array(z.string()),
  extraIps: z.array(z.string()),
});
export type MailHealthForwardDnsProbe = z.infer<typeof mailHealthForwardDnsProbeSchema>;

/**
 * AAAA coverage for the mail hostname on a DUAL-STACK cluster.
 *
 * A cluster bootstrapped with `--dual-stack` accepts SMTP/IMAP over IPv6 on
 * every mail node, but a v6-only client can only find it if `mail.<apex>`
 * publishes AAAA. Missing AAAA is not a fault in the cluster — everything works
 * over IPv4 — which is exactly why it goes unnoticed: the operator asked for
 * IPv6, the platform delivers it, and no client ever uses it. Hence `warning`,
 * never `fail`.
 *
 * On a single-stack cluster this probe is `skipped`: there is no v6 to publish.
 */
export const mailHealthIpv6DnsProbeSchema = deliverabilityProbeBaseSchema.extend({
  hostname: z.string(),
  /** AAAA records currently published for the mail hostname. */
  resolvedIpv6: z.array(z.string()),
  /** Global IPv6 addresses of the nodes that serve mail. Empty = single-stack. */
  expectedIpv6: z.array(z.string()),
  /** Node IPv6 addresses with no matching AAAA record. */
  missingIpv6: z.array(z.string()),
  /** Published AAAA records that are not a mail-serving node. */
  extraIpv6: z.array(z.string()),
  /** True when the cluster itself serves IPv6 (i.e. the probe is meaningful). */
  clusterIsDualStack: z.boolean(),
});
export type MailHealthIpv6DnsProbe = z.infer<typeof mailHealthIpv6DnsProbeSchema>;

export const mailHealthReverseDnsProbeSchema = deliverabilityProbeBaseSchema.extend({
  ip: z.string(),
  ptrRecords: z.array(z.string()),
  expectedPtr: z.string(),
  fcrdnsOk: z.boolean(),
});
export type MailHealthReverseDnsProbe = z.infer<typeof mailHealthReverseDnsProbeSchema>;

export const mailHealthBlocklistProbeSchema = deliverabilityProbeBaseSchema.extend({
  ip: z.string(),
  /** Short label, e.g. "Spamhaus ZEN". */
  list: z.string(),
  /** DNS zone queried, e.g. "zen.spamhaus.org". */
  zone: z.string(),
  listed: z.boolean(),
  /** Listing reason from TXT record if available. */
  reasonTxt: z.string().nullable(),
  /** Provider URL for removal/lookup. */
  lookupUrl: z.string().nullable(),
});
export type MailHealthBlocklistProbe = z.infer<typeof mailHealthBlocklistProbeSchema>;

export const mailHealthCertSanProbeSchema = deliverabilityProbeBaseSchema.extend({
  hostname: z.string(),
  /** SAN DNS names extracted from the served certificate. */
  sanDnsNames: z.array(z.string()),
  /** True if hostname matched a SAN entry (exact or wildcard). */
  matched: z.boolean(),
});
export type MailHealthCertSanProbe = z.infer<typeof mailHealthCertSanProbeSchema>;

export const mailHealthSmtpBannerProbeSchema = deliverabilityProbeBaseSchema.extend({
  hostname: z.string(),
  /** Hostname advertised in the 220 banner. */
  bannerHostname: z.string().nullable(),
  /** Hostname advertised in the first EHLO 250 line. */
  ehloHostname: z.string().nullable(),
  bannerMatches: z.boolean(),
  ehloMatches: z.boolean(),
});
export type MailHealthSmtpBannerProbe = z.infer<typeof mailHealthSmtpBannerProbeSchema>;

export const mailHealthDeliverabilityComponentSchema = componentStatusSchema.extend({
  status: optionalProbeStatusSchema,
  /** Hostname the probes were run against (mail.<apex> or operator override). */
  hostname: z.string().nullable(),
  /** Server-role node IPs that the cluster believes serve mail. */
  expectedMailIps: z.array(z.string()),
  forwardDns: mailHealthForwardDnsProbeSchema.nullable(),
  /** AAAA coverage on a dual-stack cluster. Optional — older backends omit it. */
  ipv6Dns: mailHealthIpv6DnsProbeSchema.nullable().optional(),
  reverseDns: z.array(mailHealthReverseDnsProbeSchema),
  blocklists: z.array(mailHealthBlocklistProbeSchema),
  certSanMatch: mailHealthCertSanProbeSchema.nullable(),
  smtpBanner: mailHealthSmtpBannerProbeSchema.nullable(),
  /** Rollup: ok / warning / fail / advisory counts across all sub-probes. */
  summary: z.object({
    ok: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    advisory: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
});
export type MailHealthDeliverabilityComponent = z.infer<typeof mailHealthDeliverabilityComponentSchema>;

export const mailHealthResponseSchema = z.object({
  healthy: z.boolean(),
  components: z.object({
    pod: mailHealthPodComponentSchema,
    jmap: mailHealthJmapComponentSchema,
    rocksdb: mailHealthRocksdbComponentSchema,
    cert: mailHealthCertComponentSchema,
    tcp: mailHealthTcpComponentSchema,
    /**
     * External deliverability probes (DNS, blocklists, banner, cert SAN
     * match). Optional in the response because rollout is staged: older
     * backends still emit the 5-component shape. Frontend renders the
     * modal section only when this is present.
     */
    deliverability: mailHealthDeliverabilityComponentSchema.optional(),
  }),
  checkedAt: z.string().datetime(),
  cachedFor: z.number().int().nonnegative(),
});
export type MailHealthResponse = z.infer<typeof mailHealthResponseSchema>;
export type MailHealthPodComponent = z.infer<typeof mailHealthPodComponentSchema>;
export type MailHealthJmapComponent = z.infer<typeof mailHealthJmapComponentSchema>;
export type MailHealthRocksdbComponent = z.infer<typeof mailHealthRocksdbComponentSchema>;
export type MailHealthCertComponent = z.infer<typeof mailHealthCertComponentSchema>;
export type MailHealthCertPort = z.infer<typeof mailHealthCertPortSchema>;
export type MailHealthTcpComponent = z.infer<typeof mailHealthTcpComponentSchema>;
export type MailHealthTcpPort = z.infer<typeof mailHealthTcpPortSchema>;

// ─── DMARC aggregate reports (ROADMAP R5) ──────────────────────────────────
//
// Stalwart parses the RFC 7489 XML; the platform ingests the parsed objects and
// aggregates them here. Every rate is reported WITH its denominator: a pass
// rate with no message count is exactly the figure that gets acted on when it
// should not be.

export const dmarcPolicySchema = z.enum(['none', 'quarantine', 'reject']);
export type DmarcPolicyValue = z.infer<typeof dmarcPolicySchema>;

export const dmarcRecommendationSchema = z.object({
  policyDomain: z.string(),
  currentPolicy: dmarcPolicySchema.nullable(),
  /** What to publish next, or null when nothing should change yet. */
  recommendedPolicy: dmarcPolicySchema.nullable(),
  passRate: z.number().min(0).max(1).nullable(),
  /** One actionable sentence. Never empty. */
  reason: z.string().min(1),
  /**
   * True only when every threshold is met. The UI gates on this rather than on
   * `recommendedPolicy != null`, so a null-because-unknown can never be read
   * as a null-because-fine.
   */
  ready: z.boolean(),
});
export type DmarcRecommendationResponse = z.infer<typeof dmarcRecommendationSchema>;

export const dmarcDomainSummarySchema = z.object({
  policyDomain: z.string(),
  tenantId: z.string().nullable(),
  reportCount: z.number().int().nonnegative(),
  totalMessages: z.number().int().nonnegative(),
  passMessages: z.number().int().nonnegative(),
  failMessages: z.number().int().nonnegative(),
  dkimPassMessages: z.number().int().nonnegative(),
  spfPassMessages: z.number().int().nonnegative(),
  quarantinedMessages: z.number().int().nonnegative(),
  rejectedMessages: z.number().int().nonnegative(),
  /** Null when there is no denominator — NOT 0, and NOT 1. */
  passRate: z.number().min(0).max(1).nullable(),
  currentPolicy: dmarcPolicySchema.nullable(),
  firstReportAt: z.string().nullable(),
  lastReportAt: z.string().nullable(),
  windowDays: z.number().int().nonnegative(),
  failingSources: z.number().int().nonnegative(),
  recommendation: dmarcRecommendationSchema,
});
export type DmarcDomainSummary = z.infer<typeof dmarcDomainSummarySchema>;

export const dmarcSourceSummarySchema = z.object({
  sourceIp: z.string(),
  policyDomain: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
  passCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  lastSeenAt: z.string().nullable(),
});
export type DmarcSourceSummary = z.infer<typeof dmarcSourceSummarySchema>;

export const dmarcOverviewSchema = z.object({
  windowDays: z.number().int().positive(),
  domains: z.array(dmarcDomainSummarySchema).default([]),
  /**
   * Where reports are expected to arrive. Surfaced so an operator can see the
   * address the published `rua=` points at without reading DNS — the previous
   * record pointed at a mailbox that never existed, and nothing showed it.
   */
  intakeLocalPart: z.string(),
});
export type DmarcOverview = z.infer<typeof dmarcOverviewSchema>;

export const dmarcSourcesQuerySchema = z.object({
  domain: z.string().min(1).max(255),
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type DmarcSourcesQuery = z.infer<typeof dmarcSourcesQuerySchema>;

// ── Abuse reports (ARF, RFC 5965) ──────────────────────────────────────────
//
// One entry per complaint Stalwart parsed and the platform consumed. Unlike
// the DMARC surface there is no rate and no recommendation: the unit is an
// incident to act on, not a trend.

export const abuseFeedbackTypeSchema = z.enum(['abuse', 'fraud', 'virus', 'other']);
export type AbuseFeedbackType = z.infer<typeof abuseFeedbackTypeSchema>;

export const abuseReportSchema = z.object({
  id: z.string(),
  feedbackType: abuseFeedbackTypeSchema,
  /** The reported domain. Null when the report named none we could read. */
  domain: z.string().nullable(),
  /**
   * Null when the reported domain is not an email domain on this platform —
   * which is itself informative (often a spoof of one of ours), so these are
   * shown rather than filtered out.
   */
  tenantId: z.string().nullable(),
  tenantName: z.string().nullable(),
  originalMailFrom: z.string().nullable(),
  originalRcptTo: z.string().nullable(),
  sourceIp: z.string().nullable(),
  reportingMta: z.string().nullable(),
  /** Who complained — the report's own From. */
  reporter: z.string().nullable(),
  subject: z.string().nullable(),
  /** ARF `Incidents`: one report can stand for many occurrences. */
  incidents: z.number().int().positive(),
  receivedAt: z.string(),
});
export type AbuseReport = z.infer<typeof abuseReportSchema>;

export const abuseReportsOverviewSchema = z.object({
  windowDays: z.number().int().positive(),
  reports: z.array(abuseReportSchema).default([]),
  /** Total in the window, which may exceed `reports.length` once capped. */
  total: z.number().int().nonnegative(),
  /**
   * Where complaints are expected to arrive. Shown for the same reason as the
   * DMARC intake address: an operator should not have to read DNS to find out
   * whether the address a complaint would be sent to actually exists.
   */
  intakeLocalPart: z.string(),
});
export type AbuseReportsOverview = z.infer<typeof abuseReportsOverviewSchema>;

export const abuseReportsQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  feedbackType: abuseFeedbackTypeSchema.optional(),
});
export type AbuseReportsQuery = z.infer<typeof abuseReportsQuerySchema>;

// ── TLS-RPT reports (RFC 8460) ─────────────────────────────────────────────
//
// About INBOUND delivery to this platform's MX: a receiver reports whether it
// could negotiate TLS to us. A failure is ours to fix, not the sender's.

export const tlsFailureSchema = z.object({
  resultType: z.string(),
  failedSessionCount: z.number().int().nonnegative(),
  receivingMxHostname: z.string().nullable(),
  sendingMtaIp: z.string().nullable(),
  failureReasonCode: z.string().nullable(),
  additionalInformation: z.string().nullable(),
});
export type TlsFailure = z.infer<typeof tlsFailureSchema>;

export const tlsReportSchema = z.object({
  id: z.string(),
  policyDomain: z.string().nullable(),
  tenantId: z.string().nullable(),
  tenantName: z.string().nullable(),
  /** The receiving operator that sent the report. */
  orgName: z.string().nullable(),
  contactInfo: z.string().nullable(),
  reportId: z.string().nullable(),
  dateRangeStart: z.string().nullable(),
  dateRangeEnd: z.string().nullable(),
  successfulSessions: z.number().int().nonnegative(),
  failedSessions: z.number().int().nonnegative(),
  failures: z.array(tlsFailureSchema).default([]),
  receivedAt: z.string(),
});
export type TlsReport = z.infer<typeof tlsReportSchema>;

export const tlsReportsOverviewSchema = z.object({
  windowDays: z.number().int().positive(),
  reports: z.array(tlsReportSchema).default([]),
  total: z.number().int().nonnegative(),
  /** Sessions across the whole window, so a failure count has a denominator. */
  totalSuccessfulSessions: z.number().int().nonnegative(),
  totalFailedSessions: z.number().int().nonnegative(),
  /**
   * Null when there were no sessions at all — NOT 1. "100% success of nothing"
   * is the same lie the DMARC pass rate is careful not to tell.
   */
  successRate: z.number().min(0).max(1).nullable(),
  intakeLocalPart: z.string(),
});
export type TlsReportsOverview = z.infer<typeof tlsReportsOverviewSchema>;

export const tlsReportsQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /** Only reports that recorded at least one failed session. */
  failingOnly: z.coerce.boolean().optional(),
});
export type TlsReportsQuery = z.infer<typeof tlsReportsQuerySchema>;
