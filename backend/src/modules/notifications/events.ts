/**
 * Phase 3 of tenant-panel email parity round 2: typed notification
 * event helpers.
 *
 * Each helper takes a minimal payload shape, resolves the tenant's
 * notification recipients via getTenantNotificationRecipients, and
 * fans out the pre-formatted notification. Call-sites never build
 * titles/messages by hand — they pass domain data and let the
 * helper produce consistent wording, types, and resource tags.
 *
 * Rationale: notification copy and severity levels should be owned
 * by this module so we can change them in one place. The ecosystem
 * (mailboxes service, DKIM scheduler, IMAPSync runner, email-domains
 * service) should only know about the *event*, not the presentation.
 */

import { emitEvent } from './dispatcher/dispatch.js';
import type { Database } from '../../db/index.js';

/**
 * Phase 1 of the notification-system rewrite: every legacy event
 * helper ALSO calls the categorised dispatcher so the new
 * notification_deliveries audit log accumulates rows. The legacy
 * notifyUsers path is preserved so behaviour doesn't regress on
 * call-sites that read the `notifications` table directly.
 *
 * Failures from emitEvent are swallowed — the existing helpers were
 * fire-and-forget and we don't want to change that contract.
 */
async function dispatchSafe(
  db: Database,
  categoryId: string,
  scope: Parameters<typeof emitEvent>[1]['scope'],
  variables: object,
  tenantId?: string,
  extraOpts?: {
    readonly dedupeKey?: string;
    readonly externalRecipients?: readonly string[];
    /** What the event is ABOUT, when that differs from the scope. */
    readonly resourceType?: string;
    readonly resourceId?: string;
  },
): Promise<void> {
  try {
    await emitEvent(db, {
      categoryId,
      scope,
      variables: { ...variables } as Record<string, unknown>,
      tenantId,
      dedupeKey: extraOpts?.dedupeKey,
      externalRecipients: extraOpts?.externalRecipients,
      resourceType: extraOpts?.resourceType,
      resourceId: extraOpts?.resourceId,
    });
  } catch {
    // Legacy contract: never throw from an event helper.
  }
}

// ──────────────────────────────────────────────────────────────────
// Mailbox limit reached — DELIBERATELY NOT A NOTIFICATION
// ──────────────────────────────────────────────────────────────────
//
// There was a `notifyTenantMailboxLimitReached` here. It is gone, and nothing
// should replace it. Operator decision 2026-09-16.
//
// It fired synchronously from the tenant's OWN failed click: `createMailbox`
// rejects with 409 CLIENT_MAILBOX_LIMIT_REACHED, carrying the limit, the
// current count and the remediation, which the panel renders on the spot. The
// mailbox page already shows the used/quota bar, and the tenant cannot create
// another mailbox anyway. So the notification restated — by EMAIL — a number
// the user was looking at, about an action they had just taken and already
// seen fail.
//
// That is the general shape to avoid: a notification fired from a request path
// about a rejection the caller can already see is noise by construction. It
// also made the platform's own report-intake reconciler mail every capped
// tenant every 5 minutes, because a retrying caller re-triggered it forever.

// ──────────────────────────────────────────────────────────────────
// DKIM key rotated
// ──────────────────────────────────────────────────────────────────

export interface DkimRotatedPayload {
  readonly emailDomainId: string;
  readonly domainName: string;
  readonly selector: string;
}

/**
 * Fire when the DKIM rotation scheduler rolls a new key for a
 * tenant's email domain. Info level — no action required from the
 * tenant but they should know the key material changed.
 */
export async function notifyTenantDkimRotated(
  db: Database,
  tenantId: string,
  payload: DkimRotatedPayload,
): Promise<void> {
  await dispatchSafe(db, 'tenant.mail_event', { kind: 'tenant', tenantId }, {
    // "DKIM" and "selector" are terms for whoever runs a mail server, not for
    // the person who owns the domain. What the tenant needs to know is that
    // the thing proving their mail is genuine was replaced, and that they do
    // not have to do anything.
    subsystem: 'Email signing key',
    objectLabel: payload.domainName,
    detail:
      'The cryptographic key that proves mail from this domain is genuine was replaced automatically. '
      + 'Mail keeps flowing throughout — receivers pick up the new key from DNS.',
    severityLabel: 'replaced',
    recommendedAction: 'Nothing to do — the platform manages this key for you.',
  }, tenantId);
}

// ──────────────────────────────────────────────────────────────────
// IMAPSync terminal state
// ──────────────────────────────────────────────────────────────────

// Note: we accept 'completed' as an alias for 'succeeded' so the
// helper remains friendly to future code / tests that use either
// wording. The IMAPSync reconciler uses 'succeeded' as the terminal
// success state.
export type ImapsyncTerminalStatus = 'succeeded' | 'completed' | 'failed' | 'cancelled';

export interface ImapsyncTerminalPayload {
  readonly jobId: string;
  /**
   * The mailbox being migrated INTO — the only thing a tenant needs to
   * identify this notification, and the thing it did not carry.
   *
   * Required. The old payload had no mailbox at all, so the subject was built
   * from the job id: `objectLabel: \`job ${jobId}\``. The dispatcher then
   * resolved that id against tenants, users, mailboxes and domains, matched
   * none of them (it is a JOB id), and substituted its placeholder — leaving
   * the tenant with "IMAPSync migration: job (unnamed)".
   */
  readonly mailboxAddress: string;
  /** Where the mail is being copied FROM, for context. */
  readonly sourceHost?: string;
  readonly status: ImapsyncTerminalStatus;
  readonly messagesTransferred?: number;
  readonly errorMessage?: string;
}

