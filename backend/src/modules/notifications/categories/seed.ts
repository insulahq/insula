/**
 * Notification category seed data.
 *
 * This is the canonical catalogue of "event kinds" the platform emits.
 * Each entry maps to one row in `notification_categories`, inserted
 * idempotently at boot by categories/service.ts:seedCategoriesIfMissing.
 *
 * Adding a new category here = a new event kind. The operator can then
 * edit per-user opt-out, rate-limits, or active flag via the admin
 * Settings → Notifications UI — but the row itself is owned by code.
 *
 * Ordering rule: tenant-facing first, admin-facing second, legacy
 * fall-throughs last. Within each block sort by `id` ASC so diff
 * review is stable.
 */
import type { NotificationClass } from '../routing/classes.js';
import type { Subsystem } from '../routing/channel-spec.js';
import type {
  NotificationAudience,
  NotificationSeverity,
  NotificationChannelId,
  NotificationGdprBasis,
} from '@insula/api-contracts';
// Every category starts with EVERY channel on. Derived from the channel enum,
// so adding a channel needs no edit here — see ALL_NOTIFICATION_CHANNELS for
// why (ntfy shipped fully built and stayed off on all fifty sources).
//
// NOTE: this deliberately overrides the one category that used to be in-app
// only, `tls.certificate_issued` — it was kept off email so tenants are not
// mailed on every routine renewal. Operator decision 2026-09-04 was that every
// source starts with every channel; turn it back off for that source in the
// admin panel if the renewal mail proves noisy.
//
// The list is rebuilt here from a total `Record<NotificationChannelId, true>`
// rather than imported as a value from `@insula/api-contracts`. This file is
// executed by `ci-notification-template-coverage.sh` through node's
// type-stripping loader, which resolves no `node_modules` and builds no
// packages — a runtime (non-`type`) import from the contracts package makes
// that guard fail to even load the seed. The Record keeps the compile-time
// guarantee that mattered: add a channel to the enum without adding it here
// and tsc fails, so the list can never silently fall behind.
const EVERY_CHANNEL: Record<NotificationChannelId, true> = {
  in_app: true,
  email: true,
  ntfy: true,
};
const ALL_NOTIFICATION_CHANNELS = Object.keys(EVERY_CHANNEL) as readonly NotificationChannelId[];

export interface CategoryDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly audience: NotificationAudience;
  /**
   * WHY the recipient is being told, which decides whether the message leaves
   * the platform UI at all. Severity says how loud; class says how far.
   */
  readonly cls: NotificationClass;
  /**
   * The subsystem this event REPORTS ON. The router excludes any channel that
   * depends on it, so an alert about mail is never sent by mail and an alert
   * about the platform being down is never left in the platform's own panel.
   */
  readonly reportsOn: Subsystem | null;
  readonly defaultSeverity: NotificationSeverity;
  readonly defaultChannels: readonly NotificationChannelId[];
  readonly isMandatory: boolean;
  readonly gdprBasis: NotificationGdprBasis;
  readonly rateLimitWindowS?: number;
  readonly rateLimitMax?: number;
}

