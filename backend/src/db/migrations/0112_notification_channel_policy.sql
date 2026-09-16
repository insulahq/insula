-- Reset every category's channel list from its class, audience and subsystem.
--
-- All 53 categories shipped with all three channels enabled, because the seed
-- default was hand-written once and never revisited. The consequences, measured
-- on production over 14 days:
--
--   * 75% of all notification traffic was SLO alerts, and the single largest
--     source was `admin.slo_alert_resolved` at 130 deliveries -- each one
--     emailed AND pushed to say that something had STOPPED being broken.
--   * ntfy is ONE shared operator topic with no per-user leg, so every
--     tenant-facing category pushed tenant data to the operator's phone.
--
-- Channels are now derived: class defaults, intersected with what the audience
-- may use, minus channels that depend on the subsystem being reported on, minus
-- broadcast channels for tenant-scoped content. This statement writes that
-- derivation once; `default_channels` remains operator-editable afterwards and
-- is treated as an override from here on (the safety filters still apply to it).
--
-- 46 of 53 categories change. Generated from categories/seed.ts via
-- routing/classes.ts:resolveChannels -- regenerate rather than hand-editing.
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'security.password_reset';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'security.password_changed';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'security.suspicious_activity';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'subscription.expiry_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'subscription.renewed';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'subscription.changed';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'account.sub_account_added';
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
UPDATE notification_categories SET default_channels = ARRAY['in_app']::text[] WHERE id = 'tenant.email_quota_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app']::text[] WHERE id = 'tenant.email_quota_exceeded';
UPDATE notification_categories SET default_channels = ARRAY['in_app']::text[] WHERE id = 'admin.email_complaint_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'ntfy']::text[] WHERE id = 'admin.email_complaint_critical';
UPDATE notification_categories SET default_channels = ARRAY['in_app']::text[] WHERE id = 'admin.email_abuse_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'ntfy']::text[] WHERE id = 'admin.email_abuse_critical';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'ntfy']::text[] WHERE id = 'admin.mail_blocklisted';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.custom_deployment_rolled_back';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.custom_deployment_failed';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'ntfy']::text[] WHERE id = 'admin.mail_health_degraded';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.tenant_resource_saturation_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email', 'ntfy']::text[] WHERE id = 'admin.tenant_resource_saturation_critical';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.tenant_pod_oom';
UPDATE notification_categories SET default_channels = ARRAY['in_app']::text[] WHERE id = 'admin.tenant_bandwidth_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'admin.tenant_bandwidth_critical';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.bandwidth_warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'tenant.bandwidth_exceeded';
UPDATE notification_categories SET default_channels = ARRAY['in_app']::text[] WHERE id = 'legacy.info';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'legacy.warning';
UPDATE notification_categories SET default_channels = ARRAY['in_app', 'email']::text[] WHERE id = 'legacy.error';
UPDATE notification_categories SET default_channels = ARRAY['in_app']::text[] WHERE id = 'legacy.success';
-- 46/53 changed
