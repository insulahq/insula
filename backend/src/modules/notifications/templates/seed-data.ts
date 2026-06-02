/**
 * Seed templates — one row per (category, channel, locale='en').
 *
 * Email bodies are compact MJML (h1 + paragraph + optional CTA). In-app
 * bodies are short markdown.
 *
 * Variables follow a small convention:
 *   {{userName}}     — recipient's full name (or email local part)
 *   {{tenantName}}   — tenant display name (for tenant-scoped events)
 *   {{platformName}} — the brand name (default "Hosting Platform")
 *   + category-specific (e.g. {{newIp}} for suspicious_activity)
 *
 * NEVER include raw HTML in the seed bodies — Handlebars escape-by-default
 * neutralises var injection, but MJML compiles structured tags. Keep
 * structure in MJML, content in `{{ }}`.
 */
import type {
  NotificationBodyFormat,
  NotificationChannelId,
  NotificationTemplateVariable,
} from '@insula/api-contracts';

export interface SeedTemplate {
  readonly categoryId: string;
  readonly channel: NotificationChannelId;
  readonly locale: string;
  readonly subjectTemplate: string | null;
  readonly bodyTemplate: string;
  readonly bodyFormat: NotificationBodyFormat;
  readonly variablesSchema: readonly NotificationTemplateVariable[];
}

const COMMON_VARS: readonly NotificationTemplateVariable[] = [
  { name: 'userName', type: 'string', required: false },
  { name: 'tenantName', type: 'string', required: false },
  { name: 'platformName', type: 'string', required: false },
];

/**
 * Compact MJML wrapper. Keeps tests readable and operator-edit-friendly.
 * Most production styling is upstream of this in the Stalwart/Roundcube
 * branding layer; the seed templates are intentionally plain.
 */
function emailMjml(headline: string, paragraph: string, ctaText?: string, ctaUrl?: string): string {
  const cta = ctaText && ctaUrl
    ? `<mj-button href="${ctaUrl}">${ctaText}</mj-button>`
    : '';
  return `<mjml><mj-body><mj-section><mj-column>
<mj-text font-size="20px" font-weight="600">${headline}</mj-text>
<mj-text font-size="14px" line-height="22px">${paragraph}</mj-text>
${cta}
<mj-text font-size="12px" color="#999">This is an automated notification from {{platformName}}.</mj-text>
</mj-column></mj-section></mj-body></mjml>`;
}