const TENANT_CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: 'security.password_reset',
    cls: 'security',
    reportsOn: 'security',
    displayName: 'Password reset requested',
    description: 'Sent when a password reset link is requested for your account.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: true,
    gdprBasis: 'contract',
  },
  {
    id: 'security.password_changed',
    cls: 'security',
    reportsOn: 'security',
    displayName: 'Password changed',
    description: 'Confirmation that your account password was updated.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: true,
    gdprBasis: 'contract',
  },
  {
    id: 'security.suspicious_activity',
    cls: 'security',
    reportsOn: 'security',
    displayName: 'Suspicious sign-in activity',
    description: 'Sign-in from an unusual location or device.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: true,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 3600,
    rateLimitMax: 5,
  },
  {
    id: 'subscription.expiry_warning',
    cls: 'action',
    reportsOn: 'billing',
    displayName: 'Subscription expiring soon',
    description: 'Your hosting subscription will expire shortly — action required.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: true,
    gdprBasis: 'contract',
  },
  {
    id: 'subscription.renewed',
    cls: 'record',
    reportsOn: 'billing',
    displayName: 'Subscription renewed',
    description: 'Your hosting subscription was renewed for another billing cycle.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'subscription.changed',
    cls: 'record',
    reportsOn: 'billing',
    displayName: 'Subscription changed',
    description: 'Your subscription plan or billing details were modified.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'account.sub_account_added',
    cls: 'security',
    reportsOn: 'security',
    displayName: 'Sub-account added',
    description: 'A new sub-user was added to your account.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'mailbox.quota_threshold',
    cls: 'action',
    reportsOn: 'mail',
    displayName: 'Mailbox nearing its storage quota',
    description: 'A mailbox crossed 80%, 90% or 99% of its storage quota. Sent to the tenant admin AND mailed directly to the mailbox owner, who has no platform account.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'mailbox.quota_exceeded',
    cls: 'incident',
    reportsOn: 'mail',
    displayName: 'Mailbox storage quota full',
    description: 'A mailbox is at 100% of its storage quota and new mail to it is being rejected.',
    audience: 'tenant',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'tasks.scheduled_failure',
    cls: 'action',
    reportsOn: 'compute',
    displayName: 'Scheduled task failed',
    description: 'A scheduled task (cronjob, backup, etc.) failed to complete.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 3600,
    rateLimitMax: 3,
  },
  {
    id: 'tenant.suspended',
    cls: 'security',
    reportsOn: 'billing',
    displayName: 'Account suspended',
    description: 'Your hosting account was suspended.',
    audience: 'tenant',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: true,
    gdprBasis: 'contract',
  },
  {
    id: 'tenant.restored',
    cls: 'record',
    reportsOn: 'billing',
    displayName: 'Account restored',
    description: 'Your hosting account was reactivated.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'tenant.archived',
    cls: 'record',
    reportsOn: 'billing',
    displayName: 'Account archived',
    description: 'Your hosting account was archived — data is retained read-only.',
    audience: 'tenant',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: true,
    gdprBasis: 'contract',
  },
  {
    id: 'tenant.deleted',
    cls: 'record',
    reportsOn: 'billing',
    displayName: 'Account scheduled for deletion',
    description: 'Your hosting account is being permanently removed.',
    audience: 'tenant',
    defaultSeverity: 'critical',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: true,
    gdprBasis: 'contract',
  },
  {
    // TLS state is tenant-visible: their visitors are the ones seeing a
    // browser warning, and the usual cause (DNS not pointed at us yet,
    // or a customer-managed zone) is something only they can fix.
    id: 'tls.certificate_failed',
    cls: 'action',
    reportsOn: 'tls',
    displayName: 'Certificate could not be issued',
    description:
      'A TLS certificate for one of your domains could not be issued. Visitors will see a security warning until it is.',
    audience: 'tenant',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'tls.certificate_issued',
    cls: 'ambient',
    reportsOn: 'tls',
    displayName: 'Certificate issued',
    description: 'A TLS certificate for one of your domains was issued or renewed.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'tls.certificate_fallback',
    cls: 'action',
    reportsOn: 'tls',
    displayName: 'Wildcard certificate unavailable',
    description:
      'A wildcard certificate could not be issued, so individual per-hostname certificates are being used instead. New subdomains will not be covered automatically until the wildcard succeeds.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
];

