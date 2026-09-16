/**
 * Resolve the in-app page a notification should open when clicked.
 *
 * The #1 operator complaint about notifications is "where do I even start
 * fixing this?" — an alert with no action path. Every category here maps to
 * the exact page an operator/tenant would act on. Deep-links to a specific
 * tenant when the row carries one (`resourceType==='tenant'`), otherwise the
 * subsystem overview page.
 *
 * One source of truth for BOTH panels: `admin.*` categories reach admin
 * recipients (admin-panel routes); everything else reaches tenant recipients
 * (tenant-panel routes). Paths that exist in both panels (`/user-settings`,
 * `/users`) are safe for the handful of categories delivered to either.
 *
 * Returns `null` for categories with no meaningful landing page (the legacy.*
 * family); the frontend then falls back to the full notifications list.
 */
export interface ActionPathInput {
  readonly categoryId: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
}

/**
 * Admin categories that are ABOUT one specific tenant's workload — clicking
 * should land on that tenant, not a cluster-wide page. The dispatcher stamps
 * `resourceType:'tenant'` + `resourceId:<tenantId>` on these rows.
 */
const TENANT_SCOPED_ADMIN = new Set<string>([
  'admin.tenant_bandwidth_warning',
  'admin.tenant_bandwidth_critical',
  'admin.tenant_resource_saturation_warning',
  'admin.tenant_resource_saturation_critical',
  'admin.tenant_pod_oom',
  'admin.custom_deployment_failed',
  // Added 2026-09-16. It pointed at `/tenants` — the LIST, which shows no
  // sending limits whatsoever, so the operator arrived at a page that could
  // not tell them anything about the alert they had just clicked. The tenant's
  // own page carries the limit.
  'admin.email_quota_exceeded',
]);

/** categoryId → static landing page (no per-resource deep link). */
const STATIC_PATHS: Record<string, string> = {
  // ---- admin / operator (admin-panel routes) ----
  'admin.slo_alert_warning': '/monitoring',
  'admin.slo_alert_critical': '/monitoring',
  'admin.slo_alert_resolved': '/monitoring',
  'admin.node_down': '/cluster/nodes',
  'admin.tenant_auto_repinned': '/tenants/list',
  'admin.node_rebooting': '/cluster/nodes',
  'admin.node_startup_complete': '/cluster/nodes',
  'admin.node_memory_event_warning': '/cluster/nodes',
  'admin.node_memory_event_critical': '/cluster/nodes',
  'admin.security_hardening_drift': '/security/posture',
  'admin.backup_failed': '/backups',
  'admin.backup_stale': '/backups',
  'admin.backup_never_run': '/backups',
  'admin.backup_target_unreachable': '/backups/targets',
  'admin.wal_archive_failing': '/backups',
  'admin.wal_archive_auto_disabled': '/backups',
  'admin.cert_expiring': '/cluster/ingress-tls',
  'admin.cert_issuance_failed': '/cluster/ingress-tls',
  'admin.cert_renewal_failed': '/cluster/ingress-tls',
  'admin.mail_blocklisted': '/email/operations',
  'admin.mail_health_degraded': '/email/operations',
  'admin.email_abuse_warning': '/email/operations',
  'admin.email_abuse_critical': '/email/operations',

  // ---- tenant self-service (tenant-panel routes) ----
  'tenant.bandwidth_exceeded': '/resource-usage',
  'tenant.bandwidth_warning': '/resource-usage',
  'tenant.email_quota_exceeded': '/email',
  'tenant.email_quota_warning': '/email',
  'tenant.custom_deployment_rolled_back': '/applications',
  'tenant.suspended': '/settings',
  'tenant.archived': '/settings',
  'tenant.restored': '/settings',
  'tenant.deleted': '/settings',
  'subscription.changed': '/settings',
  'subscription.renewed': '/settings',
  'subscription.expiry_warning': '/settings',
  'tasks.scheduled_failure': '/cron-jobs',
  // Both mailbox-quota categories land on the tenant's own email page, where
  // the mailbox list and its quota control already live — the issue belongs on
  // the surface that fixes it, not on a page about the problem.
  'mailbox.quota_threshold': '/email',
  'mailbox.quota_exceeded': '/email',
  'admin.mailbox_quota_fleet': '/tenants',
  // The storage settings page is where capacity is read and nodes are added.
  'admin.cluster_storage_capacity': '/settings/storage',
  // Operational events land on the surface that owns the subsystem.
  'admin.storage_event': '/settings/storage',
  'admin.node_event': '/cluster/nodes',
  'admin.database_event': '/backups',
  'admin.mail_event': '/email/operations',
  'admin.platform_event': '/platform/updates',
  'admin.tenant_integrity': '/tenants',
  'tenant.domain_verification': '/domains',
  'tenant.backup_event': '/backups',
  'tenant.mail_event': '/email',
  'platform.digest': '/notifications',
  'admin.notification_escalated': '/platform/notifications',
  'admin.subscriptions_expiring': '/tenants',
  // The tenant lands on the page that shows the usage bars, not on a page
  // about the concept of a limit.
  'tenant.resource_saturation_warning': '/dashboard',
  'tenant.resource_saturation_critical': '/dashboard',
  'tls.certificate_issued': '/domains',
  'tls.certificate_failed': '/domains',
  'tls.certificate_fallback': '/domains',

  // ---- delivered to either panel; path exists in both ----
  'security.password_changed': '/user-settings',
  'security.password_reset': '/user-settings',
  'account.sub_account_added': '/users',
};

export function notificationActionPath(input: ActionPathInput): string | null {
  const { categoryId, resourceType, resourceId } = input;
  if (!categoryId) return null;

  if (TENANT_SCOPED_ADMIN.has(categoryId)) {
    return resourceType === 'tenant' && resourceId ? `/tenants/${resourceId}` : '/tenants';
  }

  return STATIC_PATHS[categoryId] ?? null;
}