function isTerminal(status: string): status is ImapsyncTerminalStatus {
  return (
    status === 'succeeded'
    || status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
  );
}

/**
 * Fire when an IMAPSync migration job reaches a terminal state.
 * No-op for non-terminal statuses so the caller can blindly pipe
 * every status transition through this helper.
 */
export async function notifyTenantImapsyncTerminal(
  db: Database,
  tenantId: string,
  payload: ImapsyncTerminalPayload,
): Promise<void> {
  if (!isTerminal(payload.status)) return;

  // No recipient pre-check. Resolving recipients here and bailing when the
  // list is empty is what made the old path invisible: the dispatcher owns
  // scope resolution, records the event either way, and can reach audiences
  // (like a mailbox owner) that have no user row to resolve at all.
  // No hand-derived `title` or `type` any more: the template builds the
  // subject and the category supplies the severity. Those two locals existed
  // only because the legacy path had nowhere else to put them.
  // Plain language, on purpose. "IMAPSync" is the name of the tool the
  // platform happens to shell out to; a tenant migrating their mail from an
  // old host has never heard it and gains nothing from it. What they want is
  // WHICH mailbox, whether it worked, and how much moved.
  const outcomeLabel = (() => {
    if (payload.status === 'succeeded' || payload.status === 'completed') return 'finished';
    if (payload.status === 'failed') return 'failed';
    return 'was cancelled';
  })();

  const detail = (() => {
    if (payload.status === 'succeeded' || payload.status === 'completed') {
      const count = payload.messagesTransferred ?? 0;
      return count === 1
        ? '1 message was copied across.'
        : `${count} messages were copied across.`;
    }
    if (payload.status === 'failed') {
      return payload.errorMessage
        ? `The error was: ${payload.errorMessage}`
        : 'Open the migration on your Email page to see what went wrong.';
    }
    return 'It was stopped before it finished, so some mail may not have been copied.';
  })();

  // Every key written as `name: value`, never shorthand and never a
  // conditional spread. The variable-contract guard reads the payload keys out
  // of this literal with `^\s*(\w+):` — shorthand (`detail,`) and a spread
  // (`...(x ? { y } : {})`) are both invisible to it, so it reported three
  // variables as supplied by nobody. `sourceLabel` is undefined rather than
  // absent when there is no source host; the template guards it with
  // `{{#if sourceLabel}}`, which treats undefined as absent, so nothing
  // renders as "(copying from )".
  await dispatchSafe(db, 'tenant.mailbox_migration', { kind: 'tenant', tenantId }, {
    mailboxAddress: payload.mailboxAddress,
    outcomeLabel: outcomeLabel,
    detail: detail,
    sourceLabel: payload.sourceHost,
    recommendedAction: payload.status === 'failed'
      ? 'You can start the migration again from the Email page once the problem is fixed.'
      : '',
  }, tenantId);
}

// ──────────────────────────────────────────────────────────────────
// Email bootstrap confirmation
// ──────────────────────────────────────────────────────────────────

export interface EmailBootstrappedPayload {
  readonly emailDomainId: string;
  readonly domainName: string;
}

/**
 * Fire when a tenant enables email on a domain for the first time.
 * Success level — confirms a tenant-initiated action.
 */
export async function notifyTenantEmailBootstrapped(
  db: Database,
  tenantId: string,
  payload: EmailBootstrappedPayload,
): Promise<void> {
  await dispatchSafe(db, 'tenant.mail_event', { kind: 'tenant', tenantId }, {
    subsystem: 'Email hosting',
    objectLabel: payload.domainName,
    detail: 'Email hosting is now active for this domain.',
    severityLabel: 'enabled',
    recommendedAction: 'Create mailboxes and configure DNS from the tenant panel Mail page.',
  }, tenantId);
}

// ──────────────────────────────────────────────────────────────────
// Webmail cert / provisioning failure
// ──────────────────────────────────────────────────────────────────
//
// Round-4 Phase 2 review HIGH-2: notifyTenantWebmailCertFailed was
// removed as a dead code path. The previous behaviour was to fire
// an "error" notification whenever ensureRouteCertificate threw —
// but in dev (and any environment using HTTP-01 ACME without real
// DNS propagation) this was a false alarm because the Ingress was
// still created without TLS and serving HTTP. The new
// `webmail_status` column on `email_domains` tracks the lifecycle
// in a way the UI can render directly without the noise.
//
// If a future iteration adds a real "webmail provisioning broke
// in a way the user must manually fix" path, re-add the helper
// here and call it from the corresponding error branch in
// ensureWebmailIngress.

// ──────────────────────────────────────────────────────────────────
// Phase 1 categorised event helpers
// ──────────────────────────────────────────────────────────────────
//
// Thin wrappers around emitEvent that bake in the category id +
// recipient scope so call-sites pass only their domain payload.

export interface SubscriptionChangedPayload {
  readonly tenantName?: string;
  readonly oldPlanName?: string;
  readonly newPlanName?: string;
}
export async function notifyTenantSubscriptionChanged(
  db: Database,
  tenantId: string,
  payload: SubscriptionChangedPayload = {},
): Promise<void> {
  await dispatchSafe(db, 'subscription.changed', { kind: 'tenant', tenantId }, payload, tenantId);
}

