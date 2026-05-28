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
import type {
  NotificationAudience,
  NotificationSeverity,
  NotificationChannelId,
  NotificationGdprBasis,
} from '@k8s-hosting/api-contracts';

export interface CategoryDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly audience: NotificationAudience;
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
    displayName: 'Password reset requested',
    description: 'Sent when a password reset link is requested for your account.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ['in_app', 'email'],
    isMandatory: true,
    gdprBasis: 'contract',
  },
  {
    id: 'security.password_changed',
    displayName: 'Password changed',
    description: 'Confirmation that your account password was updated.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ['in_app', 'email'],
    isMandatory: true,
    gdprBasis: 'contract',
  },
  {
    id: 'security.suspicious_activity',
    displayName: 'Suspicious sign-in activity',
    description: 'Sign-in from an unusual location or device.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ['in_app', 'email'],
    isMandatory: true,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 3600,
    rateLimitMax: 5,
  },
  {
    id: 'subscription.expiry_warning',
    displayName: 'Subscription expiring soon',
    description: 'Your hosting subscription will expire shortly — action required.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ['in_app', 'email'],
    isMandatory: true,
    gdprBasis: 'contract',
  },
  {
    id: 'subscription.renewed',
    displayName: 'Subscription renewed',
    description: 'Your hosting subscription was renewed for another billing cycle.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'subscription.changed',
    displayName: 'Subscription changed',
    description: 'Your subscription plan or billing details were modified.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'account.sub_account_added',
    displayName: 'Sub-account added',
    description: 'A new sub-user was added to your account.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'tasks.scheduled_failure',
    displayName: 'Scheduled task failed',
    description: 'A scheduled task (cronjob, backup, etc.) failed to complete.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 3600,
    rateLimitMax: 3,
  },
  {
    id: 'tenant.suspended',
    displayName: 'Account suspended',
    description: 'Your hosting account was suspended.',
    audience: 'tenant',
    defaultSeverity: 'error',
    defaultChannels: ['in_app', 'email'],
    isMandatory: true,
    gdprBasis: 'contract',
  },
  {
    id: 'tenant.restored',
    displayName: 'Account restored',
    description: 'Your hosting account was reactivated.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'contract',
  },
  {
    id: 'tenant.archived',
    displayName: 'Account archived',
    description: 'Your hosting account was archived — data is retained read-only.',
    audience: 'tenant',
    defaultSeverity: 'error',
    defaultChannels: ['in_app', 'email'],
    isMandatory: true,
    gdprBasis: 'contract',
  },
  {
    id: 'tenant.deleted',
    displayName: 'Account scheduled for deletion',
    description: 'Your hosting account is being permanently removed.',
    audience: 'tenant',
    defaultSeverity: 'critical',
    defaultChannels: ['in_app', 'email'],
    isMandatory: true,
    gdprBasis: 'contract',
  },
];

const ADMIN_CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: 'admin.cert_expiring',
    displayName: 'Certificate expiring',
    description: 'A managed TLS certificate is approaching expiry.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.cert_renewal_failed',
    displayName: 'Certificate renewal failed',
    description: 'Automated TLS certificate renewal failed and needs operator attention.',
    audience: 'admin',
    defaultSeverity: 'error',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.backup_failed',
    displayName: 'Backup failed',
    description: 'A scheduled platform or tenant backup did not complete successfully.',
    audience: 'admin',
    defaultSeverity: 'error',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.backup_target_unreachable',
    displayName: 'Backup target unreachable',
    description: 'The configured backup destination cannot be contacted.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
    rateLimitWindowS: 43200,
    rateLimitMax: 1,
  },
  {
    id: 'admin.node_down',
    displayName: 'Cluster node down',
    description: 'A cluster node has gone offline or NotReady.',
    audience: 'admin',
    defaultSeverity: 'critical',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'admin.security_hardening_drift',
    displayName: 'Security hardening drift',
    description: 'A node has drifted from the desired security hardening baseline.',
    audience: 'admin',
    defaultSeverity: 'warning',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
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
    displayName: 'General notification (info)',
    description: 'Legacy fall-through for callers that did not declare a category.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'legacy.warning',
    displayName: 'General notification (warning)',
    description: 'Legacy fall-through for callers that did not declare a category.',
    audience: 'tenant',
    defaultSeverity: 'warning',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'legacy.error',
    displayName: 'General notification (error)',
    description: 'Legacy fall-through for callers that did not declare a category.',
    audience: 'tenant',
    defaultSeverity: 'error',
    defaultChannels: ['in_app', 'email'],
    isMandatory: false,
    gdprBasis: 'legitimate_interest',
  },
  {
    id: 'legacy.success',
    displayName: 'General notification (success)',
    description: 'Legacy fall-through for callers that did not declare a category.',
    audience: 'tenant',
    defaultSeverity: 'info',
    defaultChannels: ['in_app', 'email'],
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
