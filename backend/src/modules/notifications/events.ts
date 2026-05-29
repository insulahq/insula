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

import { notifyUsers } from './service.js';
import { getTenantNotificationRecipients } from './recipients.js';
import { emitEvent } from './dispatcher/dispatch.js';
import type { Database } from '../../db/index.js';
import type { MailboxLimitSource } from '../mailboxes/limit.js';

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
  extraOpts?: { readonly dedupeKey?: string },
): Promise<void> {
  try {
    await emitEvent(db, {
      categoryId,
      scope,
      variables: { ...variables } as Record<string, unknown>,
      tenantId,
      dedupeKey: extraOpts?.dedupeKey,
    });
  } catch {
    // Legacy contract: never throw from an event helper.
  }
}

// ──────────────────────────────────────────────────────────────────
// Mailbox limit reached
// ──────────────────────────────────────────────────────────────────

export interface MailboxLimitPayload {
  readonly limit: number;
  readonly current: number;
  readonly source: MailboxLimitSource;
}

/**
 * Fire when a tenant's create-mailbox call was rejected because the
 * plan (or per-tenant override) cap is full. Error level — it blocks
 * an action the tenant is actively trying to take.
 */
export async function notifyTenantMailboxLimitReached(
  db: Database,
  tenantId: string,
  payload: MailboxLimitPayload,
): Promise<void> {
  const recipients = await getTenantNotificationRecipients(db, tenantId);
  if (recipients.length === 0) return;

  const sourceText = payload.source === 'tenant_override' ? 'custom limit' : 'hosting plan';
  await notifyUsers(db, recipients, {
    type: 'error',
    title: 'Mailbox limit reached',
    message:
      `You have used ${payload.current} of ${payload.limit} mailboxes allowed by your ${sourceText}. `
      + 'New mailboxes cannot be created until you remove an existing one or upgrade your plan.',
    resourceType: 'tenant',
    resourceId: tenantId,
  });
}

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
  const recipients = await getTenantNotificationRecipients(db, tenantId);
  if (recipients.length === 0) return;

  await notifyUsers(db, recipients, {
    type: 'info',
    title: 'DKIM key rotated',
    message:
      `A new DKIM signing key (selector "${payload.selector}") was automatically generated for `
      + `${payload.domainName}. No action is required — the platform manages this for you.`,
    resourceType: 'email_domain',
    resourceId: payload.emailDomainId,
  });
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

  const recipients = await getTenantNotificationRecipients(db, tenantId);
  if (recipients.length === 0) return;

  const title = (() => {
    switch (payload.status) {
      case 'succeeded':
      case 'completed':
        return 'IMAPSync migration completed';
      case 'failed':
        return 'IMAPSync migration failed';
      case 'cancelled':
        return 'IMAPSync migration cancelled';
    }
  })();

  const type: 'success' | 'error' | 'warning' = (() => {
    switch (payload.status) {
      case 'succeeded':
      case 'completed':
        return 'success';
      case 'failed':
        return 'error';
      case 'cancelled':
        return 'warning';
    }
  })();

  const message = (() => {
    if (payload.status === 'succeeded' || payload.status === 'completed') {
      const count = payload.messagesTransferred ?? 0;
      return `IMAPSync migration job finished successfully. ${count} message(s) transferred.`;
    }
    if (payload.status === 'failed') {
      return `IMAPSync migration job failed. ${payload.errorMessage ?? 'See the job details in the tenant panel for the error log.'}`;
    }
    return 'IMAPSync migration job was cancelled before it could finish.';
  })();

  await notifyUsers(db, recipients, {
    type,
    title,
    message,
    resourceType: 'imapsync_job',
    resourceId: payload.jobId,
  });
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
  const recipients = await getTenantNotificationRecipients(db, tenantId);
  if (recipients.length === 0) return;

  await notifyUsers(db, recipients, {
    type: 'success',
    title: 'Email enabled for domain',
    message:
      `Email hosting is now active for ${payload.domainName}. You can create mailboxes and `
      + 'configure DNS from the tenant panel Mail page.',
    resourceType: 'email_domain',
    resourceId: payload.emailDomainId,
  });
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
  await dispatchSafe(db, 'security.password_changed', { kind: 'user', userId }, { userName: userId });
}

export interface SuspiciousActivityPayload {
  readonly newIp: string;
  readonly userAgent?: string;
}
export async function notifyTenantSuspiciousActivity(
  db: Database,
  userId: string,
  payload: SuspiciousActivityPayload,
): Promise<void> {
  await dispatchSafe(db, 'security.suspicious_activity', { kind: 'user', userId }, payload);
}

export interface AdminCertExpiringPayload {
  readonly certSubject: string;
  readonly expiresAt: string;
}
export async function notifyAdminCertExpiring(
  db: Database,
  payload: AdminCertExpiringPayload,
): Promise<void> {
  await dispatchSafe(db, 'admin.cert_expiring', { kind: 'admin' }, payload);
}

export interface AdminCertRenewalFailedPayload {
  readonly certSubject: string;
  readonly errorMessage?: string;
}
export async function notifyAdminCertRenewalFailed(
  db: Database,
  payload: AdminCertRenewalFailedPayload,
): Promise<void> {
  await dispatchSafe(db, 'admin.cert_renewal_failed', { kind: 'admin' }, payload);
}

export interface AdminBackupFailedPayload {
  readonly backupName: string;
  readonly errorMessage?: string;
}
export async function notifyAdminBackupFailed(
  db: Database,
  payload: AdminBackupFailedPayload,
): Promise<void> {
  await dispatchSafe(db, 'admin.backup_failed', { kind: 'admin' }, payload);
}

export interface AdminBackupTargetUnreachablePayload {
  readonly targetName: string;
  readonly errorMessage?: string;
}
export async function notifyAdminBackupTargetUnreachable(
  db: Database,
  payload: AdminBackupTargetUnreachablePayload,
): Promise<void> {
  await dispatchSafe(db, 'admin.backup_target_unreachable', { kind: 'admin' }, payload);
}

export interface AdminNodeDownPayload {
  readonly nodeName: string;
}
export async function notifyAdminNodeDown(
  db: Database,
  payload: AdminNodeDownPayload,
): Promise<void> {
  await dispatchSafe(db, 'admin.node_down', { kind: 'admin' }, payload);
}

export interface AdminSecurityHardeningDriftPayload {
  readonly nodeName: string;
  readonly driftSummary?: string;
}
export async function notifyAdminSecurityHardeningDrift(
  db: Database,
  payload: AdminSecurityHardeningDriftPayload,
): Promise<void> {
  await dispatchSafe(db, 'admin.security_hardening_drift', { kind: 'admin' }, payload);
}