export interface SubscriptionRenewedPayload {
  readonly tenantName?: string;
  readonly newExpiresAt: string;
}
/**
 * Fire when a tenant's subscription_expires_at advances past its
 * previous value — admin manual renewal today, auto-renewal worker
 * tomorrow. The category is informational (non-mandatory).
 */
export async function notifyTenantSubscriptionRenewed(
  db: Database,
  tenantId: string,
  payload: SubscriptionRenewedPayload,
): Promise<void> {
  await dispatchSafe(db, 'subscription.renewed', { kind: 'tenant', tenantId }, payload, tenantId);
}

export interface SubscriptionExpiryPayload {
  readonly tenantName?: string;
  readonly expiresAt: string;
  readonly daysUntilExpiry?: number;
}
/**
 * The `dedupeKey` argument lets the scheduler call this from a daily
 * cron without flooding the tenant inbox — the dispatcher silently
 * skips when the same key has fired for this recipient in the last 30
 * days. Format the key as
 *   `subscription-expiry:<tenantId>:<daysOut>:<expiryDate>`
 * so that each (tenant, warning slot, expiry slot) emits at most once.
 */
export async function notifyTenantSubscriptionExpiry(
  db: Database,
  tenantId: string,
  payload: SubscriptionExpiryPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(
    db,
    'subscription.expiry_warning',
    { kind: 'tenant', tenantId },
    payload,
    tenantId,
    { dedupeKey },
  );
}

export interface SubAccountAddedPayload {
  readonly tenantName?: string;
  readonly subAccountEmail: string;
}
export async function notifyTenantSubAccountAdded(
  db: Database,
  tenantId: string,
  payload: SubAccountAddedPayload,
): Promise<void> {
  await dispatchSafe(db, 'account.sub_account_added', { kind: 'tenant', tenantId }, payload, tenantId);
}

export async function notifyTenantPasswordChanged(
  db: Database,
  userId: string,
): Promise<void> {
  // No `userName` here on purpose. This passed `userName: userId` — a raw id
  // as the display name, which would have rendered "Hi 3fd54013-…" had it ever
  // been called. The dispatcher resolves the recipient's real name per
  // recipient, which is the only place that knows who is being addressed.
  await dispatchSafe(db, 'security.password_changed', { kind: 'user', userId }, {});
}

// `notifyTenantSuspiciousActivity` and its payload lived here.
//
// Removed 2026-09-16 (operator decision). It had templates on every channel
// and no caller, because nothing on the platform defines "suspicious".
// Detecting it means choosing a security policy — is a new source IP
// suspicious? a new user-agent? a new country? — and the wrong choice either
// cries wolf at every coffee-shop login or stays silent through a real
// takeover. A source that can never fire is worse than none, because it reads
// as coverage.

export interface TenantCertificatePayload {
  readonly hostname: string;
  readonly errorMessage?: string;
  readonly expiresAt?: string;
}

/**
 * Success has no error to report.
 *
 * `tls.certificate_issued` used to reuse TenantCertificatePayload, which
 * carries `errorMessage` — so the variable-contract guard correctly flagged a
 * field collected for a category whose template can never render it. A shared
 * interface across success and failure hides exactly that: the emitter looks
 * like it supplies something meaningful and the reader never sees it.
 */
export interface TenantCertificateIssuedPayload {
  readonly hostname: string;
  readonly expiresAt?: string;
}

/**
 * TLS issuance failed for a tenant hostname.
 *
 * Both audiences get told: the tenant because their visitors are the
 * ones seeing the browser warning and the usual cause (DNS not pointed
 * at the platform yet) is theirs to fix, the operator because a
 * platform-side cause (a broken DNS-01 solver, an exhausted ACME rate
 * limit) is invisible to the tenant.
 */
export async function notifyTenantCertificateFailed(
  db: Database,
  tenantId: string,
  payload: TenantCertificatePayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'tls.certificate_failed', { kind: 'tenant', tenantId }, payload, tenantId, { dedupeKey });
}

export async function notifyTenantCertificateIssued(
  db: Database,
  tenantId: string,
  payload: TenantCertificateIssuedPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'tls.certificate_issued', { kind: 'tenant', tenantId }, payload, tenantId, { dedupeKey });
}

/** A wildcard could not be issued; per-hostname certs are standing in. */
export async function notifyTenantCertificateFallback(
  db: Database,
  tenantId: string,
  payload: TenantCertificatePayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'tls.certificate_fallback', { kind: 'tenant', tenantId }, payload, tenantId, { dedupeKey });
}

