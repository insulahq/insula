-- 0056: monitoring/SLO alerting tables (ADR-051 phase 3)
--
-- alert_state                — live state per rule (evaluator is the only
--                              writer; severity-transition + 24h re-fire
--                              throttle mirror node_health_state)
-- monitoring_evaluator_lease — single-row conditional-UPDATE claim so
--                              exactly ONE of the HA platform-api replicas
--                              evaluates per minute (the
--                              backup_schedules.last_fired_at pattern)
-- monitoring_rule_overrides  — operator threshold/disable overrides for
--                              the in-code rule pack (cannot add rules)
--
-- Idempotent: IF NOT EXISTS throughout; the lease seed is ON CONFLICT
-- DO NOTHING.

CREATE TABLE IF NOT EXISTS alert_state (
  rule_id            VARCHAR(100) PRIMARY KEY,
  state              VARCHAR(16) NOT NULL,
  severity           VARCHAR(16) NOT NULL,
  since              TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_value         DOUBLE PRECISION,
  last_notified_at   TIMESTAMPTZ,
  last_evaluated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alert_state_state_check CHECK (state IN ('firing', 'resolved')),
  CONSTRAINT alert_state_severity_check CHECK (severity IN ('warning', 'critical'))
);

CREATE TABLE IF NOT EXISTS monitoring_evaluator_lease (
  id           VARCHAR(16) PRIMARY KEY,
  last_run_at  TIMESTAMPTZ
);

INSERT INTO monitoring_evaluator_lease (id, last_run_at)
VALUES ('evaluator', NULL)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS monitoring_rule_overrides (
  rule_id     VARCHAR(100) PRIMARY KEY,
  threshold   DOUBLE PRECISION,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  VARCHAR(36)
);
