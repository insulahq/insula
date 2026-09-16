-- Re-derive default_channels for EVERY category.
--
-- Supersedes the partial 0112 for two reasons found on the live DEV database
-- rather than in review:
--
--   1. Seven categories were added after 0112 was generated and seeded
--      themselves with ALL_NOTIFICATION_CHANNELS, so `mailbox.quota_exceeded`
--      — a tenant-scoped event — sat on the shared operator ntfy topic. The
--      root fix is in categories/service.ts, which now seeds through the same
--      resolver the dispatcher uses; this repairs the rows already written.
--
--   2. `reportsOn` was wrong on ten mail-related categories. It means "THIS
--      CHANNEL MAY BE UNREACHABLE", not "topically about" — and marking a full
--      mailbox, a saturated sending limit or a deliverability complaint as
--      reporting on `mail` excluded the EMAIL channel from all of them. That
--      would have silenced the mailbox owner the quota feature exists to
--      reach. Only mail_blocklisted and mail_health_degraded still declare it,
--      where the transport genuinely is the subject.
--
-- Generated from categories/seed.ts through routing/classes.ts:resolveChannels.
-- Regenerate rather than hand-editing: the first hand-written version of this
-- file got four of eight rows wrong.
--
-- Idempotent and replay-safe: plain UPDATEs to a computed value.
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'security.password_reset';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'security.password_changed';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'security.suspicious_activity';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'subscription.expiry_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'subscription.renewed';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'subscription.changed';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'account.sub_account_added';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'mailbox.quota_threshold';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'mailbox.quota_exceeded';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tasks.scheduled_failure';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.suspended';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.restored';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.archived';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.deleted';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tls.certificate_failed';
UPDATE notification_categories SET default_channels = ARRAY['in_app']::text[] WHERE id = 'tls.certificate_issued';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tls.certificate_fallback';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.cert_issuance_failed';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.cert_expiring';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.cert_renewal_failed';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email', 'ntfy']::text[] WHERE id = 'admin.backup_failed';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email', 'ntfy']::text[] WHERE id = 'admin.backup_target_unreachable';
UPDATE notification_categories SET default_channels = ARRAY['email', 'ntfy']::text[] WHERE id = 'admin.node_down';
UPDATE notification_categories SET default_channels = ARRAY['in_app']::text[] WHERE id = 'admin.tenant_auto_repinned';
UPDATE notification_categories SET default_channels = ARRAY['email', 'ntfy']::text[] WHERE id = 'admin.node_rebooting';
UPDATE notification_categories SET default_channels = ARRAY['email', 'ntfy']::text[] WHERE id = 'admin.node_startup_complete';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email', 'ntfy']::text[] WHERE id = 'admin.node_memory_event_critical';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.node_memory_event_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.security_hardening_drift';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email', 'ntfy']::text[] WHERE id = 'admin.slo_alert_critical';
UPDATE notification_categories SET default_channels = ARRAY['in_app']::text[] WHERE id = 'admin.slo_alert_resolved';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.slo_alert_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email', 'ntfy']::text[] WHERE id = 'admin.wal_archive_failing';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email', 'ntfy']::text[] WHERE id = 'admin.wal_archive_auto_disabled';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.email_quota_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.email_quota_exceeded';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.email_complaint_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email', 'ntfy']::text[] WHERE id = 'admin.email_complaint_critical';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.email_abuse_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email', 'ntfy']::text[] WHERE id = 'admin.email_abuse_critical';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'ntfy']::text[] WHERE id = 'admin.mail_blocklisted';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.custom_deployment_rolled_back';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.custom_deployment_failed';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'ntfy']::text[] WHERE id = 'admin.mail_health_degraded';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.tenant_resource_saturation_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email', 'ntfy']::text[] WHERE id = 'admin.tenant_resource_saturation_critical';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.tenant_pod_oom';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.subscriptions_expiring';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email', 'ntfy']::text[] WHERE id = 'admin.email_quota_exceeded';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email', 'ntfy']::text[] WHERE id = 'admin.cluster_storage_capacity';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.mailbox_quota_fleet';
UPDATE notification_categories SET default_channels = ARRAY['in_app']::text[] WHERE id = 'admin.tenant_bandwidth_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.tenant_bandwidth_critical';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.resource_saturation_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.resource_saturation_critical';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.bandwidth_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.bandwidth_exceeded';
UPDATE notification_categories SET default_channels = ARRAY['in_app']::text[] WHERE id = 'legacy.info';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'legacy.warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'legacy.error';
UPDATE notification_categories SET default_channels = ARRAY['in_app']::text[] WHERE id = 'legacy.success';