export interface AdminCertIssuanceFailedPayload {
  readonly certSubject: string;
  readonly tenantName?: string;
  readonly errorMessage?: string;
}
export async function notifyAdminCertIssuanceFailed(
  db: Database,
  payload: AdminCertIssuanceFailedPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.cert_issuance_failed', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminCertExpiringPayload {
  readonly certSubject: string;
  readonly expiresAt: string;
}
export async function notifyAdminCertExpiring(
  db: Database,
  payload: AdminCertExpiringPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.cert_expiring', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminCertRenewalFailedPayload {
  readonly certSubject: string;
  readonly errorMessage?: string;
}
export async function notifyAdminCertRenewalFailed(
  db: Database,
  payload: AdminCertRenewalFailedPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.cert_renewal_failed', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminBackupFailedPayload {
  readonly backupName: string;
  readonly errorMessage?: string;
}
export async function notifyAdminBackupFailed(
  db: Database,
  payload: AdminBackupFailedPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.backup_failed', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminBackupTargetUnreachablePayload {
  readonly targetName: string;
  readonly errorMessage?: string;
}
export async function notifyAdminBackupTargetUnreachable(
  db: Database,
  payload: AdminBackupTargetUnreachablePayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.backup_target_unreachable', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminBackupStalePayload {
  /** namespace/name of the schedule that stopped producing backups. */
  readonly backupName: string;
  /** Consecutive SCHEDULED fires missed — not elapsed hours. */
  readonly missedFires: string;
  /** How long ago the last success was, already formatted (e.g. "92.4h"). */
  readonly lastSuccessAge: string;
  /** The cron the runs were expected on, so the count can be checked. */
  readonly schedule: string;
  readonly detail: string;
}
/**
 * A schedule that WAS producing backups and has stopped. Dedupe belongs to the
 * caller: the freshness sweep re-evaluates every tick and must not re-notify a
 * condition the operator has already been told about.
 */
export async function notifyAdminBackupStale(
  db: Database,
  payload: AdminBackupStalePayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.backup_stale', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminBackupNeverRunPayload {
  readonly backupName: string;
  readonly schedule: string;
  /** How long the schedule has existed without ever succeeding. */
  readonly configuredAge: string;
  readonly detail: string;
}
/**
 * A schedule that has NEVER succeeded. Separate from stale on purpose — see the
 * category comment in categories/seed.ts.
 */
export async function notifyAdminBackupNeverRun(
  db: Database,
  payload: AdminBackupNeverRunPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.backup_never_run', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminWalArchiveFailingPayload {
  readonly clusterName: string;
  /** pg_wal as a % of the data volume (e.g. "62"). */
  readonly pressurePercent: string;
  readonly reason?: string;
}
export async function notifyAdminWalArchiveFailing(
  db: Database,
  payload: AdminWalArchiveFailingPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.wal_archive_failing', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminWalArchiveAutoDisabledPayload {
  readonly clusterName: string;
  readonly reason?: string;
}
export async function notifyAdminWalArchiveAutoDisabled(
  db: Database,
  payload: AdminWalArchiveAutoDisabledPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.wal_archive_auto_disabled', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminNodeDownPayload {
  readonly nodeName: string;
}
export async function notifyAdminNodeDown(
  db: Database,
  payload: AdminNodeDownPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.node_down', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminNodeRebootingPayload {
  readonly nodeName: string;
}
/**
 * A node has left Ready and is shutting down. Best-effort by nature: on a
 * single-node cluster the API server is drained with the node, so this often
 * cannot be sent at all — `admin.node_startup_complete` is the one that always
 * arrives. dedupeKey is per (node x boot) so a drain lasting several ticks
 * notifies once.
 */
export interface AdminTenantAutoRepinnedPayload {
  readonly tenantName: string;
  readonly strandedOn: string;
}
/**
 * An HA-tier tenant was unpinned from an offline node so it could reschedule.
 * Warning, not info: nothing is broken, but the operator's explicit placement
 * decision was overridden by the platform and they need to know. dedupeKey is
 * per (tenant x node) so a multi-tick outage notifies once.
 */
export async function notifyAdminTenantAutoRepinned(
  db: Database,
  payload: AdminTenantAutoRepinnedPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.tenant_auto_repinned', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export async function notifyAdminNodeRebooting(
  db: Database,
  payload: AdminNodeRebootingPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.node_rebooting', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminNodeStartupCompletePayload {
  readonly nodeName: string;
  /** Approximate outage, pre-rendered ("6m 50s"). Overstates by up to one tick. */
  readonly downtimeText: string;
  /** " at 14:32 UTC" or "" — leading space included so the sentence reads. */
  readonly bootedAtText: string;
  /** Says whether the shutdown was announced; explains the gap when it wasn't. */
  readonly announcementNote: string;
}
/**
 * A node finished booting and is Ready. Keyed on the kubelet's bootID, so it
 * fires once per real reboot and never for a NotReady flap. dedupeKey is per
 * (node x bootID).
 */
export async function notifyAdminNodeStartupComplete(
  db: Database,
  payload: AdminNodeStartupCompletePayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.node_startup_complete', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminNodeMemoryEventPayload {
  readonly nodeName: string;
  /** Human summary, e.g. "3 tenant pod(s) evicted" or "kernel SystemOOM (2 events)". */
  readonly summary: string;
}
/**
 * Node memory events (operator decision 2026-07-25): SystemOOM / evictions
 * touching SYSTEM workloads dispatch critical; tenant-only evictions
 * dispatch warning. Caller supplies an hour-scoped dedupeKey so a
 * sustained incident notifies at most once per node/class/hour (the
 * category rate limits back-stop bursts).
 */
