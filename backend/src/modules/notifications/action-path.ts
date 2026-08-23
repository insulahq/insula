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
]);

/** categoryId → static landing page (no per-resource deep link). */
const STATIC_PATHS: Record<string, string> = {
  // ---- admin / operator (admin-panel routes) ----
  'admin.slo_alert_warning': '/monitoring',
  'admin.slo_alert_critical': '/monitoring',
  'admin.slo_alert_resolved': '/monitoring',
  'admin.node_down': '/cluster/nodes',
  'admin.node_memory_event_warning': '/cluster/nodes',
  'admin.node_memory_event_critical': '/cluster/nodes',
  'admin.security_hardening_drift': '/security/posture',
  'admin.backup_failed': '/backups',
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
  'admin.email_complaint_warning': '/email/operations',
  'admin.email_complaint_critical': '/email/operations',

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
  'tls.certificate_issued': '/domains',
  'tls.certificate_failed': '/domains',
  'tls.certificate_fallback': '/domains',

  // ---- delivered to either panel; path exists in both ----
  'security.password_changed': '/user-settings',
  'security.password_reset': '/user-settings',
  'security.suspicious_activity': '/user-settings',
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
