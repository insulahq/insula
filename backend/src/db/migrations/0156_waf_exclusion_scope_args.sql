-- Let a WAF rule exclusion be saved with scope 'args'.
--
-- The API contract (wafRuleExclusionScopeSchema) and the renderer have three
-- scopes: 'args', 'args_names_only' and 'full_disable'. 'args' is the one the
-- admin and tenant panels preselect, and the one that works for most rules —
-- it removes the parameter values AND names from the rule, where
-- 'args_names_only' removes only the names and leaves most requests blocked.
--
-- The table's CHECK was never widened with it. Migration 0015 allows
--
--     ('args_names_only', 'full_disable')
--
-- so every exclusion created with the preselected scope was refused by the
-- database (400 CHECK_CONSTRAINT_VIOLATION), in the admin panel and in the
-- tenant panel alike. The same trap as mail_drift_items.kind (0055, 0128): a
-- value added to the code's enum without the constraint that binds every
-- writer. backend/src/modules/waf-rule-exclusions/scope-constraint.test.ts now
-- compares the two.
--
-- Idempotent: DROP IF EXISTS then re-add. No data migration — every existing
-- row holds a value the old constraint allowed, and the new one allows more.
-- NOT VALID, as in 0128: it skips the scan of existing rows and still checks
-- every INSERT and UPDATE, which is all this constraint is for.
ALTER TABLE waf_rule_exclusions DROP CONSTRAINT IF EXISTS waf_rule_exclusions_scope_enum;
ALTER TABLE waf_rule_exclusions ADD CONSTRAINT waf_rule_exclusions_scope_enum
  CHECK (scope IN (
    'args',
    'args_names_only',
    'full_disable'
  )) NOT VALID;