export async function notifyAdminNodeMemoryEvents(
  db: Database,
  severity: 'critical' | 'warning',
  payload: AdminNodeMemoryEventPayload,
  dedupeKey?: string,
): Promise<void> {
  const categoryId = severity === 'critical'
    ? 'admin.node_memory_event_critical'
    : 'admin.node_memory_event_warning';
  await dispatchSafe(db, categoryId, { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminSecurityHardeningDriftPayload {
  readonly nodeName: string;
  readonly driftSummary?: string;
}
export async function notifyAdminSecurityHardeningDrift(
  db: Database,
  payload: AdminSecurityHardeningDriftPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.security_hardening_drift', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminSloAlertPayload {
  readonly ruleId: string;
  readonly ruleName: string;
  /** Maps to the admin.slo_alert_<severity> category on firing. */
  readonly severity: 'critical' | 'warning';
  readonly description?: string;
  readonly value?: string;
  /**
   * WHICH object is affected, rendered for humans — e.g.
   * `certificate=wildcard-tls namespace=tenant-acme`.
   *
   * Absent only for genuinely cluster-wide rules. Before this existed the
   * admin got "Certificate not Ready" with no way to tell which
   * certificate, in which namespace, for which tenant — the alert named a
   * symptom and nothing else.
   */
  readonly subject?: string;
  /** Raw labels behind `subject`, so surfaces can link to the object. */
  readonly subjectLabels?: Record<string, string>;
}
/**
 * Fire when an SLO monitoring rule (ADR-051 evaluator) transitions to
 * firing. The evaluator owns the 24h re-notify throttle via
 * alert_state.lastNotifiedAt, so callers normally omit dedupeKey.
 */
export async function notifyAdminSloAlertFiring(
  db: Database,
  payload: AdminSloAlertPayload,
  dedupeKey?: string,
): Promise<void> {
  const categoryId = payload.severity === 'critical'
    ? 'admin.slo_alert_critical'
    : 'admin.slo_alert_warning';
  await dispatchSafe(db, categoryId, { kind: 'admin' }, payload, undefined, { dedupeKey });
}

/** Fire when a previously-firing SLO monitoring rule recovers. */
export async function notifyAdminSloAlertResolved(
  db: Database,
  payload: AdminSloAlertPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.slo_alert_resolved', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

// ── R4/R6 PR 4: outbound-mail protection ───────────────────────────────────

export interface AdminSubscriptionsExpiringPayload {
  readonly tenantCount: string;
  readonly horizonDays: string;
  readonly tenantList: string;
  readonly occurredAt: string;
}
/**
 * Subscriptions approaching expiry, aggregated for the operator.
 *
 * The tenant-facing warning has existed since Phase 4; the operator, who has
 * to chase the renewal, was never told at all. One notification per run rather
 * than one per tenant per slot — the fleet view is a list, not a stream.
 */
export async function notifyAdminSubscriptionsExpiring(
  db: Database,
  payload: AdminSubscriptionsExpiringPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.subscriptions_expiring', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface TenantResourceSaturationPayload {
  readonly resource: string;
  readonly usedPct: string;
  readonly used: string;
  readonly limit: string;
  readonly unit: string;
  readonly occurredAt: string;
}
/**
 * A tenant resource crossed its warning or critical threshold.
 *
 * The operator has always been told (admin.tenant_resource_saturation_*). The
 * TENANT — the only party who can delete files or upgrade the plan — was not,
 * because the event was given exactly one audience when it was built. This is
 * the other half.
 */
export async function notifyTenantResourceSaturation(
  db: Database,
  tenantId: string,
  level: 'warning' | 'critical',
  payload: TenantResourceSaturationPayload,
  dedupeKey?: string,
): Promise<void> {
  const categoryId = level === 'critical'
    ? 'tenant.resource_saturation_critical'
    : 'tenant.resource_saturation_warning';
  await dispatchSafe(db, categoryId, { kind: 'tenant', tenantId }, payload, tenantId, { dedupeKey });
}

export interface AdminEmailQuotaPayload {
  readonly tenantLabel: string;
  readonly window: string;
  readonly used: string;
  readonly limit: string;
  readonly percent: string;
  readonly occurredAt: string;
  /** The accounts that actually sent — "a@x (48), b@x (5)". */
  readonly topSenders: string;
}
/**
 * A tenant saturated its sending limit.
 *
 * The mirror image of the gap above: this event was built tenant-only, so the
 * operator never learned that a tenant was hammering the limit — which is the
 * shape of both a compromised account and a platform-wide deliverability risk.
 */
export async function notifyAdminEmailQuotaExceeded(
  db: Database,
  payload: AdminEmailQuotaPayload,
  dedupeKey?: string,
  /**
   * The tenant this is ABOUT. Not the scope — the notification goes to
   * operators — but the subject, so the row carries a resource and the links
   * point at that tenant instead of the tenant LIST, which shows no sending
   * limits at all. Production's copy of this alert linked to /tenants.
   */
  subjectTenantId?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.email_quota_exceeded', { kind: 'admin' }, payload, undefined, {
    dedupeKey,
    resourceType: subjectTenantId ? 'tenant' : undefined,
    resourceId: subjectTenantId,
  });
}

export interface MailboxQuotaPayload {
  readonly mailboxAddress: string;
  readonly tenantName: string;
  readonly percent: string;
  readonly usedMb: string;
  readonly quotaMb: string;
  readonly occurredAt: string;
}

/**
 * A mailbox crossed a storage threshold.
 *
 * TWO audiences, which is the whole point. The tenant admin gets it in their
 * panel and by email; the mailbox owner — who has NO platform account and is
 * therefore invisible to every user-id-based resolver in the system — is
 * mailed directly at the mailbox address. That second binding is why the old
 * implementation notified nobody: it resolved recipients from `mailbox_access`,
 * a table with zero rows platform-wide.
 */
export async function notifyMailboxQuotaThreshold(
  db: Database,
  tenantId: string,
  mailboxAddress: string,
  payload: MailboxQuotaPayload,
  opts: { readonly exceeded: boolean; readonly dedupeKey?: string },
): Promise<void> {
  await dispatchSafe(
    db,
    opts.exceeded ? 'mailbox.quota_exceeded' : 'mailbox.quota_threshold',
    { kind: 'tenant', tenantId },
    payload,
    tenantId,
    { dedupeKey: opts.dedupeKey, externalRecipients: [mailboxAddress] },
  );
}

/**
 * The shared shape for subsystem operational events.
 *
 * Identity-first on purpose: which subsystem, which object, what happened,
 * when, and what to do. The ~20 raw `db.insert(notifications)` call sites this
 * replaces built a title and a message by hand and named the object only when
 * the author happened to interpolate it — and carried no category, so they
 * reached no template, no email, no preference gate and no delivery audit.
 */
export interface EscalationPayload {
  readonly count: string;
  readonly ageHours: string;
  readonly summary: string;
}
/**
 * Action notifications that went unread past the deadline.
 *
 * Escalates to the OPERATOR because they are the party who can act when the
 * recipient has not. Fires once per notification — `notifications.escalated_at`
 * enforces that, because an escalation that repeats every tick becomes the
 * noise it was built to cut through.
 */
export async function notifyAdminEscalation(
  db: Database,
  payload: EscalationPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.notification_escalated', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface DigestPayload {
  readonly itemCount: string;
  readonly summary: string;
  readonly items: string;
}
/**
 * The periodic digest itself.
 *
 * Emitted from the digest scheduler through the ORDINARY dispatch path, so it
 * gets a template, a delivery row and a retry like anything else. A digest
 * that bypassed the machinery would be a fourth delivery path with extra steps.
 *
 * Scope is `user`, not `tenant`: a digest is one person's batch.
 */
export async function notifyUserDigest(
  db: Database,
  userId: string,
  payload: DigestPayload,
): Promise<void> {
  await dispatchSafe(db, 'platform.digest', { kind: 'user', userId }, payload);
}

export interface OperationalEventPayload {
  readonly subsystem: string;
  /** The specific thing: a node name, a domain, a volume, a job id. */
  readonly objectLabel: string;
  /** One sentence of specifics, ending in a full stop. */
  readonly detail: string;
  readonly severityLabel: string;
  /** What the reader should do. Empty string when genuinely nothing. */
  readonly recommendedAction: string;
}

const OPERATIONAL_CATEGORY = {
  storage: 'admin.storage_event',
  node: 'admin.node_event',
  database: 'admin.database_event',
  mail: 'admin.mail_event',
  platform: 'admin.platform_event',
  integrity: 'admin.tenant_integrity',
} as const;

export type OperationalSubsystem = keyof typeof OPERATIONAL_CATEGORY;

/** Operator-facing subsystem event. */
export async function notifyAdminOperationalEvent(
  db: Database,
  subsystem: OperationalSubsystem,
  payload: OperationalEventPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, OPERATIONAL_CATEGORY[subsystem], { kind: 'admin' }, payload, undefined, { dedupeKey });
}

/** Tenant-facing domain-verification state. */
export async function notifyTenantDomainVerification(
  db: Database,
  tenantId: string,
  payload: OperationalEventPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'tenant.domain_verification', { kind: 'tenant', tenantId }, payload, tenantId, { dedupeKey });
}

