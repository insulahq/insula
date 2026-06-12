-- R4/R6 PR 4: threshold-evaluator dedupe state.
--
-- email_quota_events: one row per (tenant, window, threshold,
-- window_start) crossing — the PK is the dedupe (the mailbox-quota
-- notification pattern). Rows age out naturally; the evaluator prunes
-- anything older than 7 days on each pass.
--
-- email_complaint_events: latest firing per (domain, level); re-fires
-- after 24h while the rate stays above threshold or when the level
-- escalates. Keyed by domain (not tenant) — complaints survive tenant
-- deletion.

CREATE TABLE IF NOT EXISTS email_quota_events (
  tenant_id    varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  window_kind  varchar(8) NOT NULL,
  threshold    integer NOT NULL,
  window_start timestamptz NOT NULL,
  fired_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, window_kind, threshold, window_start)
);

CREATE TABLE IF NOT EXISTS email_complaint_events (
  domain    varchar(255) NOT NULL,
  level     varchar(16) NOT NULL,
  fired_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (domain, level)
);
