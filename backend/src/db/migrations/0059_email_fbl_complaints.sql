-- R4 PR 3: FBL complaint ingestion.
--
-- One row per parsed ARF report pulled from Stalwart's report-analysis
-- store (x:ArfExternalReport). Complaint volume is inherently tiny
-- (humans clicking "spam"), so individual rows are fine — this is NOT
-- the descoped per-message send tracking. Rolling complaint RATES are
-- computed on read against email_send_counters (the R6 denominator).
-- Pruned at 90 days by data-retention.

CREATE TABLE IF NOT EXISTS email_fbl_complaints (
  id                  varchar(36) PRIMARY KEY,
  -- Stalwart-side report object id; idempotence key for the poller.
  stalwart_report_id  varchar(64) NOT NULL UNIQUE,
  -- SET NULL so complaint history survives tenant deletion (the
  -- platform's IP/domain reputation outlives any one tenant).
  tenant_id           varchar(36) REFERENCES tenants(id) ON DELETE SET NULL,
  domain              varchar(255),
  feedback_type       varchar(32) NOT NULL,
  original_mail_from  varchar(320),
  original_rcpt_to    varchar(320),
  source_ip           varchar(64),
  reporting_mta       varchar(255),
  reporter            varchar(320),
  incidents           integer NOT NULL DEFAULT 1,
  received_at         timestamptz NOT NULL,
  raw                 jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_fbl_complaints_tenant_idx
  ON email_fbl_complaints (tenant_id, received_at);
CREATE INDEX IF NOT EXISTS email_fbl_complaints_domain_idx
  ON email_fbl_complaints (domain, received_at);
CREATE INDEX IF NOT EXISTS email_fbl_complaints_received_idx
  ON email_fbl_complaints (received_at);