/** Tenant-facing backup/restore outcome. */
export async function notifyTenantBackupEvent(
  db: Database,
  tenantId: string,
  payload: OperationalEventPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'tenant.backup_event', { kind: 'tenant', tenantId }, payload, tenantId, { dedupeKey });
}

export interface AdminClusterCapacityPayload {
  readonly level: string;
  readonly clusterPct: string;
  readonly clusterDetail: string;
  readonly worstNode: string;
  readonly recommendedAction: string;
  readonly occurredAt: string;
}
/**
 * Cluster storage capacity crossed a threshold.
 *
 * Moved off the raw-insert path 2026-09-15. It used to call
 * `db.insert(notifications)` directly, which reaches no template, no email, no
 * push, no preference gate and no delivery audit — and `category_id` is
 * nullable, so the row could not even be listed in the admin Sources screen.
 * The 80% warning and the 95% critical for every Longhorn node in the fleet
 * were in-app only, forever.
 */
export async function notifyAdminClusterCapacity(
  db: Database,
  payload: AdminClusterCapacityPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.cluster_storage_capacity', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminMailboxQuotaFleetPayload {
  readonly mailboxCount: string;
  readonly tenantCount: string;
  /** Every affected mailbox with its tenant and contact, already formatted. */
  readonly mailboxList: string;
  readonly occurredAt: string;
}
/**
 * The operator's view: ONE aggregated notification naming every mailbox at
 * 100%, its tenant and its contact.
 *
 * Replaces the `mail-mailbox-over-quota` SLO rule, which alerted on
 * `max(platform_mail_mailboxes_over_quota) > 0` — a single global counter with
 * `subjectLabels: []`, structurally incapable of naming a mailbox, a tenant or
 * a contact. A mailbox filling up is a tenant capacity event, not a platform
 * service-level objective.
 */
