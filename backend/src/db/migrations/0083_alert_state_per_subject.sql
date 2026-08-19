-- 0083: alert_state becomes per-SUBJECT, not per-rule.
--
-- Every SLO alert was anonymous. Two causes, both fixed together:
--   * the rules aggregated with a bare `max(...)`/`min(...)`, collapsing
--     every series into one scalar and discarding `name`, `namespace`,
--     `node`, `instance` before the evaluator ever saw them;
--   * this table was keyed by rule_id alone, so even with labels there was
--     nowhere to record "certificate A is broken, certificate B is fine".
--
-- The operator's report: "CERT NOT READY / CERT EXPIRY in notifications, the
-- SLO page and Active Alerts, but NOWHERE does it show which certificate or
-- which tenant is affected."
--
-- Existing rows are rule-level; they keep subject_key = '' and are carried
-- forward, so a currently-firing alert does not flap on deploy. The next
-- evaluation tick resolves them and re-fires per subject.

ALTER TABLE alert_state
  ADD COLUMN IF NOT EXISTS subject_key varchar(512) NOT NULL DEFAULT '';

ALTER TABLE alert_state
  ADD COLUMN IF NOT EXISTS subject_labels jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Repoint the primary key at (rule_id, subject_key). The old PK name is
-- Postgres' default for a single-column PK on this table.
ALTER TABLE alert_state DROP CONSTRAINT IF EXISTS alert_state_pkey;

ALTER TABLE alert_state
  ADD CONSTRAINT alert_state_pkey PRIMARY KEY (rule_id, subject_key);

-- The panel lists firing alerts newest-first across all rules.
CREATE INDEX IF NOT EXISTS alert_state_state_since_idx
  ON alert_state (state, since DESC);