const ADMIN_CATEGORIES: readonly CategoryDefinition[] = [
  {
    // Distinct from cert_renewal_failed: this is FIRST issuance, where
    // the tenant has no working certificate at all (browser warning),
    // not a renewal of one that is still valid for weeks.
    id: 'admin.cert_issuance_failed',
    cls: 'action',
    reportsOn: 'tls',
    displayName: 'Certificate issuance failed',
    description:
      'A TLS certificate for a tenant domain could not be issued. The hostname has no valid certificate until this is resolved.',
    audience: 'admin',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.cert_expiring',
    cls: 'action',
    reportsOn: 'tls',
    displayName: 'Certificate expiring',
    description: 'A managed TLS certificate is approaching expiry.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.cert_renewal_failed',
    cls: 'action',
    reportsOn: 'tls',
    displayName: 'Certificate renewal failed',
    description: 'Automated TLS certificate renewal failed and needs operator attention.',
    audience: 'admin',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.backup_failed',
    cls: 'incident',
    reportsOn: 'storage',
    displayName: 'Backup failed',
    description: 'A scheduled platform or tenant backup did not complete successfully.',
    audience: 'admin',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.backup_target_unreachable',
    cls: 'incident',
    reportsOn: 'storage',
    displayName: 'Backup target unreachable',
    description: 'The configured backup destination cannot be contacted.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 43200,
    rateLimitMax: 1,
  },
  {
    id: 'admin.node_down',
    cls: 'availability',
    reportsOn: 'platform',
    displayName: 'Cluster node down',
    description: 'A cluster node has gone offline or NotReady.',
    audience: 'admin',
    defaultSeverity: 'critical',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.tenant_auto_repinned',
    cls: 'ambient',
    reportsOn: 'compute',
    displayName: 'Tenant automatically re-pinned',
    description: 'An HA-tier tenant was pinned to a node that went offline. Because its data has a replica on a healthy node, the platform cleared the pin so the tenant could reschedule. Local-tier tenants are never moved automatically.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.node_rebooting',
    cls: 'availability',
    reportsOn: 'platform',
    displayName: 'Node rebooting',
    description: 'A cluster node has begun shutting down. On a single-node cluster the control plane goes down with it, so this cannot always be sent — the startup notification reports the reboot either way.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.node_startup_complete',
    cls: 'availability',
    reportsOn: 'platform',
    displayName: 'Node startup complete',
    description: 'A cluster node finished booting and is Ready again, with the approximate downtime.',
    audience: 'admin',
    defaultSeverity: 'info',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.node_memory_event_critical',
    cls: 'incident',
    reportsOn: 'compute',
    displayName: 'Node memory event (system)',
    description: 'Kernel SystemOOM on a node, or a SYSTEM workload was evicted under memory pressure — the eviction design (tenants first) should make this rare.',
    audience: 'admin',
    defaultSeverity: 'critical',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 3600,
    rateLimitMax: 6,
  },
  {
    id: 'admin.node_memory_event_warning',
    cls: 'action',
    reportsOn: 'compute',
    displayName: 'Node memory event (tenant evictions)',
    description: 'Tenant pods were evicted by the kubelet under node memory pressure. This is the designed backpressure; frequent occurrences mean the node is oversubscribed or a tenant needs a bigger plan.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 3600,
    rateLimitMax: 4,
  },
  {
    id: 'admin.security_hardening_drift',
    cls: 'action',
    reportsOn: 'security',
    displayName: 'Security hardening drift',
    description: 'A node has drifted from the desired security hardening baseline.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.slo_alert_critical',
    cls: 'incident',
    reportsOn: null,
    displayName: 'SLO alert firing (critical)',
    description: 'A critical SLO monitoring rule is firing (ADR-051 evaluator). Immediate operator '
      + 'attention required — see Monitoring → SLOs.',
    audience: 'admin',
    defaultSeverity: 'critical',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.slo_alert_resolved',
    cls: 'ambient',
    reportsOn: null,
    displayName: 'SLO alert resolved',
    description: 'A previously-firing SLO monitoring rule has recovered.',
    audience: 'admin',
    defaultSeverity: 'info',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.slo_alert_warning',
    cls: 'action',
    reportsOn: null,
    displayName: 'SLO alert firing (warning)',
    description: 'A warning-level SLO monitoring rule is firing (ADR-051 evaluator). '
      + 'See Monitoring → SLOs.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.wal_archive_failing',
    cls: 'incident',
    reportsOn: 'database',
    displayName: 'Database WAL archiving failing',
    description: 'PostgreSQL continuous WAL archiving to the configured backup target is failing. '
      + 'Un-archived WAL accumulates on disk until the volume fills — fix the backup target sink.',
    audience: 'admin',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 21600, // at most once / 6h while failing
    rateLimitMax: 1,
  },
  {
    id: 'admin.wal_archive_auto_disabled',
    cls: 'incident',
    reportsOn: 'database',
    displayName: 'Database WAL archiving auto-disabled',
    description: 'WAL archiving was AUTOMATICALLY disabled because it kept failing and pg_wal was '
      + 'filling the data volume. Backups for this database are now OFF (no PITR) until an operator '
      + 'fixes the sink and re-enables archiving.',
    audience: 'admin',
    defaultSeverity: 'critical',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: true, // safety-critical — operators cannot opt out
    gdprBasis: 'legitimate_interest',
  },
  // ── R4/R6 PR 4: outbound-mail protection (send quotas + FBL complaints) ──
  {
    id: 'tenant.email_quota_warning',
    cls: 'action',
    reportsOn: 'mail',
    displayName: 'Email sending quota at 80%',
    description: 'Your outbound email usage crossed 80% of the hourly or daily limit. '
      + 'Further messages may be deferred once the limit is reached.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'tenant.email_quota_exceeded',
    cls: 'incident',
    reportsOn: 'mail',
    displayName: 'Email sending quota reached',
    description: 'Your outbound email usage reached the hourly or daily limit. '
      + 'Additional messages are deferred until the window rolls over.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'admin.email_complaint_warning',
    cls: 'action',
    reportsOn: 'mail',
    displayName: 'Spam complaint rate elevated',
    description: 'A sender domain crossed the 0.1% 7-day complaint-rate threshold (FBL reports / '
      + 'sends). Throttle territory — investigate the sender. See Monitoring → Mail.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.email_complaint_critical',
    cls: 'incident',
    reportsOn: 'mail',
    displayName: 'Spam complaint rate critical',
    description: 'A sender domain crossed the 0.3% 7-day complaint-rate threshold. Mailbox '
      + 'providers will start blocking — suspend outbound for the tenant unless clearly false. '
      + 'See Monitoring → Mail.',
    audience: 'admin',
    defaultSeverity: 'critical',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  // ── Mail monitoring (2026-07): outbound send-limit saturation + blocklist ──
  {
    id: 'admin.email_abuse_warning',
    cls: 'action',
    reportsOn: 'mail',
    displayName: 'Outbound send-limit saturation',
    description: 'A tenant is generating an abnormal volume of rate-limited / quota-rejected '
      + 'outbound mail (>= the warning threshold in the last hour) — a runaway sender or early '
      + 'abuse. Investigate before it becomes a complaint/reputation problem. See Monitoring → Mail.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.email_abuse_critical',
    cls: 'incident',
    reportsOn: 'mail',
    displayName: 'Outbound send-limit saturation (critical)',
    description: 'A tenant crossed the CRITICAL rate-limited / quota-rejected volume threshold in '
      + 'the last hour — almost certainly a compromised account or a broken loop hammering the send '
      + 'limit. Consider suspending outbound for the tenant. See Monitoring → Mail.',
    audience: 'admin',
    defaultSeverity: 'critical',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.mail_blocklisted',
    cls: 'incident',
    reportsOn: 'mail',
    displayName: 'Mail IP on a DNS blocklist',
    description: 'A server-role node IP that sends mail is listed on a DNS blocklist (DNSBL). '
      + 'Outbound deliverability is degraded until the IP is delisted. See Monitoring → Mail → '
      + 'Deliverability.',
    audience: 'admin',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 43200, // at most once / 12h per (ip,list) via dedupeKey; cap the fan-out too
    rateLimitMax: 8,
  },
  {
    id: 'tenant.custom_deployment_rolled_back',
    cls: 'action',
    reportsOn: 'compute',
    displayName: 'Container auto-update rolled back',
    description: 'An automatic image update for one of your containers failed to start, so the '
      + 'previous image was restored and auto-update was switched off for that container.',
    audience: 'tenant',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'admin.custom_deployment_failed',
    cls: 'action',
    reportsOn: 'compute',
    displayName: 'Custom deployment failed',
    description: 'A tenant custom container entered a failed state (CrashLoopBackOff, '
      + 'ImagePullBackOff, OOMKilled, or timed out). The notification names the tenant, the '
      + 'deployment, and the container reason so the operator can diagnose it without hunting '
      + 'through the cluster; the container will keep restarting until fixed or stopped.',
    audience: 'admin',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 3600, // dedupeKey already fires once per (deployment,reason); cap the fan-out
    rateLimitMax: 20,
  },
  {
    id: 'admin.mail_health_degraded',
    cls: 'incident',
    reportsOn: 'mail',
    displayName: 'Mail server health check failing',
    description: 'A mail-server health component is FAILING — the Stalwart pod, its JMAP API, the '
      + 'RocksDB store, the TLS certificate, a mail port, or the external deliverability probes. '
      + 'Mail is likely not being delivered. See Monitoring → Mail.',
    audience: 'admin',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    // Matches the scheduler's 12h dedupe bucket per component. The cap is the
    // backstop for the fan-out: six components, so eight leaves headroom for a
    // total outage without turning one bad night into a mailbox full of alerts.
    rateLimitWindowS: 43200,
    rateLimitMax: 8,
  },
  // ── Resource monitoring (2026-07): per-tenant CPU/memory/storage saturation ──
  {
    id: 'admin.tenant_resource_saturation_warning',
    cls: 'action',
    reportsOn: 'compute',
    displayName: 'Tenant resource usage high',
    description: 'A tenant crossed the warning threshold (≈90%) of its CPU, memory, or storage '
      + 'allocation. May indicate a runaway workload or a tenant that needs a bigger plan. See the '
      + 'tenant\'s Resource Limits.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 3600, // dedupe is per (tenant,resource,hour); cap total fan-out too
    rateLimitMax: 20,
  },
  {
    id: 'admin.tenant_resource_saturation_critical',
    cls: 'incident',
    reportsOn: 'compute',
    displayName: 'Tenant resource usage at limit',
    description: 'A tenant reached its CPU/memory/storage limit — workloads may be throttled, '
      + 'OOM-killed, or unable to write. Raise the tenant\'s limit/plan or investigate the workload.',
    audience: 'admin',
    defaultSeverity: 'critical',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 3600,
    rateLimitMax: 20,
  },
  // ── Phase 1d: per-tenant OOM-kill alert ──
  {
    id: 'admin.tenant_pod_oom',
    cls: 'action',
    reportsOn: 'compute',
    displayName: 'Tenant workload OOM-killed',
    description: 'A tenant container was killed by the kernel out-of-memory killer. Repeated kills '
      + 'usually mean the workload needs a larger memory limit/plan or has a leak — check the '
      + 'tenant\'s Resource Limits and the deployment.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 3600,
    rateLimitMax: 30,
  },
  // ── Monthly bandwidth (BW-3): 80/90 warning, 100 critical (cap active) ──
  {
    id: 'admin.subscriptions_expiring',
    cls: 'action',
    reportsOn: 'billing',
    displayName: 'Subscriptions expiring soon',
    description: 'Aggregated list of tenants whose subscription expires within the warning horizon. The tenant-facing warning has always existed; the operator, who chases the renewal, was never told.',
    audience: 'admin',
    defaultSeverity: 'info',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.email_quota_exceeded',
    cls: 'incident',
    reportsOn: 'mail',
    displayName: 'Tenant saturated its sending limit',
    description: 'A tenant hit 100% of its hourly or daily sending limit. Visible to the operator because a saturated sender is the shape of both a compromised account and a platform-wide deliverability risk — previously only the tenant was told.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.cluster_storage_capacity',
    cls: 'incident',
    reportsOn: 'storage',
    displayName: 'Cluster storage capacity',
    description: 'Longhorn commit ratio crossed 80% (warning) or 95% (critical) cluster-wide or on any node. Previously written straight into the notifications table with NO category, so it could never be emailed, pushed, muted or audited — an operator learned the cluster was nearly full by happening to open the panel.',
    audience: 'admin',
    defaultSeverity: 'critical',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: true,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.mailbox_quota_fleet',
    cls: 'action',
    reportsOn: 'mail',
    displayName: 'Mailboxes over storage quota (fleet)',
    description: 'One aggregated notification naming every mailbox at 100% of quota, with its tenant and contact. Replaces the mail-mailbox-over-quota SLO rule, which read a global counter and could name nothing.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.tenant_bandwidth_warning',
    cls: 'ambient',
    reportsOn: 'network',
    displayName: 'Tenant bandwidth usage high',
    description: 'A tenant crossed 80%/90% of its monthly bandwidth allowance. At 100% the '
      + 'tenant\'s sites are capped (509) until the month resets — raise the limit/plan if this '
      + 'is expected growth.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 3600,
    rateLimitMax: 20,
  },
  {
    id: 'admin.tenant_bandwidth_critical',
    cls: 'action',
    reportsOn: 'network',
    displayName: 'Tenant bandwidth cap active',
    description: 'A tenant reached 100% of its monthly bandwidth allowance — its sites are now '
      + 'capped (HTTP 509) until the calendar month resets. Raise the limit/plan to restore '
      + 'serving immediately.',
    audience: 'admin',
    defaultSeverity: 'critical',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 3600,
    rateLimitMax: 20,
  },
  {
    id: 'tenant.resource_saturation_warning',
    cls: 'action',
    reportsOn: 'storage',
    displayName: 'Resource nearing its limit',
    description: 'A tenant resource (storage, CPU or memory) has crossed 90% of its limit. The operator has always been told; the tenant — the only party who can delete files or upgrade — was not.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'tenant.resource_saturation_critical',
    cls: 'incident',
    reportsOn: 'storage',
    displayName: 'Resource limit reached',
    description: 'A tenant resource is at or above its critical threshold (95% for storage, 100% for CPU and memory) and writes or workloads are being refused.',
    audience: 'tenant',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'tenant.bandwidth_warning',
    cls: 'action',
    reportsOn: 'network',
    displayName: 'Bandwidth usage high',
    description: 'Your monthly data-transfer usage crossed 80%/90% of your allowance. If you reach '
      + '100%, your sites will be temporarily unavailable until the month resets — upgrade your '
      + 'plan to increase the allowance.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'tenant.bandwidth_exceeded',
    cls: 'incident',
    reportsOn: 'network',
    displayName: 'Bandwidth limit reached',
    description: 'You reached your monthly data-transfer limit. Your sites are temporarily '
      + 'unavailable (HTTP 509) until the month resets. Upgrade your plan to restore them now.',
    audience: 'tenant',
    defaultSeverity: 'critical',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'contract',
  },
];

/**
 * Legacy categories — used by notifyUser/notifyUsers call-sites that
 * don't supply a category. Keeps every persisted row with a category
 * id so dispatcher metrics and operator filtering remain consistent.
 * Mandatory=false + basis=legitimate_interest so opt-out works.
 */
const LEGACY_CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: 'legacy.info',
    cls: 'ambient',
    reportsOn: null,
    displayName: 'General notification (info)',
    description: 'Legacy fall-through for callers that did not declare a category.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'legacy.warning',
    cls: 'action',
    reportsOn: null,
    displayName: 'General notification (warning)',
    description: 'Legacy fall-through for callers that did not declare a category.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'legacy.error',
    cls: 'incident',
    reportsOn: null,
    displayName: 'General notification (error)',
    description: 'Legacy fall-through for callers that did not declare a category.',
    audience: 'tenant',
    defaultSeverity: 'error',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'legacy.success',
    cls: 'ambient',
    reportsOn: null,
    displayName: 'General notification (success)',
    description: 'Legacy fall-through for callers that did not declare a category.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ALL_NOTIFICATION_CHANNELS,
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
];

export const ALL_CATEGORIES: readonly CategoryDefinition[] = [
  ...TENANT_CATEGORIES,
  ...ADMIN_CATEGORIES,
  ...LEGACY_CATEGORIES,
];

/** Map notification `type` (legacy 4-value) to legacy category id. */
export function legacyCategoryIdForType(
  type: 'info' | 'warning' | 'error' | 'success',
): string {
  switch (type) {
    case 'info': return 'legacy.info';
    case 'warning': return 'legacy.warning';
    case 'error': return 'legacy.error';
    case 'success': return 'legacy.success';
  }
}