export async function notifyAdminMailboxQuotaFleet(
  db: Database,
  payload: AdminMailboxQuotaFleetPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.mailbox_quota_fleet', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface ScheduledTaskFailurePayload {
  readonly taskName: string;
  readonly errorMessage: string;
}
/**
 * A tenant's scheduled task (web cron) run failed.
 *
 * `tasks.scheduled_failure` shipped with templates on all three channels and
 * NO emitter anywhere — the cron scheduler recorded `lastRunStatus: 'failed'`
 * with the response body and told nobody. A tenant's nightly job could fail
 * every night indefinitely and the only trace was a column in the panel they
 * had to think to open.
 *
 * Dedupe per (job, day): a job on a 5-minute schedule that is broken would
 * otherwise send 288 notifications before breakfast.
 */
export async function notifyTenantScheduledTaskFailure(
  db: Database,
  tenantId: string,
  payload: ScheduledTaskFailurePayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'tasks.scheduled_failure', { kind: 'tenant', tenantId }, payload, tenantId, { dedupeKey });
}

export interface TenantEmailQuotaPayload {
  readonly window: 'hour' | 'day';
  readonly percent: string;
  readonly used: string;
  readonly limit: string;
  /** Which of the tenant's own accounts sent — they need this to find it. */
  readonly topSenders: string;
}
/** 80% crossing — the mail-events threshold evaluator owns dedupe. */
export async function notifyTenantEmailQuotaWarning(
  db: Database,
  tenantId: string,
  payload: TenantEmailQuotaPayload,
): Promise<void> {
  await dispatchSafe(db, 'tenant.email_quota_warning', { kind: 'tenant', tenantId }, payload, tenantId);
}
/** 100% crossing. */
export async function notifyTenantEmailQuotaExceeded(
  db: Database,
  tenantId: string,
  payload: TenantEmailQuotaPayload,
): Promise<void> {
  await dispatchSafe(db, 'tenant.email_quota_exceeded', { kind: 'tenant', tenantId }, payload, tenantId);
}

// ── Mail monitoring (2026-07): send-limit saturation + blocklist ───────────

export interface AdminEmailAbusePayload {
  readonly tenantLabel: string;
  readonly domain: string;
  readonly rateLimited: string;
  readonly quotaRejected: string;
  readonly total: string;
  readonly window: string;
  readonly recommendedAction: string;
}
/**
 * A tenant is producing abnormal rate-limited / quota-rejected outbound
 * volume. `dedupeKey` (caller passes tenant+level+hour bucket) makes it
 * fire at most once per tenant/level/hour while the burst persists.
 */
