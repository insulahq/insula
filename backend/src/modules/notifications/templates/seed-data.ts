/**
 * Seed templates — one row per (category, channel, locale='en'), for
 * EVERY channel in `NOTIFICATION_CHANNEL_ID`. See `CHANNEL_SEED_STRATEGY`
 * at the foot of this file for how a channel declares where its rows come
 * from, and why that Record is total over the contract enum.
 *
 * Email bodies are compact MJML (h1 + paragraph + optional CTA). In-app
 * bodies are short plaintext. ntfy bodies are derived from in-app.
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
  // The tenant's billing/technical contact PERSON, distinct from the
  // organisation name. Populated centrally by the dispatcher from
  // tenants.contact_name, which was filled in for every tenant and read by
  // nothing until 2026-09-14.
  { name: 'contactName', type: 'string', required: false },
  // Seeded by the dispatcher from "now"; a caller with a more precise instant
  // (when the threshold was actually crossed) overrides it.
  { name: 'occurredAt', type: 'string', required: false },
];

/**
 * Shared by every admin.slo_alert_* template (firing + resolved, all channels)
 * so the firing and resolved legs of one alert cannot drift apart — they are
 * dispatched from the SAME AdminSloAlertPayload.
 *
 * `subject` names WHICH object is affected. The evaluator has always sent it
 * and no template rendered it, so 19 of 28 rules alerted on a symptom with no
 * object: "Certificate not Ready" with no way to tell which certificate, in
 * which namespace, for which tenant.
 */
