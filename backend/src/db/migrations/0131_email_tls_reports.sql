-- TLS-RPT (RFC 8460) report ingestion.
--
-- Every mail-enabled domain publishes
-- `_smtp._tls.<domain> TXT "v=TLSRPTv1; rua=mailto:postmaster@<domain>"`, so
-- receivers report back daily on whether they could negotiate TLS to OUR MX.
-- Stalwart parses those into `x:TlsExternalReport` objects; the platform polls
-- them, attributes each to a tenant by policy domain, and destroys what it
-- consumed.
--
-- The subject is INBOUND delivery to us. A failure here means somebody could
-- not deliver to this platform securely — a cert that expired, an MTA-STS
-- policy that stopped matching, a stale MX. That is a platform or domain
-- problem, not the sender's.
--
-- ONE ROW PER REPORT, not per policy: a report names one policy domain in
-- practice, and the per-policy and per-failure breakdown is kept in `failures`
-- rather than exploded into a child table nothing would join against. The
-- DMARC pair next door has a child table because its sources ARE the query
-- ("who is sending as me"); the equivalent question here is answered by the
-- failure result types, which fit in one document.

CREATE TABLE IF NOT EXISTS email_tls_reports (
  id                     varchar(36) PRIMARY KEY,
  -- Stalwart-side object id; the poller's idempotence key.
  stalwart_report_id     varchar(64) NOT NULL UNIQUE,
  tenant_id              varchar(36) REFERENCES tenants(id) ON DELETE SET NULL,
  -- The domain the reporting policy applied to — ours.
  policy_domain          varchar(255),
  -- Who sent the report (the receiving operator).
  org_name               varchar(255),
  contact_info           varchar(320),
  -- The reporter's own report id, for correlating with their support desk.
  report_id              varchar(255),
  date_range_start       timestamptz,
  date_range_end         timestamptz,
  -- Summed across every policy in the report.
  successful_sessions    integer NOT NULL DEFAULT 0,
  failed_sessions        integer NOT NULL DEFAULT 0,
  -- Flattened failure details: result type, counts, and the MX involved.
  failures               jsonb,
  received_at            timestamptz NOT NULL,
  raw                    jsonb,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_tls_reports_tenant_idx
  ON email_tls_reports (tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS email_tls_reports_domain_idx
  ON email_tls_reports (policy_domain, received_at DESC);
CREATE INDEX IF NOT EXISTS email_tls_reports_received_idx
  ON email_tls_reports (received_at DESC);
-- The "is anything actually failing" scan, which is the only one an operator
-- runs in a hurry. Partial, because healthy reports are the overwhelming bulk.
CREATE INDEX IF NOT EXISTS email_tls_reports_failing_idx
  ON email_tls_reports (received_at DESC) WHERE failed_sessions > 0;
