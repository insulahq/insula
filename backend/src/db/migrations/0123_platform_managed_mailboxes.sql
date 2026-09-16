-- Platform-managed intake mailboxes are platform plumbing, not tenant mail.
--
-- `ensureReportIntake` creates one `dmarc@` and one `postmaster@` per enabled
-- email domain by calling the TENANT-FACING createMailbox(). For every tenant
-- already at its plan mailbox cap that call was rejected with 409, and each
-- rejection fired a tenant-facing "you have used N of N mailboxes, remove one
-- or upgrade your plan" notification about an action no tenant ever took. The
-- reconciler then retried on its 5-minute tick, forever: 9 rejections per tick
-- on production, ~108 emails/hour, which saturated the sending limit of the
-- tenant that owns the notification sender domain and produced a second wave
-- of quota-saturation alerts on top.
--
-- Marking these rows lets the count cap ignore them, so platform plumbing
-- stops consuming capacity a tenant paid for and stops colliding with it.
ALTER TABLE mailboxes
  ADD COLUMN IF NOT EXISTS platform_managed BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill exactly what the reconciler created. Matched on the display names
-- it writes rather than on local_part alone: there is no reserved-local-part
-- guard, so a tenant CAN own a hand-made postmaster@, and that one must keep
-- counting against their quota.
UPDATE mailboxes SET platform_managed = TRUE
 WHERE platform_managed = FALSE
   AND (
     (local_part = 'dmarc' AND display_name = 'DMARC aggregate report intake')
     OR (local_part = 'postmaster' AND display_name = 'Postmaster / DSN intake')
   );

-- The count cap reads only billable rows.
CREATE INDEX IF NOT EXISTS mailboxes_tenant_billable_idx
  ON mailboxes (tenant_id) WHERE platform_managed = FALSE;

-- Shrink them to the 50 MB transit-buffer size (operator decision 2026-09-16).
-- These hold nothing anyone reads after ingest: the DMARC poller destroys each
-- report it consumes, and a DSN matters only until it has been read. The old
-- 256/512 MB were sized as if these were real mailboxes, and production had
-- accumulated 385 undeliverable DSNs. The reconciler converges this value on
-- every tick too — this UPDATE only avoids waiting for the first one.
UPDATE mailboxes SET quota_mb = 50
 WHERE platform_managed = TRUE AND quota_mb <> 50;
