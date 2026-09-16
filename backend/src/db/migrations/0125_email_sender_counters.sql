-- Per-SENDER outbound counters.
--
-- Why this table exists: `email_send_counters` is keyed by (tenant, domain,
-- bucket), and the Stalwart webhook that feeds it carries the full envelope
-- sender — `ingest.ts:senderDomainOf()` threw the mailbox away and kept only
-- the part after the '@'. The sending-limit notifications could therefore
-- never answer the operator's first question: WHICH mailbox sent the 53
-- messages? Naming the tenant is not an answer when a tenant has ten
-- mailboxes and one of them is compromised.
--
-- Kept separate rather than widening the existing counters: those rows drive
-- the limit arithmetic and the overview, and adding a sender column to their
-- primary key would multiply them by mailbox count for every reader. This
-- table is only read when a notification needs to name a sender.
--
-- Cardinality is bounded by (mailboxes × hours) and pruned on the same
-- schedule as email_send_counters.
CREATE TABLE IF NOT EXISTS email_sender_counters (
  tenant_id    VARCHAR(36)  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sender       VARCHAR(320) NOT NULL,
  bucket_start TIMESTAMPTZ  NOT NULL,
  sent_count   INTEGER      NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, sender, bucket_start)
);

CREATE INDEX IF NOT EXISTS email_sender_counters_bucket_idx
  ON email_sender_counters (bucket_start);

-- Reading "top senders for this tenant in this window" is the only query.
CREATE INDEX IF NOT EXISTS email_sender_counters_tenant_bucket_idx
  ON email_sender_counters (tenant_id, bucket_start DESC);
