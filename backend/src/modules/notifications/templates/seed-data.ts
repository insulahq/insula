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
  // ── R4/R6 PR 4: send-quota notifications ──
  {
    categoryId: 'tenant.email_quota_warning',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Email sending at {{percent}}% of your {{window}} limit',
    bodyTemplate: emailMjml(
      'Email usage at {{percent}}%',
      'You have sent {{used}} of {{limit}} messages in the current {{window}} window. '
      + 'Messages beyond the limit are deferred until the window rolls over.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'window', type: 'string', required: true },
      { name: 'percent', type: 'string', required: true },
      { name: 'used', type: 'string', required: true },
      { name: 'limit', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'tenant.email_quota_warning',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Email sending at {{percent}}% of the {{window}} limit',
    bodyTemplate: '{{used}} of {{limit}} messages sent this {{window}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'window', type: 'string', required: true },
      { name: 'percent', type: 'string', required: true },
      { name: 'used', type: 'string', required: true },
      { name: 'limit', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'tenant.email_quota_exceeded',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Email sending limit reached ({{window}})',
    bodyTemplate: emailMjml(
      'Sending limit reached',
      'You have sent {{used}} of {{limit}} messages in the current {{window}} window. '
      + 'Further messages are deferred until the window rolls over. Contact support if you '
      + 'regularly need a higher limit.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'window', type: 'string', required: true },
      { name: 'used', type: 'string', required: true },
      { name: 'limit', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'tenant.email_quota_exceeded',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Email sending limit reached ({{window}})',
    bodyTemplate: '{{used}} of {{limit}} messages sent — further messages are deferred this {{window}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'window', type: 'string', required: true },
      { name: 'used', type: 'string', required: true },
      { name: 'limit', type: 'string', required: true },
    ],
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
    categoryId: 'admin.slo_alert_critical',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '[SLO CRITICAL] {{ruleName}}',
    bodyTemplate: emailMjml(
      'SLO alert firing: {{ruleName}}',
      '{{description}} Current value: {{value}}. See Monitoring → SLOs in the admin panel.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'ruleName', type: 'string', required: true },
      { name: 'ruleId', type: 'string', required: true },
      { name: 'description', type: 'string', required: false },
      { name: 'value', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.slo_alert_critical',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '[SLO CRITICAL] {{ruleName}}',
    bodyTemplate: '{{description}} Current value: {{value}}. See Monitoring → SLOs.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'ruleName', type: 'string', required: true },
      { name: 'ruleId', type: 'string', required: true },
      { name: 'description', type: 'string', required: false },
      { name: 'value', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.slo_alert_resolved',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '[SLO RESOLVED] {{ruleName}}',
    bodyTemplate: emailMjml(
      'SLO alert resolved: {{ruleName}}',
      '{{ruleName}} recovered. No further action required.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'ruleName', type: 'string', required: true },
      { name: 'ruleId', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'admin.slo_alert_resolved',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '[SLO RESOLVED] {{ruleName}}',
    bodyTemplate: '{{ruleName}} recovered.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'ruleName', type: 'string', required: true },
      { name: 'ruleId', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'admin.slo_alert_warning',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '[SLO WARNING] {{ruleName}}',
    bodyTemplate: emailMjml(
      'SLO alert firing: {{ruleName}}',
      '{{description}} Current value: {{value}}. See Monitoring → SLOs in the admin panel.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'ruleName', type: 'string', required: true },
      { name: 'ruleId', type: 'string', required: true },
      { name: 'description', type: 'string', required: false },
      { name: 'value', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.slo_alert_warning',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '[SLO WARNING] {{ruleName}}',
    bodyTemplate: '{{description}} Current value: {{value}}. See Monitoring → SLOs.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'ruleName', type: 'string', required: true },
      { name: 'ruleId', type: 'string', required: true },
      { name: 'description', type: 'string', required: false },
      { name: 'value', type: 'string', required: false },
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
  // ── R4 PR 4: FBL complaint-rate alerts ──
  {
    categoryId: 'admin.email_complaint_warning',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '[MAIL] Complaint rate elevated: {{domain}}',
    bodyTemplate: emailMjml(
      'Complaint rate elevated: {{domain}}',
      'Domain {{domain}} ({{tenantLabel}}) has a 7-day complaint rate of {{ratePercent}}% '
      + '({{complaints}} complaints / {{sends}} sends). Recommended action: '
      + '{{recommendedAction}}.{{#if actionTaken}} {{actionTaken}}{{/if}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'domain', type: 'string', required: true },
      { name: 'tenantLabel', type: 'string', required: true },
      { name: 'ratePercent', type: 'string', required: true },
      { name: 'complaints', type: 'string', required: true },
      { name: 'sends', type: 'string', required: true },
      { name: 'recommendedAction', type: 'string', required: true },
      { name: 'actionTaken', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.email_complaint_warning',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '[MAIL] Complaint rate elevated: {{domain}}',
    bodyTemplate: '{{domain}} ({{tenantLabel}}): {{ratePercent}}% 7d complaint rate ({{complaints}}/{{sends}}). {{recommendedAction}}.{{#if actionTaken}} {{actionTaken}}{{/if}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'domain', type: 'string', required: true },
      { name: 'tenantLabel', type: 'string', required: true },
      { name: 'ratePercent', type: 'string', required: true },
      { name: 'complaints', type: 'string', required: true },
      { name: 'sends', type: 'string', required: true },
      { name: 'recommendedAction', type: 'string', required: true },
      { name: 'actionTaken', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.email_complaint_critical',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '[MAIL CRITICAL] Complaint rate: {{domain}}',
    bodyTemplate: emailMjml(
      'CRITICAL complaint rate: {{domain}}',
      'Domain {{domain}} ({{tenantLabel}}) has a 7-day complaint rate of {{ratePercent}}% '
      + '({{complaints}} complaints / {{sends}} sends) — mailbox providers will start blocking. '
      + 'Recommended action: {{recommendedAction}}.{{#if actionTaken}} {{actionTaken}}{{/if}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'domain', type: 'string', required: true },
      { name: 'tenantLabel', type: 'string', required: true },
      { name: 'ratePercent', type: 'string', required: true },
      { name: 'complaints', type: 'string', required: true },
      { name: 'sends', type: 'string', required: true },
      { name: 'recommendedAction', type: 'string', required: true },
      { name: 'actionTaken', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.email_complaint_critical',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '[MAIL CRITICAL] Complaint rate: {{domain}}',
    bodyTemplate: '{{domain}} ({{tenantLabel}}): {{ratePercent}}% 7d complaint rate ({{complaints}}/{{sends}}). {{recommendedAction}}.{{#if actionTaken}} {{actionTaken}}{{/if}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'domain', type: 'string', required: true },
      { name: 'tenantLabel', type: 'string', required: true },
      { name: 'ratePercent', type: 'string', required: true },
      { name: 'complaints', type: 'string', required: true },
      { name: 'sends', type: 'string', required: true },
      { name: 'recommendedAction', type: 'string', required: true },
      { name: 'actionTaken', type: 'string', required: false },
    ],
  },

  // ── admin.email_abuse_warning / _critical (send-limit saturation) ──
  ...(['admin.email_abuse_warning', 'admin.email_abuse_critical'] as const).flatMap((categoryId): SeedTemplate[] => {
    const crit = categoryId.endsWith('critical');
    const tag = crit ? '[MAIL CRITICAL]' : '[MAIL]';
    const abuseVars: readonly NotificationTemplateVariable[] = [
      ...COMMON_VARS,
      { name: 'tenantLabel', type: 'string', required: true },
      { name: 'domain', type: 'string', required: true },
      { name: 'rateLimited', type: 'string', required: true },
      { name: 'quotaRejected', type: 'string', required: true },
      { name: 'total', type: 'string', required: true },
      { name: 'window', type: 'string', required: true },
      { name: 'recommendedAction', type: 'string', required: true },
    ];
    return [
      {
        categoryId,
        channel: 'email',
        locale: 'en',
        subjectTemplate: `${tag} Outbound send-limit saturation: {{tenantLabel}}`,
        bodyTemplate: emailMjml(
          'Outbound send-limit saturation: {{tenantLabel}}',
          'Tenant {{tenantLabel}} (domain {{domain}}) generated {{total}} rate-limited / quota-rejected '
          + 'outbound messages in the last {{window}} ({{rateLimited}} rate-limited, {{quotaRejected}} '
          + 'quota-rejected). This is a runaway sender or early abuse. Recommended action: {{recommendedAction}}.',
        ),
        bodyFormat: 'mjml',
        variablesSchema: abuseVars,
      },
      {
        categoryId,
        channel: 'in_app',
        locale: 'en',
        subjectTemplate: `${tag} Send-limit saturation: {{tenantLabel}}`,
        bodyTemplate: '{{tenantLabel}} ({{domain}}): {{total}} rate-limited/quota-rejected in {{window}} '
          + '({{rateLimited}} RL / {{quotaRejected}} QR). {{recommendedAction}}.',
        bodyFormat: 'plaintext',
        variablesSchema: abuseVars,
      },
    ];
  }),

  // ── admin.mail_blocklisted (DNSBL listing) ──
  {
    categoryId: 'admin.mail_blocklisted',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '[MAIL] Sending IP {{ip}} listed on {{list}}',
    bodyTemplate: emailMjml(
      'Mail IP blocklisted: {{ip}}',
      'Server-role node IP {{ip}} is listed on the {{list}} DNS blocklist ({{severity}}). Outbound mail '
      + 'to some providers will be rejected or junked until the IP is delisted. Check the listing and '
      + 'request delisting: {{lookupUrl}}',
      'Open listing',
      '{{lookupUrl}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'ip', type: 'string', required: true },
      { name: 'list', type: 'string', required: true },
      { name: 'severity', type: 'string', required: true },
      { name: 'lookupUrl', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.mail_blocklisted',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '[MAIL] {{ip}} listed on {{list}}',
    bodyTemplate: 'Sending IP {{ip}} is listed on {{list}} ({{severity}}). Outbound deliverability is '
      + 'degraded — request delisting. {{lookupUrl}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'ip', type: 'string', required: true },
      { name: 'list', type: 'string', required: true },
      { name: 'severity', type: 'string', required: true },
      { name: 'lookupUrl', type: 'string', required: false },
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
