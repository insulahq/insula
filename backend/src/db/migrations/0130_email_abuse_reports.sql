-- Abuse-report (ARF, RFC 5965) ingestion.
--
-- Stalwart parses ARF complaints that arrive at a ReportSettings intake
-- address and stores them as `x:ArfExternalReport` registry objects. The
-- platform polls those, persists one row per report here, notifies the admin
-- roster, and destroys the consumed object.
--
-- WHY THIS IS NOT THE OLD email_fbl_complaints TABLE
--
-- That table was built for provider FEEDBACK LOOPS: it existed to compute a
-- rolling complaint RATE against the send counters, which is a deliverability
-- metric and needs per-provider enrolment (Microsoft JMRP/SNDS, Yahoo CFL) to
-- produce any rows at all. It never produced a single one, and was dropped.
--
-- This is the other half of ARF, and it needs no enrolment: a complaint an
-- operator or an automated abuse desk sends about mail from one of our
-- tenants. One of those is worth reading on its own; a rate is not the point,
-- so there is no denominator here and no threshold evaluator. The unit is an
-- incident to act on.
--
-- Retention is deliberately long — a complaint is evidence, and the questions
-- it answers ("has this tenant done this before?") are asked months later.

CREATE TABLE IF NOT EXISTS email_abuse_reports (
  id                  varchar(36) PRIMARY KEY,
  -- Stalwart-side report object id. UNIQUE so a poll that fails midway, or two
  -- replicas polling at once, cannot double-insert: the object is destroyed
  -- only after the row is committed, so a redelivery is expected, not an error.
  stalwart_report_id  varchar(64) NOT NULL UNIQUE,
  -- SET NULL so the evidence survives tenant deletion. Platform IP and domain
  -- reputation outlives any one tenant, and "who was this before you deleted
  -- them" is exactly the question a later complaint raises.
  tenant_id           varchar(36) REFERENCES tenants(id) ON DELETE SET NULL,
  -- The reported domain, as attributed at ingest. Kept even when tenant_id is
  -- NULL (unattributed, or the tenant is gone).
  domain              varchar(255),
  -- ARF `Feedback-Type`: abuse, fraud, virus, not-spam, auth-failure, other.
  feedback_type       varchar(32) NOT NULL,
  original_mail_from  varchar(320),
  original_rcpt_to    varchar(320),
  source_ip           varchar(64),
  reporting_mta       varchar(255),
  -- Envelope/From of the report itself — who complained.
  reporter            varchar(320),
  subject             text,
  -- ARF `Incidents`: one report may represent many occurrences.
  incidents           integer NOT NULL DEFAULT 1,
  received_at         timestamptz NOT NULL,
  -- Whether the admin roster has been told about this one. Persisted rather
  -- than inferred so a notification failure retries and a restart cannot
  -- re-announce reports the operator has already seen.
  notified_at         timestamptz,
  -- The parsed report as Stalwart returned it, for the fields this schema does
  -- not promote to columns.
  raw                 jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_abuse_reports_tenant_idx
  ON email_abuse_reports (tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS email_abuse_reports_domain_idx
  ON email_abuse_reports (domain, received_at DESC);
CREATE INDEX IF NOT EXISTS email_abuse_reports_received_idx
  ON email_abuse_reports (received_at DESC);
-- Drives the "what still needs announcing" scan, which is the hot path on
-- every poll. Partial, because the answer is almost always the empty set.
CREATE INDEX IF NOT EXISTS email_abuse_reports_unnotified_idx
  ON email_abuse_reports (received_at) WHERE notified_at IS NULL;