export async function notifyAdminEmailSendingAbuse(
  db: Database,
  level: 'warning' | 'critical',
  payload: AdminEmailAbusePayload,
  dedupeKey?: string,
): Promise<void> {
  const categoryId = level === 'critical'
    ? 'admin.email_abuse_critical'
    : 'admin.email_abuse_warning';
  await dispatchSafe(db, categoryId, { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface AdminMailBlocklistedPayload {
  readonly ip: string;
  readonly list: string;
  readonly severity: string;
  readonly lookupUrl?: string;
}
/**
 * A server-role sending IP is listed on a DNSBL. `dedupeKey` (caller
 * passes ip+list+day bucket) fires it at most once per (ip,list) per day
 * while the listing persists.
 */
export async function notifyAdminMailBlocklisted(
  db: Database,
  payload: AdminMailBlocklistedPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.mail_blocklisted', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

export interface CustomDeploymentRolledBackPayload {
  readonly deploymentName: string;
  /** Digest that was pulled and failed to start. */
  readonly failedDigest: string;
  /** Digest restored, or 'none' when there was nothing to restore. */
  readonly restoredDigest: string;
  /**
   * Deep link to the deployment in the tenant panel.
   *
   * The email template has always rendered `{{panelUrl}}` as its call to
   * action and no caller ever supplied it, so under strict mode the bare
   * reference threw and the EMAIL leg of this notification could never be
   * delivered — a rolled-back deployment told the tenant nothing by mail.
   */
  readonly panelUrl?: string;
}
/**
 * An auto-update pulled a republished image that never became Ready, so the
 * platform restored the previous digest and switched auto-update OFF.
 *
 * The tenant MUST be told: their container silently changed underneath them,
 * it broke, and the automation they enabled is now disabled. Every one of
 * those three facts is something they would otherwise discover by accident.
 */
export async function notifyTenantCustomDeploymentRolledBack(
  db: Database,
  tenantId: string,
  payload: CustomDeploymentRolledBackPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(
    db,
    'tenant.custom_deployment_rolled_back',
    { kind: 'tenant', tenantId },
    payload,
    tenantId,
    { dedupeKey },
  );
}

export interface AdminMailHealthDegradedPayload {
  /** Operator-facing component name: 'pod' | 'JMAP API' | 'certificate' | … */
  readonly component: string;
  readonly mailHostname: string;
  /**
   * One sentence of specifics, ALREADY prefixed with a leading space (or ''):
   * templates have no conditionals, so an absent detail must render as nothing
   * rather than as a dangling separator.
   */
  readonly detail?: string;
  readonly panelUrl?: string;
}
/**
 * A mail-server health COMPONENT is failing (not merely warning).
 *
 * Until now the only mail signal that ever reached a notification channel was
 * a DNSBL listing: mail health itself was computed on demand for the admin
 * modal, and the periodic collector published Prometheus gauges only. So a
 * cluster could serve a self-signed certificate on 465/993, or have Stalwart
 * down entirely, and nothing told the operator on any configured channel.
 *
 * Callers pass a dedupeKey of `mail-health:<component>:<12h bucket>` so a
 * sustained outage alerts twice a day per component, not every pass.
 */
export async function notifyAdminMailHealthDegraded(
  db: Database,
  payload: AdminMailHealthDegradedPayload,
  dedupeKey?: string,
): Promise<void> {
  await dispatchSafe(db, 'admin.mail_health_degraded', { kind: 'admin' }, payload, undefined, { dedupeKey });
}

// ── Resource monitoring (2026-07): per-tenant CPU/memory/storage saturation ─

export interface AdminTenantSaturationPayload {
  readonly tenantLabel: string;
  /** 'CPU' | 'memory' | 'storage' */
  readonly resource: string;
  readonly usedPct: string;
  readonly used: string;
  readonly limit: string;
  /** e.g. ' cores', ' GiB' — leading space kept so "4 GiB" renders cleanly. */
  readonly unit: string;
}
/**
 * A tenant crossed a warning/critical fraction of its CPU/memory/storage
 * allocation. `dedupeKey` (caller passes tenant+resource+level+hour bucket)
 * fires it at most once per tenant/resource/level/hour while sustained.
 */
export async function notifyAdminTenantResourceSaturation(
  db: Database,
  tenantId: string,
  level: 'warning' | 'critical',
  payload: AdminTenantSaturationPayload,
  dedupeKey?: string,
): Promise<void> {
  const categoryId = level === 'critical'
    ? 'admin.tenant_resource_saturation_critical'
    : 'admin.tenant_resource_saturation_warning';
  // tenantId tags the row so the admin notification deep-links to /tenants/<id>
  // (recipients stay admin-scoped — tenantId only sets resourceType/resourceId).
  await dispatchSafe(db, categoryId, { kind: 'admin' }, payload, tenantId, { dedupeKey });
}

// ── Per-tenant OOM kill (Phase 1d) ──────────────────────────────────────────

export interface AdminOomPayload {
  readonly tenantLabel: string;
  readonly podName: string;
  readonly containerName: string;
  readonly restartCount: string;
  /** Subject fragment from describeOomEvent() — confirmed vs inferred kill. */
  readonly killSummary: string;
  /** Body sentence from describeOomEvent(), including the remediation hint. */
  readonly killDetail: string;
}
/**
 * A tenant container was OOM-killed. `dedupeKey` (caller passes
 * tenant+pod+container+restartCount) fires once per distinct kill — a new kill
 * bumps restartCount and re-alerts; a still-Running-after-old-kill pod does not.
 */
export async function notifyAdminTenantOom(
  db: Database,
  tenantId: string,
  payload: AdminOomPayload,
  dedupeKey?: string,
): Promise<void> {
  // tenantId tags the row so the admin notification deep-links to /tenants/<id>.
  await dispatchSafe(db, 'admin.tenant_pod_oom', { kind: 'admin' }, payload, tenantId, { dedupeKey });
}

// ── Custom deployment failure (CrashLoopBackOff / ImagePullBackOff / OOM) ────

export interface AdminCustomDeploymentFailedPayload {
  /** Tenant display name, resolved so the admin doesn't decode a namespace. */
  readonly tenantLabel: string;
  /** The custom deployment's name (what the tenant sees in their panel). */
  readonly deploymentName: string;
  /** Diagnostic reason, e.g. "app: CrashLoopBackOff — back-off restarting failed container". */
  readonly reason: string;
}
/**
 * A tenant custom deployment transitioned into `failed`. Before this the status
 * flipped to failed in the DB (with a diagnostic message) but nothing told the
 * operator — the container just restarted forever with no signal. `dedupeKey`
 * (deployment id + reason) fires once per distinct failure episode; a NEW reason
 * re-alerts, a still-failing-for-the-same-reason deployment does not.
 */
export async function notifyAdminCustomDeploymentFailed(
  db: Database,
  tenantId: string,
  payload: AdminCustomDeploymentFailedPayload,
  dedupeKey?: string,
): Promise<void> {
  // tenantId tags the row so the admin notification deep-links to /tenants/<id>.
  await dispatchSafe(db, 'admin.custom_deployment_failed', { kind: 'admin' }, payload, tenantId, { dedupeKey });
}

// ── Monthly bandwidth (BW-3): admin + tenant alerts at 80/90/100% ───────────

export interface AdminBandwidthPayload {
  readonly tenantLabel: string;
  readonly usedPct: string;
  readonly used: string;
  readonly limit: string;
}
export async function notifyAdminTenantBandwidth(
  db: Database,
  tenantId: string,
  level: 'warning' | 'critical',
  payload: AdminBandwidthPayload,
  dedupeKey?: string,
): Promise<void> {
  const categoryId = level === 'critical' ? 'admin.tenant_bandwidth_critical' : 'admin.tenant_bandwidth_warning';
  // tenantId tags the row so the admin notification deep-links to /tenants/<id>.
  await dispatchSafe(db, categoryId, { kind: 'admin' }, payload, tenantId, { dedupeKey });
}

export interface TenantBandwidthPayload {
  readonly usedPct: string;
  readonly used: string;
  readonly limit: string;
}
export async function notifyTenantBandwidth(
  db: Database,
  tenantId: string,
  level: 'warning' | 'critical',
  payload: TenantBandwidthPayload,
  dedupeKey?: string,
): Promise<void> {
  const categoryId = level === 'critical' ? 'tenant.bandwidth_exceeded' : 'tenant.bandwidth_warning';
  await dispatchSafe(db, categoryId, { kind: 'tenant', tenantId }, payload, tenantId, { dedupeKey });
}