const SLO_ALERT_VARS: readonly NotificationTemplateVariable[] = [
  ...COMMON_VARS,
  { name: 'ruleName', type: 'string', required: true },
  { name: 'ruleId', type: 'string', required: true },
  { name: 'description', type: 'string', required: false },
  { name: 'value', type: 'string', required: false },
  { name: 'subject', type: 'string', required: false },
  { name: 'severity', type: 'string', required: false },
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
    bodyTemplate: 'A password reset was requested for {{userName}} on {{occurredAt}}. If this was not you, contact support immediately.',
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
    bodyTemplate: 'The password for {{userName}} was updated on {{occurredAt}}.',
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
      'A sign-in to {{userName}} was detected from {{newIp}} ({{userAgent}}). If this was not you, change your password immediately.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'newIp', type: 'string', required: true },
      { name: 'userAgent', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'security.suspicious_activity',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Unusual sign-in detected',
    bodyTemplate: 'A sign-in from {{newIp}} ({{userAgent}}) was detected. If this was not you, change your password immediately.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'newIp', type: 'string', required: true },
      { name: 'userAgent', type: 'string', required: false },
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
      'Hi {{contactName}} — the subscription for {{tenantName}} expires in {{daysUntilExpiry}} days, on {{expiresAt}}. Renew now to avoid service interruption.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'expiresAt', type: 'string', required: true },
      { name: 'daysUntilExpiry', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'subscription.expiry_warning',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Subscription expiring soon',
    bodyTemplate: 'Your subscription for {{tenantName}} expires in {{daysUntilExpiry}} days, on {{expiresAt}}. Renew to avoid service interruption.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'expiresAt', type: 'string', required: true },
      { name: 'daysUntilExpiry', type: 'string', required: false },
    ],
  },

  // ── admin.subscriptions_expiring ───────────────────────────────────
  {
    categoryId: 'admin.subscriptions_expiring',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{tenantCount}} subscription(s) expire within {{horizonDays}} days',
    bodyTemplate: emailMjml(
      'Subscriptions expiring',
      '{{tenantCount}} subscription(s) expire within the next {{horizonDays}} days, as of {{occurredAt}}: '
      + '{{tenantList}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'tenantCount', type: 'string', required: false },
      { name: 'horizonDays', type: 'string', required: false },
      { name: 'tenantList', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.subscriptions_expiring',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{tenantCount}} subscription(s) expiring',
    bodyTemplate: 'Within {{horizonDays}} days as of {{occurredAt}}: {{tenantList}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'tenantCount', type: 'string', required: false },
      { name: 'horizonDays', type: 'string', required: false },
      { name: 'tenantList', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
    ],
  },

  {
    categoryId: 'tenant.mail_event',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: emailMjml(
      '{{subsystem}}',
      '{{objectLabel}} on {{tenantName}} — {{severityLabel}}: {{detail}} As of {{occurredAt}}. {{recommendedAction}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tenant.mail_event',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: '{{detail}} ({{objectLabel}}, {{severityLabel}}) as of {{occurredAt}}. {{recommendedAction}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },

  // ── admin.notification_escalated ───────────────────────────────────
  {
    categoryId: 'admin.notification_escalated',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{count}} notification(s) unread for over {{ageHours}}h',
    bodyTemplate: emailMjml(
      'Unacknowledged notifications',
      '{{count}} action notification(s) have gone unread for more than {{ageHours}} hours, as of '
      + '{{occurredAt}}: {{summary}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'count', type: 'string', required: false },
      { name: 'ageHours', type: 'string', required: false },
      { name: 'summary', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.notification_escalated',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{count}} unread for over {{ageHours}}h',
    bodyTemplate: '{{count}} action notification(s) unread for more than {{ageHours}}h as of {{occurredAt}}: {{summary}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'count', type: 'string', required: false },
      { name: 'ageHours', type: 'string', required: false },
      { name: 'summary', type: 'string', required: false },
    ],
  },

  // ── platform.digest ────────────────────────────────────────────────
  {
    categoryId: 'platform.digest',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{itemCount}} notifications — {{summary}}',
    bodyTemplate: emailMjml(
      'Your notification digest',
      'Hi {{userName}} — {{itemCount}} notification(s) since your last digest, as of {{occurredAt}}: {{items}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'itemCount', type: 'string', required: false },
      { name: 'summary', type: 'string', required: false },
      { name: 'items', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'platform.digest',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{itemCount}} notifications',
    bodyTemplate: '{{itemCount}} notification(s) as of {{occurredAt}}: {{items}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'itemCount', type: 'string', required: false },
      { name: 'summary', type: 'string', required: false },
      { name: 'items', type: 'string', required: false },
    ],
  },

  // ── Operational events ─────────────────────────────────────────────
  //
  // One category per subsystem, sharing an envelope-shaped template. These
  // replace ~20 call sites that wrote rows straight into the notifications
  // table with a hand-built title and message and NO category — so they could
  // never be emailed, pushed, muted, rate-limited or audited, and could not be
  // listed in the admin Sources screen at all.
  //
  // The shared shape is deliberately identity-first: which subsystem, which
  // object, what happened, when, and what to do. That is strictly more than
  // the strings it replaces, which named the object only when the author
  // happened to interpolate it.
  {
    categoryId: 'admin.storage_event',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: emailMjml(
      '{{subsystem}} — {{severityLabel}}',
      '{{objectLabel}}: {{detail}} As of {{occurredAt}}. {{recommendedAction}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.storage_event',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: '{{detail}} ({{objectLabel}}, {{severityLabel}}) as of {{occurredAt}}. {{recommendedAction}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.node_event',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: emailMjml(
      '{{subsystem}} — {{severityLabel}}',
      '{{objectLabel}}: {{detail}} As of {{occurredAt}}. {{recommendedAction}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.node_event',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: '{{detail}} ({{objectLabel}}, {{severityLabel}}) as of {{occurredAt}}. {{recommendedAction}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.database_event',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: emailMjml(
      '{{subsystem}} — {{severityLabel}}',
      '{{objectLabel}}: {{detail}} As of {{occurredAt}}. {{recommendedAction}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.database_event',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: '{{detail}} ({{objectLabel}}, {{severityLabel}}) as of {{occurredAt}}. {{recommendedAction}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.mail_event',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: emailMjml(
      '{{subsystem}} — {{severityLabel}}',
      '{{objectLabel}}: {{detail}} As of {{occurredAt}}. {{recommendedAction}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.mail_event',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: '{{detail}} ({{objectLabel}}, {{severityLabel}}) as of {{occurredAt}}. {{recommendedAction}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.platform_event',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: emailMjml(
      '{{subsystem}} — {{severityLabel}}',
      '{{objectLabel}}: {{detail}} As of {{occurredAt}}. {{recommendedAction}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.platform_event',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: '{{detail}} ({{objectLabel}}, {{severityLabel}}) as of {{occurredAt}}. {{recommendedAction}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.tenant_integrity',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: emailMjml(
      '{{subsystem}} — {{severityLabel}}',
      '{{objectLabel}}: {{detail}} As of {{occurredAt}}. {{recommendedAction}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.tenant_integrity',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: '{{detail}} ({{objectLabel}}, {{severityLabel}}) as of {{occurredAt}}. {{recommendedAction}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tenant.domain_verification',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: emailMjml(
      '{{subsystem}} — {{severityLabel}}',
      '{{objectLabel}}: {{detail}} As of {{occurredAt}}. {{recommendedAction}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tenant.domain_verification',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: '{{detail}} ({{objectLabel}}, {{severityLabel}}) as of {{occurredAt}}. {{recommendedAction}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tenant.backup_event',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: emailMjml(
      '{{subsystem}} — {{severityLabel}}',
      '{{objectLabel}}: {{detail}} As of {{occurredAt}}. {{recommendedAction}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tenant.backup_event',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{subsystem}}: {{objectLabel}}',
    bodyTemplate: '{{detail}} ({{objectLabel}}, {{severityLabel}}) as of {{occurredAt}}. {{recommendedAction}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'subsystem', type: 'string', required: false },
      { name: 'objectLabel', type: 'string', required: false },
      { name: 'detail', type: 'string', required: false },
      { name: 'severityLabel', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },

  // ── admin.cluster_storage_capacity ─────────────────────────────────
  {
    categoryId: 'admin.cluster_storage_capacity',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Cluster storage {{level}} — {{clusterPct}}% committed',
    bodyTemplate: emailMjml(
      'Cluster storage capacity',
      '{{clusterDetail}} Worst node: {{worstNode}}. As of {{occurredAt}}. {{recommendedAction}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'level', type: 'string', required: false },
      { name: 'clusterPct', type: 'string', required: false },
      { name: 'clusterDetail', type: 'string', required: false },
      { name: 'worstNode', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.cluster_storage_capacity',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Cluster storage {{level}} — {{clusterPct}}%',
    bodyTemplate: '{{clusterDetail}} Worst node: {{worstNode}}. As of {{occurredAt}}. {{recommendedAction}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'level', type: 'string', required: false },
      { name: 'clusterPct', type: 'string', required: false },
      { name: 'clusterDetail', type: 'string', required: false },
      { name: 'worstNode', type: 'string', required: false },
      { name: 'recommendedAction', type: 'string', required: false },
    ],
  },

  // ── tenant.resource_saturation_* ───────────────────────────────────
  {
    categoryId: 'tenant.resource_saturation_warning',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{resource}} for {{tenantName}} is {{usedPct}}% used',
    bodyTemplate: emailMjml(
      'Resource nearing its limit',
      '{{tenantName}} has used {{used}}{{unit}} of its {{limit}}{{unit}} {{resource}} limit ({{usedPct}}%), '
      + 'as of {{occurredAt}}. Free some up or upgrade the plan before it is refused.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'resource', type: 'string', required: false },
      { name: 'usedPct', type: 'string', required: false },
      { name: 'used', type: 'string', required: false },
      { name: 'limit', type: 'string', required: false },
      { name: 'unit', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tenant.resource_saturation_warning',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{resource}} is {{usedPct}}% used',
    bodyTemplate: '{{tenantName}}: {{resource}} at {{used}}{{unit}} of {{limit}}{{unit}} ({{usedPct}}%) as of {{occurredAt}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'resource', type: 'string', required: false },
      { name: 'usedPct', type: 'string', required: false },
      { name: 'used', type: 'string', required: false },
      { name: 'limit', type: 'string', required: false },
      { name: 'unit', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tenant.resource_saturation_critical',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{resource}} limit reached for {{tenantName}}',
    bodyTemplate: emailMjml(
      'Resource limit reached',
      '{{tenantName}} has reached its {{resource}} limit — {{used}}{{unit}} of {{limit}}{{unit}} ({{usedPct}}%) '
      + 'as of {{occurredAt}}. Further use is being refused until space is freed or the plan is upgraded.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'resource', type: 'string', required: false },
      { name: 'usedPct', type: 'string', required: false },
      { name: 'used', type: 'string', required: false },
      { name: 'limit', type: 'string', required: false },
      { name: 'unit', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tenant.resource_saturation_critical',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{resource}} limit reached',
    bodyTemplate: '{{tenantName}}: {{resource}} at {{used}}{{unit}} of {{limit}}{{unit}} ({{usedPct}}%) as of {{occurredAt}} — further use is refused.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'resource', type: 'string', required: false },
      { name: 'usedPct', type: 'string', required: false },
      { name: 'used', type: 'string', required: false },
      { name: 'limit', type: 'string', required: false },
      { name: 'unit', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
    ],
  },
  // ── admin.email_quota_exceeded ─────────────────────────────────────
  {
    categoryId: 'admin.email_quota_exceeded',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{tenantLabel}} saturated its {{window}} sending limit',
    bodyTemplate: emailMjml(
      'Tenant sending limit saturated',
      '{{tenantLabel}} sent {{used}} of {{limit}} messages ({{percent}}%) in the current {{window}} window, '
      + 'as of {{occurredAt}}. A saturated sender is the shape of both a compromised account and a '
      + 'deliverability risk to the whole platform.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'tenantLabel', type: 'string', required: false },
      { name: 'window', type: 'string', required: false },
      { name: 'used', type: 'string', required: false },
      { name: 'limit', type: 'string', required: false },
      { name: 'percent', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.email_quota_exceeded',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{tenantLabel}} at its {{window}} sending limit',
    bodyTemplate: '{{tenantLabel}}: {{used}}/{{limit}} messages ({{percent}}%) this {{window}} as of {{occurredAt}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'tenantLabel', type: 'string', required: false },
      { name: 'window', type: 'string', required: false },
      { name: 'used', type: 'string', required: false },
      { name: 'limit', type: 'string', required: false },
      { name: 'percent', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
    ],
  },

  // ── mailbox.quota_threshold / _exceeded ────────────────────────────
  //
  // Answers which tenant, which mailbox, what and when — the four things the
  // retired `mail-mailbox-over-quota` SLO alert could not say, because it read
  // a single global counter with no subject labels.
  {
    categoryId: 'mailbox.quota_threshold',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Mailbox {{mailboxAddress}} is {{percent}}% full',
    bodyTemplate: emailMjml(
      'Mailbox nearly full',
      'Mailbox {{mailboxAddress}} on {{tenantName}} has used {{usedMb}} MB of its {{quotaMb}} MB quota '
      + '({{percent}}%), as of {{occurredAt}}. Delete messages you no longer need, or increase the quota, '
      + 'before new mail starts being rejected.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'mailboxAddress', type: 'string', required: false },
      { name: 'percent', type: 'string', required: false },
      { name: 'usedMb', type: 'string', required: false },
      { name: 'quotaMb', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'mailbox.quota_threshold',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Mailbox {{mailboxAddress}} is {{percent}}% full',
    bodyTemplate: '{{mailboxAddress}} on {{tenantName}} has used {{usedMb}} of {{quotaMb}} MB ({{percent}}%) as of {{occurredAt}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'mailboxAddress', type: 'string', required: false },
      { name: 'percent', type: 'string', required: false },
      { name: 'usedMb', type: 'string', required: false },
      { name: 'quotaMb', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'mailbox.quota_exceeded',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Mailbox {{mailboxAddress}} is full — mail is being rejected',
    bodyTemplate: emailMjml(
      'Mailbox full',
      'Mailbox {{mailboxAddress}} on {{tenantName}} has reached its {{quotaMb}} MB quota ({{usedMb}} MB used, {{percent}}%) '
      + 'as of {{occurredAt}}. New mail addressed to it is being REJECTED. Delete messages or increase the '
      + 'quota to start receiving again.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'mailboxAddress', type: 'string', required: false },
      { name: 'percent', type: 'string', required: false },
      { name: 'usedMb', type: 'string', required: false },
      { name: 'quotaMb', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'mailbox.quota_exceeded',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Mailbox {{mailboxAddress}} is full',
    bodyTemplate: '{{mailboxAddress}} on {{tenantName}} is at {{percent}}% of its {{quotaMb}} MB quota ({{usedMb}} MB) as of {{occurredAt}} — new mail is being rejected.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'mailboxAddress', type: 'string', required: false },
      { name: 'percent', type: 'string', required: false },
      { name: 'usedMb', type: 'string', required: false },
      { name: 'quotaMb', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
    ],
  },
  // ── admin.mailbox_quota_fleet ──────────────────────────────────────
  {
    categoryId: 'admin.mailbox_quota_fleet',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '{{mailboxCount}} mailbox(es) over quota across {{tenantCount}} tenant(s)',
    bodyTemplate: emailMjml(
      'Mailboxes over storage quota',
      '{{mailboxCount}} mailbox(es) across {{tenantCount}} tenant(s) are at 100% of quota as of '
      + '{{occurredAt}} and are rejecting mail: {{mailboxList}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'mailboxCount', type: 'string', required: false },
      { name: 'tenantCount', type: 'string', required: false },
      { name: 'mailboxList', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.mailbox_quota_fleet',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '{{mailboxCount}} mailbox(es) over quota',
    bodyTemplate: '{{mailboxCount}} mailbox(es) across {{tenantCount}} tenant(s) at 100% of quota as of {{occurredAt}}: {{mailboxList}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'mailboxCount', type: 'string', required: false },
      { name: 'tenantCount', type: 'string', required: false },
      { name: 'mailboxList', type: 'string', required: false },
      { name: 'occurredAt', type: 'string', required: false },
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
      'Hi {{contactName}} — the subscription for {{tenantName}} was renewed and now runs until {{newExpiresAt}}.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'newExpiresAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'subscription.renewed',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Subscription renewed',
    bodyTemplate: 'Your subscription for {{tenantName}} was renewed. It now runs until {{newExpiresAt}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'newExpiresAt', type: 'string', required: false },
    ],
  },

  // ── subscription.changed ───────────────────────────────────────────
  {
    categoryId: 'subscription.changed',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Subscription changed',
    bodyTemplate: emailMjml(
      'Subscription changed',
      'Hi {{contactName}} — the subscription for {{tenantName}} changed from the {{oldPlanName}} plan to the {{newPlanName}} plan.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'oldPlanName', type: 'string', required: false },
      { name: 'newPlanName', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'subscription.changed',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Subscription changed',
    bodyTemplate: '{{tenantName}}: plan changed from {{oldPlanName}} to {{newPlanName}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'oldPlanName', type: 'string', required: false },
      { name: 'newPlanName', type: 'string', required: false },
    ],
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
    bodyTemplate: 'The scheduled task "{{taskName}}" failed.{{#if errorMessage}} {{errorMessage}}{{/if}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      { name: 'errorMessage', type: 'string', required: false },
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
    bodyTemplate: '{{tenantName}} was suspended on {{occurredAt}}. Contact support to restore access.',
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
    bodyTemplate: '{{tenantName}} was restored on {{occurredAt}}. All services are back online.',
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
    bodyTemplate: '{{tenantName}} was archived on {{occurredAt}}. Data is retained read-only.',
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
    bodyTemplate: '{{tenantName}} is being permanently deleted, effective {{occurredAt}}.',
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
      'You have sent {{used}} of {{limit}} messages ({{percent}}%) in the current {{window}} window. '
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
    bodyTemplate: '{{used}} of {{limit}} messages sent ({{percent}}%) — further messages are deferred this {{window}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'window', type: 'string', required: true },
      { name: 'used', type: 'string', required: true },
      { name: 'limit', type: 'string', required: true },
      { name: 'percent', type: 'string', required: false },
    ],
  },

  {
    categoryId: 'tls.certificate_failed',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Certificate could not be issued for {{hostname}}',
    bodyTemplate: emailMjml(
      'Certificate could not be issued',
      'We could not obtain a TLS certificate for {{hostname}}: {{errorMessage}} ' +
        'The current certificate expires {{expiresAt}}. ' +
        'Visitors will see a security warning until this is resolved. ' +
        'The most common cause is DNS for the domain not yet pointing at the platform.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'hostname', type: 'string', required: true },
      { name: 'errorMessage', type: 'string', required: false },
      { name: 'expiresAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tls.certificate_failed',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Certificate failed for {{hostname}}',
    bodyTemplate: 'TLS certificate for {{hostname}} could not be issued: {{errorMessage}}'
      + ' The current certificate expires {{expiresAt}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'hostname', type: 'string', required: true },
      { name: 'errorMessage', type: 'string', required: false },
      { name: 'expiresAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tls.certificate_issued',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Certificate active for {{hostname}}',
    bodyTemplate: emailMjml(
      'Certificate active',
      'A TLS certificate for {{hostname}} is active until {{expiresAt}}. '
        + 'Renewal is automatic — no action is needed.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'hostname', type: 'string', required: true },
      { name: 'expiresAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tls.certificate_issued',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Certificate active for {{hostname}}',
    bodyTemplate: 'A TLS certificate for {{hostname}} is active until {{expiresAt}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'hostname', type: 'string', required: true },
      { name: 'expiresAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tls.certificate_fallback',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Using per-hostname certificates for {{hostname}}',
    bodyTemplate: emailMjml(
      'Wildcard certificate unavailable',
      'The wildcard certificate for {{hostname}} could not be issued ({{errorMessage}}, current certificate expires ' +
        '{{expiresAt}}), so each hostname is being ' +
        'secured with its own certificate instead. Your sites stay reachable over HTTPS; new subdomains just need ' +
        'their own certificate until the wildcard succeeds. We keep retrying it in the background.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'hostname', type: 'string', required: true },
      { name: 'errorMessage', type: 'string', required: false },
      { name: 'expiresAt', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tls.certificate_fallback',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Wildcard unavailable for {{hostname}}',
    bodyTemplate:
      'Using per-hostname certificates for {{hostname}} while the wildcard is retried: {{errorMessage}}'
      + ' (current certificate expires {{expiresAt}})',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'hostname', type: 'string', required: true },
      { name: 'errorMessage', type: 'string', required: false },
      { name: 'expiresAt', type: 'string', required: false },
    ],
  },
];

const ADMIN_TEMPLATES: readonly SeedTemplate[] = [
  {
    categoryId: 'admin.cert_issuance_failed',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Certificate issuance failed for {{certSubject}}',
    bodyTemplate: emailMjml(
      'Certificate issuance failed',
      'The certificate for {{certSubject}} (tenant {{tenantName}}) could not be issued: {{errorMessage}}. ' +
        'The hostname has no valid certificate until this is resolved.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'certSubject', type: 'string', required: true },
      { name: 'tenantName', type: 'string', required: false },
      { name: 'errorMessage', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.cert_issuance_failed',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Cert issuance failed',
    bodyTemplate: 'Certificate for {{certSubject}} could not be issued: {{errorMessage}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'certSubject', type: 'string', required: true },
      { name: 'errorMessage', type: 'string', required: false },
    ],
  },

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
      { name: 'daysUntilExpiry', type: 'string', required: false },
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
      { name: 'daysUntilExpiry', type: 'string', required: false },
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
    bodyTemplate: 'Renewal of {{certSubject}} failed.{{#if errorMessage}} {{errorMessage}}{{/if}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      { name: 'errorMessage', type: 'string', required: false },
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
    bodyTemplate: 'Backup "{{backupName}}" failed.{{#if errorMessage}} {{errorMessage}}{{/if}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      { name: 'errorMessage', type: 'string', required: false },
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
    bodyTemplate: 'Backup target {{targetName}} is unreachable.{{#if errorMessage}} {{errorMessage}}{{/if}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      { name: 'errorMessage', type: 'string', required: false },
      ...COMMON_VARS,
      { name: 'targetName', type: 'string', required: true },
    ],
  },

  {
    categoryId: 'admin.node_down',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '[NODE] {{nodeName}} is down',
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
    subjectTemplate: '[NODE] {{nodeName}} is down',
    bodyTemplate: 'Node {{nodeName}} is NotReady.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'nodeName', type: 'string', required: true },
    ],
  },

  {
    categoryId: 'admin.node_memory_event_critical',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Node memory event on {{nodeName}} (system impact)',
    bodyTemplate: emailMjml(
      'Node memory event (system)',
      '{{summary}} on node {{nodeName}}. System workloads should not be losing this fight — check Monitoring \u2192 Node health.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'nodeName', type: 'string', required: true },
      { name: 'summary', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'admin.node_memory_event_critical',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Node memory event (system)',
    bodyTemplate: '{{summary}} on node {{nodeName}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'nodeName', type: 'string', required: true },
      { name: 'summary', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'admin.node_memory_event_warning',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Tenant evictions on {{nodeName}} (memory pressure)',
    bodyTemplate: emailMjml(
      'Node memory event (tenant evictions)',
      '{{summary}} on node {{nodeName}}. This is the designed backpressure under memory pressure \u2014 review node headroom / tenant sizing if it repeats.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'nodeName', type: 'string', required: true },
      { name: 'summary', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'admin.node_memory_event_warning',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Tenant evictions (memory pressure)',
    bodyTemplate: '{{summary}} on node {{nodeName}}.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'nodeName', type: 'string', required: true },
      { name: 'summary', type: 'string', required: true },
    ],
  },

  {
    categoryId: 'admin.custom_deployment_failed',
    channel: 'email',
    locale: 'en',
    subjectTemplate: 'Custom deployment failed: {{deploymentName}} ({{tenantLabel}})',
    bodyTemplate: emailMjml(
      'Custom deployment failed',
      'Tenant {{tenantLabel}} — deployment {{deploymentName}} entered a failed state: {{reason}}. '
      + 'The container keeps restarting until the image/config is fixed or the deployment is stopped. '
      + 'Investigate in the tenant’s Custom Containers tab.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'tenantLabel', type: 'string', required: true },
      { name: 'deploymentName', type: 'string', required: true },
      { name: 'reason', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'admin.custom_deployment_failed',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: 'Custom deployment failed: {{deploymentName}}',
    bodyTemplate: 'Tenant {{tenantLabel}} — {{deploymentName}} failed: {{reason}}. It keeps restarting until fixed or stopped (Custom Containers tab).',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'tenantLabel', type: 'string', required: true },
      { name: 'deploymentName', type: 'string', required: true },
      { name: 'reason', type: 'string', required: true },
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
    bodyTemplate: 'Hardening drift on {{nodeName}}.{{#if driftSummary}} {{driftSummary}}{{/if}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      { name: 'driftSummary', type: 'string', required: false },
      ...COMMON_VARS,
      { name: 'nodeName', type: 'string', required: true },
    ],
  },
  {
    categoryId: 'admin.slo_alert_critical',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '[SLO CRITICAL] {{ruleName}}{{#if subject}} — {{subject}}{{/if}}',
    bodyTemplate: emailMjml(
      'SLO alert firing: {{ruleName}}',
      '{{#if subject}}Affected: {{subject}}. {{/if}}{{description}}'
      + '{{#if value}} Current value: {{value}}.{{/if}}'
      + ' (rule {{ruleId}}, severity {{severity}})',
    ),
    bodyFormat: 'mjml',
    variablesSchema: SLO_ALERT_VARS,
  },
  {
    categoryId: 'admin.slo_alert_critical',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '[SLO CRITICAL] {{ruleName}}{{#if subject}} — {{subject}}{{/if}}',
    bodyTemplate: '{{#if subject}}Affected: {{subject}}. {{/if}}{{description}}'
      + '{{#if value}} Current value: {{value}}.{{/if}}'
      + ' (rule {{ruleId}}, severity {{severity}})',
    bodyFormat: 'plaintext',
    variablesSchema: SLO_ALERT_VARS,
  },
  {
    categoryId: 'admin.slo_alert_resolved',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '[SLO RESOLVED] {{ruleName}}{{#if subject}} — {{subject}}{{/if}}',
    bodyTemplate: emailMjml(
      'SLO alert resolved: {{ruleName}}',
      '{{ruleName}} recovered{{#if subject}} for {{subject}}{{/if}}. '
      + '{{description}}{{#if value}} Last value: {{value}}.{{/if}} '
      + '(rule {{ruleId}}, severity {{severity}}). No further action required.',
    ),
    bodyFormat: 'mjml',
    variablesSchema: SLO_ALERT_VARS,
  },
  {
    categoryId: 'admin.slo_alert_resolved',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '[SLO RESOLVED] {{ruleName}}{{#if subject}} — {{subject}}{{/if}}',
    bodyTemplate: '{{ruleName}} recovered{{#if subject}} for {{subject}}{{/if}}'
      + ' (rule {{ruleId}}, severity {{severity}}).',
    bodyFormat: 'plaintext',
    variablesSchema: SLO_ALERT_VARS,
  },
  {
    categoryId: 'admin.slo_alert_warning',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '[SLO WARNING] {{ruleName}}{{#if subject}} — {{subject}}{{/if}}',
    bodyTemplate: emailMjml(
      'SLO alert firing: {{ruleName}}',
      '{{#if subject}}Affected: {{subject}}. {{/if}}{{description}}'
      + '{{#if value}} Current value: {{value}}.{{/if}}'
      + ' (rule {{ruleId}}, severity {{severity}})',
    ),
    bodyFormat: 'mjml',
    variablesSchema: SLO_ALERT_VARS,
  },
  {
    categoryId: 'admin.slo_alert_warning',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '[SLO WARNING] {{ruleName}}{{#if subject}} — {{subject}}{{/if}}',
    bodyTemplate: '{{#if subject}}Affected: {{subject}}. {{/if}}{{description}}'
      + '{{#if value}} Current value: {{value}}.{{/if}}'
      + ' (rule {{ruleId}}, severity {{severity}})',
    bodyFormat: 'plaintext',
    variablesSchema: SLO_ALERT_VARS,
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
    bodyTemplate: 'WAL archiving for {{clusterName}} is failing (pg_wal at {{pressurePercent}}%). Fix the backup target.{{#if reason}} {{reason}}{{/if}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      { name: 'reason', type: 'string', required: false },
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
    bodyTemplate: 'WAL archiving for {{clusterName}} was auto-disabled (kept failing + filling disk). No PITR until you fix the target + re-enable.{{#if reason}} {{reason}}{{/if}}',
    bodyFormat: 'plaintext',
    variablesSchema: [
      { name: 'reason', type: 'string', required: false },
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

  // ── tenant.custom_deployment_rolled_back (auto-update failed) ──
  {
    categoryId: 'tenant.custom_deployment_rolled_back',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '[CONTAINER] Auto-update rolled back: {{deploymentName}}',
    bodyTemplate: emailMjml(
      'Auto-update rolled back: {{deploymentName}}',
      'A new image was published for {{deploymentName}} and pulled automatically, but the container '
      + 'did not start. The previous image ({{restoredDigest}}) has been restored and auto-update has '
      + 'been switched OFF for this container so it cannot happen again unattended. The image that '
      + 'failed was {{failedDigest}}. Re-enable auto-update once the upstream image is fixed.',
      'Open containers',
      '{{panelUrl}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'deploymentName', type: 'string', required: true },
      { name: 'failedDigest', type: 'string', required: true },
      { name: 'restoredDigest', type: 'string', required: true },
      { name: 'panelUrl', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'tenant.custom_deployment_rolled_back',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '[CONTAINER] Auto-update rolled back: {{deploymentName}}',
    bodyTemplate: 'A new image for {{deploymentName}} failed to start. The previous image '
      + '({{restoredDigest}}) was restored and auto-update is now OFF for this container.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'deploymentName', type: 'string', required: true },
      { name: 'failedDigest', type: 'string', required: true },
      { name: 'restoredDigest', type: 'string', required: true },
      { name: 'panelUrl', type: 'string', required: false },
    ],
  },

  // ── admin.mail_health_degraded (a health component is FAILING) ──
  {
    categoryId: 'admin.mail_health_degraded',
    channel: 'email',
    locale: 'en',
    subjectTemplate: '[MAIL] Health check failing: {{component}}',
    bodyTemplate: emailMjml(
      'Mail health degraded: {{component}}',
      'The mail-server {{component}} check is FAILING on {{mailHostname}}.{{detail}} '
      + 'Mail delivery is likely affected. Open Monitoring → Mail for the full component '
      + 'breakdown and per-probe remediation.',
      'Open mail monitoring',
      '{{panelUrl}}',
    ),
    bodyFormat: 'mjml',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'component', type: 'string', required: true },
      { name: 'mailHostname', type: 'string', required: true },
      // Pre-rendered, already leading-space-padded, or empty. Templates cannot
      // do conditionals, so an absent detail must render as nothing at all
      // rather than as a stray separator.
      { name: 'detail', type: 'string', required: false },
      { name: 'panelUrl', type: 'string', required: false },
    ],
  },
  {
    categoryId: 'admin.mail_health_degraded',
    channel: 'in_app',
    locale: 'en',
    subjectTemplate: '[MAIL] {{component}} check failing',
    bodyTemplate: 'The mail-server {{component}} check is FAILING on {{mailHostname}}.{{detail}} '
      + 'Mail delivery is likely affected — see Monitoring → Mail.',
    bodyFormat: 'plaintext',
    variablesSchema: [
      ...COMMON_VARS,
      { name: 'component', type: 'string', required: true },
      { name: 'mailHostname', type: 'string', required: true },
      { name: 'detail', type: 'string', required: false },
      { name: 'panelUrl', type: 'string', required: false },
    ],
  },

  // ── admin.tenant_resource_saturation_warning / _critical ──
  ...(['admin.tenant_resource_saturation_warning', 'admin.tenant_resource_saturation_critical'] as const).flatMap((categoryId): SeedTemplate[] => {
    const crit = categoryId.endsWith('critical');
    const tag = crit ? '[RESOURCE]' : '[RESOURCE]';
    const satVars: readonly NotificationTemplateVariable[] = [
      ...COMMON_VARS,
      { name: 'tenantLabel', type: 'string', required: true },
      { name: 'resource', type: 'string', required: true },
      { name: 'usedPct', type: 'string', required: true },
      { name: 'used', type: 'string', required: true },
      { name: 'limit', type: 'string', required: true },
      { name: 'unit', type: 'string', required: true },
    ];
    const verb = crit ? 'reached its' : 'is approaching its';
    return [
      {
        categoryId,
        channel: 'email',
        locale: 'en',
        subjectTemplate: `${tag} ${crit ? 'Tenant at resource limit' : 'Tenant resource usage high'}: {{tenantLabel}} ({{resource}})`,
        bodyTemplate: emailMjml(
          `${crit ? 'Tenant at resource limit' : 'Tenant resource usage high'}: {{tenantLabel}}`,
          `Tenant {{tenantLabel}} ${verb} {{resource}} limit — {{used}}{{unit}} of {{limit}}{{unit}} ({{usedPct}}%). `
          + `${crit ? 'Workloads may be throttled, OOM-killed, or unable to write. Raise the limit/plan or investigate the workload.' : 'Consider raising the limit/plan or checking for a runaway workload.'}`,
        ),
        bodyFormat: 'mjml',
        variablesSchema: satVars,
      },
      {
        categoryId,
        channel: 'in_app',
        locale: 'en',
        subjectTemplate: `${tag} {{tenantLabel}} {{resource}} {{usedPct}}%`,
        bodyTemplate: `{{tenantLabel}} ${verb} {{resource}} limit: {{used}}{{unit}} / {{limit}}{{unit}} ({{usedPct}}%).`,
        bodyFormat: 'plaintext',
        variablesSchema: satVars,
      },
    ];
  }),

  // ── Node reboot lifecycle (operator request 2026-09-11) ──
  ...((): SeedTemplate[] => {
    const rebootVars: readonly NotificationTemplateVariable[] = [
      ...COMMON_VARS,
      { name: 'nodeName', type: 'string', required: true },
    ];
    const startupVars: readonly NotificationTemplateVariable[] = [
      ...COMMON_VARS,
      { name: 'nodeName', type: 'string', required: true },
      { name: 'downtimeText', type: 'string', required: true },
      { name: 'bootedAtText', type: 'string', required: true },
      { name: 'announcementNote', type: 'string', required: true },
    ];
    return [
      {
        categoryId: 'admin.tenant_auto_repinned',
        channel: 'email',
        locale: 'en',
        subjectTemplate: '[TENANT] {{tenantName}} was re-pinned off offline node {{strandedOn}}',
        bodyTemplate: emailMjml(
          '{{tenantName}} was automatically re-pinned',
          'Tenant {{tenantName}} was pinned to {{strandedOn}}, which went offline. Because the '
          + 'tenant is on the HA storage tier its data has a replica on a healthy node, so the '
          + 'pin was cleared and the workloads can reschedule. No data was moved or lost. '
          + 'Re-pin it deliberately once {{strandedOn}} is back if you want it to live there.',
        ),
        bodyFormat: 'mjml',
        variablesSchema: [
          ...COMMON_VARS,
          { name: 'tenantName', type: 'string', required: true },
          { name: 'strandedOn', type: 'string', required: true },
        ],
      },
      {
        categoryId: 'admin.tenant_auto_repinned',
        channel: 'in_app',
        locale: 'en',
        subjectTemplate: '[TENANT] {{tenantName}} re-pinned off {{strandedOn}}',
        bodyTemplate: 'HA-tier tenant {{tenantName}} was pinned to offline node {{strandedOn}}. '
          + 'Its data has a live replica elsewhere, so the pin was cleared and it can reschedule.',
        bodyFormat: 'plaintext',
        variablesSchema: [
          { name: 'tenantName', type: 'string', required: true },
          { name: 'strandedOn', type: 'string', required: true },
        ],
      },
      {
        categoryId: 'admin.node_rebooting',
        channel: 'email',
        locale: 'en',
        subjectTemplate: '[NODE] {{nodeName}} is rebooting',
        bodyTemplate: emailMjml(
          'Node {{nodeName}} is rebooting',
          'Cluster node {{nodeName}} has left Ready and is shutting down. Workloads on it are '
          + 'being drained. You will get a "startup complete" notification when it is back, '
          + 'with the downtime.',
        ),
        bodyFormat: 'mjml',
        variablesSchema: rebootVars,
      },
      {
        categoryId: 'admin.node_rebooting',
        channel: 'in_app',
        locale: 'en',
        subjectTemplate: '[NODE] {{nodeName}} is rebooting',
        bodyTemplate: 'Cluster node {{nodeName}} has left Ready and is shutting down. Workloads are being drained.',
        bodyFormat: 'plaintext',
        variablesSchema: rebootVars,
      },
      {
        categoryId: 'admin.node_startup_complete',
        channel: 'email',
        locale: 'en',
        subjectTemplate: '[NODE] {{nodeName}} startup complete ({{downtimeText}} down)',
        bodyTemplate: emailMjml(
          'Node {{nodeName}} is back',
          'Cluster node {{nodeName}} rebooted and is Ready again{{bootedAtText}}. Approximate '
          + 'downtime: {{downtimeText}}. {{announcementNote}}',
        ),
        bodyFormat: 'mjml',
        variablesSchema: startupVars,
      },
      {
        categoryId: 'admin.node_startup_complete',
        channel: 'in_app',
        locale: 'en',
        subjectTemplate: '[NODE] {{nodeName}} startup complete',
        bodyTemplate: '{{nodeName}} rebooted and is Ready again{{bootedAtText}}. Approximate downtime: {{downtimeText}}. {{announcementNote}}',
        bodyFormat: 'plaintext',
        variablesSchema: startupVars,
      },
    ];
  })(),

  // ── admin.tenant_pod_oom (Phase 1d) ──
  ...((): SeedTemplate[] => {
    const oomVars: readonly NotificationTemplateVariable[] = [
      ...COMMON_VARS,
      { name: 'tenantLabel', type: 'string', required: true },
      { name: 'podName', type: 'string', required: true },
      { name: 'containerName', type: 'string', required: true },
      { name: 'restartCount', type: 'string', required: true },
      { name: 'killSummary', type: 'string', required: true },
      { name: 'killDetail', type: 'string', required: true },
    ];
    return [
      {
        categoryId: 'admin.tenant_pod_oom',
        channel: 'email',
        locale: 'en',
        subjectTemplate: '[OOM] Tenant workload {{killSummary}}: {{tenantLabel}} ({{containerName}})',
        bodyTemplate: emailMjml(
          'Tenant workload {{killSummary}}: {{tenantLabel}}',
          'Container {{containerName}} in pod {{podName}} (tenant {{tenantLabel}}) {{killDetail}} '
          + 'The container has restarted {{restartCount}} time(s).',
        ),
        bodyFormat: 'mjml',
        variablesSchema: oomVars,
      },
      {
        categoryId: 'admin.tenant_pod_oom',
        channel: 'in_app',
        locale: 'en',
        subjectTemplate: '[OOM] {{tenantLabel}}: {{containerName}} {{killSummary}}',
        bodyTemplate: '{{tenantLabel}} — {{containerName}} in {{podName}} {{killDetail}}'
          + ' ({{restartCount}} restart(s))',
        bodyFormat: 'plaintext',
        variablesSchema: oomVars,
      },
    ];
  })(),

  // ── Monthly bandwidth (BW-3): admin (with tenantLabel) + tenant variants ──
  ...([
    { categoryId: 'admin.tenant_bandwidth_warning', admin: true, crit: false },
    { categoryId: 'admin.tenant_bandwidth_critical', admin: true, crit: true },
    { categoryId: 'tenant.bandwidth_warning', admin: false, crit: false },
    { categoryId: 'tenant.bandwidth_exceeded', admin: false, crit: true },
  ] as const).flatMap(({ categoryId, admin, crit }): SeedTemplate[] => {
    const vars: readonly NotificationTemplateVariable[] = [
      ...COMMON_VARS,
      ...(admin ? [{ name: 'tenantLabel', type: 'string' as const, required: true }] : []),
      { name: 'usedPct', type: 'string' as const, required: true },
      { name: 'used', type: 'string' as const, required: true },
      { name: 'limit', type: 'string' as const, required: true },
    ];
    const who = admin ? 'Tenant {{tenantLabel}} has' : 'You have';
    const subj = admin
      ? (crit ? '[BANDWIDTH] Cap active: {{tenantLabel}}' : '[BANDWIDTH] Usage high: {{tenantLabel}}')
      : (crit ? 'Your sites are paused — bandwidth limit reached' : 'Bandwidth usage at {{usedPct}}%');
    const body = crit
      ? `${who} reached the monthly bandwidth limit ({{used}} of {{limit}} GB, {{usedPct}}%). `
        + `${admin ? 'The tenant\'s sites are capped (HTTP 509) until the month resets — raise the limit/plan to restore serving now.' : 'Your sites are temporarily unavailable (HTTP 509) until the month resets. Upgrade your plan to restore them now.'}`
      : `${who} used {{usedPct}}% of the monthly bandwidth allowance ({{used}} of {{limit}} GB). `
        + `${admin ? 'At 100% the tenant is capped until the month resets.' : 'At 100% your sites will be temporarily unavailable until the month resets — upgrade your plan to avoid interruption.'}`;
    return [
      { categoryId, channel: 'email', locale: 'en', subjectTemplate: subj, bodyTemplate: emailMjml(subj.replace(/^\[BANDWIDTH\] /, ''), body), bodyFormat: 'mjml', variablesSchema: vars },
      { categoryId, channel: 'in_app', locale: 'en', subjectTemplate: subj, bodyTemplate: body, bodyFormat: 'plaintext', variablesSchema: vars },
    ];
  }),
];


/**
 * Rows written by hand, one per (category, channel) for the two channels
 * whose bodies genuinely differ: MJML for email, short plaintext for the
 * in-app feed.
 */
const HAND_AUTHORED_TEMPLATES: readonly SeedTemplate[] = [
  ...TENANT_TEMPLATES,
  ...ADMIN_TEMPLATES,
];

/**
 * ── Channel seed strategy ──────────────────────────────────────────────
 *
 * EVERY delivery channel needs a seed template for EVERY category. A
 * channel with no template is not "unconfigured" — the dispatcher looks
 * one up, finds nothing, and drops the message with `no_template`. The
 * operator sees an enabled channel producing silence, and the only trace
 * is a row in the delivery log.
 *
 * That is exactly what shipped with the ntfy channel: `ntfy` joined
 * `NOTIFICATION_CHANNEL_ID` and `notification_providers` with zero
 * template rows behind it, and the dispatcher quietly borrowed the
 * `in_app` body instead — so ntfy messages could never be edited,
 * previewed, versioned or restored like every other channel's.
 *
 * This Record is `Record<NotificationChannelId, …>` on purpose: it is
 * TOTAL over the contract enum, so adding a channel to
 * `NOTIFICATION_CHANNEL_ID` in @insula/api-contracts is a **compile
 * error here** until that channel declares how its templates are
 * produced. `npm run typecheck` fails before any test runs.
 *
 * The companion runtime guard (notifications/seed-consistency.test.ts)
 * then asserts the strategy actually yielded one row per category — a
 * `hand-authored` declaration alone proves nothing.
 */
type ChannelSeedStrategy =
  /** Bodies are written out per category in the arrays above. */
  | { readonly kind: 'hand-authored' }
  /**
   * Bodies are generated from another channel's rows. Derivation — not a
   * second hand-written set — is what keeps `variablesSchema` identical
   * to the source: Handlebars runs in strict mode, so a body referencing
   * a variable the dispatcher does not pass throws, and the send is
   * silently skipped. A hand-maintained copy drifts; a derived one cannot.
   */
  | {
      readonly kind: 'derived';
      readonly from: NotificationChannelId;
      readonly transform: (source: SeedTemplate) => SeedTemplate;
    };

/**
 * ntfy is a phone push: a title, a short plaintext line, and a tap
 * target. The in-app feed entry is already written to that shape (median
 * body 80 chars, longest 215), so it is the right source — the push says
 * what the bell says. Click-through, priority and severity tags are added
 * by the publisher from the category, not by the template.
 */
function toNtfyTemplate(source: SeedTemplate): SeedTemplate {
  return {
    categoryId: source.categoryId,
    channel: 'ntfy',
    locale: source.locale,
    // ntfy clamps titles around 250 bytes; the publisher slices at 200.
    subjectTemplate: source.subjectTemplate,
    bodyTemplate: source.bodyTemplate,
    // Never markdown: ntfy renders markdown only for clients that opted in
    // via the X-Markdown header, which the publisher does not send.
    bodyFormat: 'plaintext',
    variablesSchema: source.variablesSchema,
  };
}

const CHANNEL_SEED_STRATEGY: Record<NotificationChannelId, ChannelSeedStrategy> = {
  in_app: { kind: 'hand-authored' },
  email: { kind: 'hand-authored' },
  ntfy: { kind: 'derived', from: 'in_app', transform: toNtfyTemplate },
};

function buildSeedTemplates(): readonly SeedTemplate[] {
  const derived: SeedTemplate[] = [];
  for (const [channel, strategy] of Object.entries(CHANNEL_SEED_STRATEGY)) {
    if (strategy.kind !== 'derived') continue;
    for (const source of HAND_AUTHORED_TEMPLATES) {
      if (source.channel !== strategy.from) continue;
      const row = strategy.transform(source);
      if (row.channel !== channel) {
        // A transform that mislabels its output would silently produce a
        // duplicate of the source channel instead of the derived one.
        throw new Error(
          `notification seed: '${channel}' transform emitted channel '${row.channel}'`,
        );
      }
      derived.push(row);
    }
  }
  return [...HAND_AUTHORED_TEMPLATES, ...derived];
}

export const ALL_SEED_TEMPLATES: readonly SeedTemplate[] = buildSeedTemplates();