const TENANT_TEMPLATES: readonly SeedTemplate[] = [
  // ── security.password_reset ────────────────────────────────────────
  {
    categoryId: 'security.password_reset',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Password reset requested',
    bodyTemplate: emailMjml(
      'Password reset requested',
      'A password reset was requested for your account ({{userName}}). If this was you, follow the link in the separate reset email to choose a new password.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: COMMON_VARS,
  },
  {
    categoryId: 'security.password_reset',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Password reset requested',
    bodyTemplate: 'A password reset was requested for your account. If this was not you, contact support immediately.',
    bodyFormat: 'plaintext',
    variablesSchema: COMMON_VARS,
  },

  // ── security.password_changed ──────────────────────────────────────
  {
    categoryId: 'security.password_changed',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Your password was changed',
    bodyTemplate: emailMjml(
      'Your password was changed',
      'The password for {{userName}} was updated. If you did not make this change, please contact support.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: COMMON_VARS,
  },
  {
    categoryId: 'security.password_changed',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Password changed',
    bodyTemplate: 'Your account password was updated.',
    bodyFormat: 'plaintext',
    variablesSchema: COMMON_VARS,
  },

  // ── security.suspicious_activity ───────────────────────────────────
  {
    categoryId: 'security.suspicious_activity',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Unusual sign-in to your account',
    bodyTemplate: emailMjml(
      'Unusual sign-in',
      'A sign-in to {{userName}} was detected from {{newIp}}. If this was not you, change your password immediately.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'newIp', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'security.suspicious_activity',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Unusual sign-in detected',
    bodyTemplate: 'A sign-in from {{newIp}} was detected. If this was not you, change your password immediately.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'newIp', type: 'string', required: true },
    ],
  },

  // ── subscription.expiry_warning ────────────────────────────────────
  {
    categoryId: 'subscription.expiry_warning',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Your subscription expires soon',
    bodyTemplate: emailMjml(
      'Subscription expiring soon',
      'Your subscription for {{tenantName}} expires on {{expiresAt}}. Renew now to avoid service interruption.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'expiresAt', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'subscription.expiry_warning',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Subscription expiring soon',
    bodyTemplate: 'Your subscription expires on {{expiresAt}}. Renew to avoid service interruption.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'expiresAt', type: 'string', required: true },
    ],
  },

  // ── subscription.renewed ───────────────────────────────────────────
  {
    categoryId: 'subscription.renewed',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Subscription renewed',
    bodyTemplate: emailMjml(
      'Subscription renewed',
      'Your subscription for {{tenantName}} was renewed. The next billing cycle starts on {{nextBillingAt}}.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'nextBillingAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'subscription.renewed',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Subscription renewed',
    bodyTemplate: 'Your subscription was renewed for another billing cycle.',
    bodyFormat: 'plaintext',
    variablesSchema: COMMON_VARS,
  },

  // ── subscription.changed ───────────────────────────────────────────
  {
    categoryId: 'subscription.changed',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Subscription changed',
    bodyTemplate: emailMjml(
      'Subscription changed',
      'Your subscription for {{tenantName}} was modified. Review the new plan in the tenant panel.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: COMMON_VARS,
  },
  {
    categoryId: 'subscription.changed',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Subscription changed',
    bodyTemplate: 'Your subscription was modified.',
    bodyFormat: 'plaintext',
    variablesSchema: COMMON_VARS,
  },

  // ── account.sub_account_added ──────────────────────────────────────
  {
    categoryId: 'account.sub_account_added',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Sub-account added',
    bodyTemplate: emailMjml(
      'New sub-account added',
      'A new sub-account {{subAccountEmail}} was added to {{tenantName}}.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subAccountEmail', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'account.sub_account_added',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Sub-account added',
    bodyTemplate: 'A new sub-account ({{subAccountEmail}}) was added.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subAccountEmail', type: 'string', required: true },
    ],
  },

  // ── tasks.scheduled_failure ────────────────────────────────────────
  {
    categoryId: 'tasks.scheduled_failure',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Scheduled task failed',
    bodyTemplate: emailMjml(
      'Scheduled task failed',
      'The scheduled task "{{taskName}}" failed: {{errorMessage}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'taskName', type: 'string', required: true },
      { name: 'errorMessage', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tasks.scheduled_failure',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Scheduled task failed',
    bodyTemplate: 'The scheduled task "{{taskName}}" failed.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'taskName', type: 'string', required: true },
    ],
  },

  // ── tenant.suspended ───────────────────────────────────────────────
  {
    categoryId: 'tenant.suspended',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Your account has been suspended',
    bodyTemplate: emailMjml(
      'Account suspended',
      'Your account {{tenantName}} has been suspended. Contact support to restore access.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: COMMON_VARS,
  },
  {
    categoryId: 'tenant.suspended',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Account suspended',
    bodyTemplate: 'Your account has been suspended. Contact support to restore access.',
    bodyFormat: 'plaintext',
    variablesSchema: COMMON_VARS,
  },

  // ── tenant.restored ────────────────────────────────────────────────
  {
    categoryId: 'tenant.restored',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Your account is active again',
    bodyTemplate: emailMjml(
      'Account restored',
      'Your account {{tenantName}} has been restored. All services are back online.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: COMMON_VARS,
  },
  {
    categoryId: 'tenant.restored',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Account restored',
    bodyTemplate: 'Your account has been restored. All services are back online.',
    bodyFormat: 'plaintext',
    variablesSchema: COMMON_VARS,
  },

  // ── tenant.archived ────────────────────────────────────────────────
  {
    categoryId: 'tenant.archived',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Your account has been archived',
    bodyTemplate: emailMjml(
      'Account archived',
      'Your account {{tenantName}} has been archived. Data is retained read-only.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: COMMON_VARS,
  },
  {
    categoryId: 'tenant.archived',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Account archived',
    bodyTemplate: 'Your account has been archived. Data is retained read-only.',
    bodyFormat: 'plaintext',
    variablesSchema: COMMON_VARS,
  },

  // ── tenant.deleted ─────────────────────────────────────────────────
  {
    categoryId: 'tenant.deleted',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Your account is being deleted',
    bodyTemplate: emailMjml(
      'Account deletion in progress',
      'Your account {{tenantName}} is being permanently deleted. This action cannot be undone.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: COMMON_VARS,
  },
  {
    categoryId: 'tenant.deleted',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Account deletion in progress',
    bodyTemplate: 'Your account is being permanently deleted.',
    bodyFormat: 'plaintext',
    variablesSchema: COMMON_VARS,
  },
];

const ADMIN_TEMPLATES: readonly SeedTemplate[] = [
  {
    categoryId: 'admin.cert_expiring',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'TLS certificate expiring',
    bodyTemplate: emailMjml(
      'Certificate expiring soon',
      'The certificate for {{certSubject}} expires on {{expiresAt}}.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'certSubject', type: 'string', required: true },
      { name: 'expiresAt', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'admin.cert_expiring',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Certificate expiring',
    bodyTemplate: 'Certificate for {{certSubject}} expires on {{expiresAt}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'certSubject', type: 'string', required: true },
      { name: 'expiresAt', type: 'string', required: true },
    ],
  },

  {
    categoryId: 'admin.cert_renewal_failed',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Certificate renewal failed',
    bodyTemplate: emailMjml(
      'Certificate renewal failed',
      'Renewal of certificate {{certSubject}} failed: {{errorMessage}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'certSubject', type: 'string', required: true },
      { name: 'errorMessage', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.cert_renewal_failed',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Cert renewal failed',
    bodyTemplate: 'Renewal of {{certSubject}} failed.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'certSubject', type: 'string', required: true },
    ],
  },

  {
    categoryId: 'admin.backup_failed',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Backup failed',
    bodyTemplate: emailMjml(
      'Backup failed',
      'Backup "{{backupName}}" failed: {{errorMessage}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'backupName', type: 'string', required: true },
      { name: 'errorMessage', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.backup_failed',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Backup failed',
    bodyTemplate: 'Backup "{{backupName}}" failed.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'backupName', type: 'string', required: true },
    ],
  },

  {
    categoryId: 'admin.backup_target_unreachable',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Backup target unreachable',
    bodyTemplate: emailMjml(
      'Backup target unreachable',
      'The backup target {{targetName}} cannot be reached: {{errorMessage}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'targetName', type: 'string', required: true },
      { name: 'errorMessage', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.backup_target_unreachable',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Backup target unreachable',
    bodyTemplate: 'Backup target {{targetName}} is unreachable.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'targetName', type: 'string', required: true },
    ],
  },

  {
    categoryId: 'admin.node_down',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Cluster node down',
    bodyTemplate: emailMjml(
      'Cluster node down',
      'Node {{nodeName}} is reporting NotReady.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'nodeName', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'admin.node_down',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Node down',
    bodyTemplate: 'Node {{nodeName}} is NotReady.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'nodeName', type: 'string', required: true },
    ],
  },

  {
    categoryId: 'admin.security_hardening_drift',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Security hardening drift detected',
    bodyTemplate: emailMjml(
      'Security hardening drift',
      'Node {{nodeName}} has drifted from baseline: {{driftSummary}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'nodeName', type: 'string', required: true },
      { name: 'driftSummary', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.security_hardening_drift',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Hardening drift',
    bodyTemplate: 'Hardening drift on {{nodeName}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'nodeName', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'admin.wal_archive_failing',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Database WAL archiving is failing ({{clusterName}})',
    bodyTemplate: emailMjml(
      'WAL archiving failing',
      'Continuous WAL archiving for database {{clusterName}} is failing and pg_wal is at '
        + '{{pressurePercent}}% of the data volume. Fix the backup target sink — if it keeps failing, '
        + 'archiving will be auto-disabled to prevent a full volume. {{reason}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'clusterName', type: 'string', required: true },
      { name: 'pressurePercent', type: 'string', required: true },
      { name: 'reason', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.wal_archive_failing',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'WAL archiving failing',
    bodyTemplate: 'WAL archiving for {{clusterName}} is failing (pg_wal at {{pressurePercent}}%). Fix the backup target.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'clusterName', type: 'string', required: true },
      { name: 'pressurePercent', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'admin.wal_archive_auto_disabled',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'WAL archiving AUTO-DISABLED on {{clusterName}} — backups are off',
    bodyTemplate: emailMjml(
      'WAL archiving auto-disabled',
      'WAL archiving for database {{clusterName}} was automatically DISABLED because it kept failing '
        + 'and pg_wal was filling the data volume. The database is protected from a full-disk outage, '
        + 'but there is NO point-in-time recovery until you fix the backup target and re-enable '
        + 'archiving (Settings → Backups). {{reason}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'clusterName', type: 'string', required: true },
      { name: 'reason', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.wal_archive_auto_disabled',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'WAL archiving auto-disabled',
    bodyTemplate: 'WAL archiving for {{clusterName}} was auto-disabled (kept failing + filling disk). No PITR until you fix the target + re-enable.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'clusterName', type: 'string', required: true },
    ],
  },
];

const LEGACY_TEMPLATES: readonly SeedTemplate[] = ['legacy.info', 'legacy.warning', 'legacy.error', 'legacy.success'].flatMap(
  (categoryId): SeedTemplate[] => [
    {
      categoryId,
      channel: 'email',
      locale: 'en',
      subjectTemplate: '{{title}}',
      bodyTemplate: emailMjml('{{title}}', '{{message}}'),
      bodyFormat: 'mjml',
      variablesSchema: [
        ...COMMON_VARS,
        { name: 'title', type: 'string', required: true },
        { name: 'message', type: 'string', required: true },
      ],
    },
    {
      categoryId,
      channel: 'in_app',
      locale: 'en',
      subjectTemplate: '{{title}}',
      bodyTemplate: '{{message}}',
      bodyFormat: 'plaintext',
      variablesSchema: [
        ...COMMON_VARS,
        { name: 'title', type: 'string', required: true },
        { name: 'message', type: 'string', required: true },
      ],
    },
  ],
);

export const ALL_SEED_TEMPLATES: readonly SeedTemplate[] = [
  ...TENANT_TEMPLATES,
  ...ADMIN_TEMPLATES,
  ...LEGACY_TEMPLATES,
];
