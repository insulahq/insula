-- R6 PR 2: outbound send accounting.
--
-- Hourly buckets per (tenant, sender-domain), fed by Stalwart webhook
-- events (queue.authenticated-message-queued + limit-trip events).
-- Deliberately NOT per-message rows — the roadmap descopes per-message
-- tracking; counters are sufficient for usage display, quota warnings,
-- and the R4 complaint-rate denominator. Pruned at 35 days by the
-- data-retention scheduler (rolling 30d rates need a full month).

CREATE TABLE IF NOT EXISTS email_send_counters (
  tenant_id            varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain               varchar(255) NOT NULL,
  bucket_start         timestamptz NOT NULL,
  sent_count           integer NOT NULL DEFAULT 0,
  recipient_count      integer NOT NULL DEFAULT 0,
  bytes_total          bigint NOT NULL DEFAULT 0,
  rate_limited_count   integer NOT NULL DEFAULT 0,
  quota_rejected_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, domain, bucket_start)
);

-- Retention prune + "top senders this period" scans.
CREATE INDEX IF NOT EXISTS email_send_counters_bucket_idx
  ON email_send_counters (bucket_start);
