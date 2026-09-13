-- ROADMAP R5 — DMARC aggregate-report ingestion.
--
-- Stalwart's report-analysis parses the RFC 7489 aggregate XML for us and
-- stores a typed registry object; the platform polls those, persists a summary
-- here, and destroys the consumed object. Mirrors email_fbl_complaints (R4).
--
-- Two tables rather than one: the per-source rows are what make a failing
-- report actionable ("198.51.100.22 is sending as you and failing both checks"
-- is a different conversation from "your pass rate is 91%"), and folding them
-- into a jsonb column would make the one query anyone actually wants —
-- "which senders are failing for this domain" — unindexable.

CREATE TABLE IF NOT EXISTS email_dmarc_reports (
  id                    VARCHAR(36) PRIMARY KEY,
  -- Idempotency key. The poll is at-least-once: a destroy that fails leaves the
  -- object in Stalwart and the next tick re-reads it.
  stalwart_report_id    VARCHAR(64)  NOT NULL,
  tenant_id             VARCHAR(36)  REFERENCES tenants(id) ON DELETE SET NULL,
  email_domain_id       VARCHAR(36)  REFERENCES email_domains(id) ON DELETE SET NULL,
  -- The domain the policy was published for. Kept even when attribution fails:
  -- a report for a domain this platform does not host still says something
  -- about the platform's sending reputation.
  policy_domain         VARCHAR(255),
  org_name              VARCHAR(255),
  reporter_email        VARCHAR(320),
  -- The reporter's own id for this report. NOT unique on its own — two
  -- reporters can and do use the same counter.
  report_id             VARCHAR(255),
  date_range_begin      TIMESTAMPTZ,
  date_range_end        TIMESTAMPTZ,
  policy_disposition    VARCHAR(32),
  policy_adkim          VARCHAR(16),
  policy_aspf           VARCHAR(16),
  -- Denormalised counts, summed from the report's records at ingest. Computing
  -- them on read would mean re-walking every source row for every page view,
  -- and these never change once written.
  total_messages        INTEGER      NOT NULL DEFAULT 0,
  -- DMARC passes when EITHER mechanism passes AND aligns; the evaluated
  -- verdicts in the report already account for alignment.
  pass_messages         INTEGER      NOT NULL DEFAULT 0,
  fail_messages         INTEGER      NOT NULL DEFAULT 0,
  dkim_pass_messages    INTEGER      NOT NULL DEFAULT 0,
  spf_pass_messages     INTEGER      NOT NULL DEFAULT 0,
  quarantined_messages  INTEGER      NOT NULL DEFAULT 0,
  rejected_messages     INTEGER      NOT NULL DEFAULT 0,
  received_at           TIMESTAMPTZ  NOT NULL,
  raw                   JSONB,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_dmarc_reports_report_unique
  ON email_dmarc_reports (stalwart_report_id);
CREATE INDEX IF NOT EXISTS email_dmarc_reports_tenant_idx
  ON email_dmarc_reports (tenant_id, received_at);
-- The index behind the per-domain pass-rate query and the policy
-- recommendation, both of which filter by domain over a trailing window.
CREATE INDEX IF NOT EXISTS email_dmarc_reports_domain_idx
  ON email_dmarc_reports (policy_domain, received_at);
CREATE INDEX IF NOT EXISTS email_dmarc_reports_received_idx
  ON email_dmarc_reports (received_at);

CREATE TABLE IF NOT EXISTS email_dmarc_sources (
  id                VARCHAR(36) PRIMARY KEY,
  -- CASCADE: a source row is meaningless without its report, and the retention
  -- sweep deletes reports by age.
  report_id         VARCHAR(36)  NOT NULL REFERENCES email_dmarc_reports(id) ON DELETE CASCADE,
  tenant_id         VARCHAR(36)  REFERENCES tenants(id) ON DELETE SET NULL,
  policy_domain     VARCHAR(255),
  -- Text, not INET: reporters emit IPv4 and IPv6, and occasionally something
  -- malformed. A malformed address must not fail the whole report's insert —
  -- losing 40,000 good rows to one bad string is the wrong trade.
  source_ip         VARCHAR(64),
  message_count     INTEGER      NOT NULL DEFAULT 0,
  evaluated_dkim    VARCHAR(16),
  evaluated_spf     VARCHAR(16),
  disposition       VARCHAR(32),
  header_from       VARCHAR(255),
  received_at       TIMESTAMPTZ  NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_dmarc_sources_report_idx
  ON email_dmarc_sources (report_id);
-- "Which senders are failing for this domain, worst first" — the query the
-- per-source table exists to answer.
CREATE INDEX IF NOT EXISTS email_dmarc_sources_domain_idx
  ON email_dmarc_sources (policy_domain, received_at);
CREATE INDEX IF NOT EXISTS email_dmarc_sources_tenant_idx
  ON email_dmarc_sources (tenant_id, received_at);
