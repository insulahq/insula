-- The `cert-expiry` monitoring rule (a fixed 14 days before expiry) is
-- replaced by `cert-renewal-overdue`: less than half of the certificate's
-- renewal window left, measured against its own lifetime. Its threshold is a
-- ratio, not seconds.
--
-- An operator's on/off choice moves to the new rule. A threshold override
-- does not: seconds read as a ratio would fire on every certificate. The
-- retired rule's alert rows go too — nothing evaluates `cert-expiry` any more,
-- so a row left `firing` would stay firing forever.
--
-- Replay-safe: the INSERT skips an existing row, the DELETEs find nothing.
INSERT INTO monitoring_rule_overrides (rule_id, threshold, enabled, updated_at, updated_by)
SELECT 'cert-renewal-overdue', NULL, enabled, NOW(), updated_by
  FROM monitoring_rule_overrides
 WHERE rule_id = 'cert-expiry'
ON CONFLICT (rule_id) DO NOTHING;

DELETE FROM monitoring_rule_overrides WHERE rule_id = 'cert-expiry';
DELETE FROM alert_state WHERE rule_id = 'cert-expiry';
