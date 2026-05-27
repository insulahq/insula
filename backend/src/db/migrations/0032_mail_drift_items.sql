-- mail_drift_items: durable record of platform-DB / Stalwart drift surfaced
-- by stalwart-principals-sync. Replaces the prior log-only behaviour, which
-- was operationally invisible (no notification, no UI, no audit trail).
--
-- A drift item exists when:
--   kind='domain'   — a platform email_domains row's stalwart_domain_id
--                     points to a Stalwart Domain that is no longer present
--                     (Stalwart lost the entry — typical cause: a failed
--                     mail-stack failover prior to the 2026-05-27 fix).
--   kind='mailbox'  — same shape but for mailboxes.stalwart_principal_id.
--
-- Lifecycle:
--   first_detected_at + last_seen_at  bump on each sync tick the item is
--                                     still in drift. resolved_at stays NULL.
--   resolved_at + resolved_via        set when the item is no longer in
--                                     drift (Stalwart recovered it via
--                                     restore, operator recreated it, or
--                                     operator dismissed it as accepted loss).
--
-- Uniqueness: at most ONE active item per (kind, platform_row_id). When a
-- previously-resolved item drifts again, we DO insert a new row (so the
-- audit trail shows the re-occurrence). The unique partial index enforces
-- this without blocking history.
CREATE TABLE IF NOT EXISTS mail_drift_items (
  id                     varchar(36) PRIMARY KEY,
  kind                   varchar(16) NOT NULL,
  expected_name          varchar(255) NOT NULL,
  expected_stalwart_id   varchar(64),
  platform_row_id        varchar(36) NOT NULL,
  first_detected_at      timestamp NOT NULL DEFAULT now(),
  last_seen_at           timestamp NOT NULL DEFAULT now(),
  resolved_at            timestamp,
  resolved_via           varchar(32),
  notes                  text,
  CONSTRAINT mail_drift_kind_check CHECK (kind IN ('domain', 'mailbox')),
  CONSTRAINT mail_drift_resolved_via_check CHECK (
    resolved_via IS NULL OR resolved_via IN ('recreated', 'restored', 'dismissed', 'reappeared')
  ),
  CONSTRAINT mail_drift_resolution_consistent CHECK (
    (resolved_at IS NULL AND resolved_via IS NULL)
    OR (resolved_at IS NOT NULL AND resolved_via IS NOT NULL)
  )
);

-- Only one ACTIVE drift item per (kind, platform_row_id). Allows multiple
-- historical (resolved) rows for the same row, which is the audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS mail_drift_active_unique
  ON mail_drift_items (kind, platform_row_id)
  WHERE resolved_at IS NULL;

-- Fast lookup for the admin UI list (active items, newest detection first).
CREATE INDEX IF NOT EXISTS mail_drift_active_by_detected
  ON mail_drift_items (first_detected_at DESC)
  WHERE resolved_at IS NULL;
