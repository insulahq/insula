-- Every notification source starts with EVERY delivery channel enabled.
--
-- `ntfy` shipped complete — provider, templates, worker, admin UI — and was
-- still off on all fifty sources, because `default_channels` defaulted to a
-- hand-written ARRAY['in_app','email'] that nobody revisited when the channel
-- landed. An operator had to enable it by hand, per source.
--
-- Two parts, because the column default only governs rows nobody has inserted
-- yet, and the seeder inserts every category explicitly:
--   1. widen the column default so a future row is complete by construction;
--   2. backfill the rows that already exist on running clusters, since
--      `seedCategoriesIfMissing` is ON CONFLICT DO NOTHING and will never
--      revisit them.
--
-- Backfill is additive — it only ADDS missing channels and never removes one,
-- so an operator who deliberately turned a channel off keeps that choice for
-- the channels they touched. Adding is the documented intent; silently
-- re-enabling something switched off would not be.
--
-- Keep the list here in step with NOTIFICATION_CHANNEL_ID in
-- packages/api-contracts/src/notification-categories.ts. A unit test asserts
-- the two agree, so adding a channel fails the suite until this is updated.

ALTER TABLE notification_categories
  ALTER COLUMN default_channels
  SET DEFAULT ARRAY['in_app', 'email', 'ntfy']::text[];

UPDATE notification_categories
SET default_channels = (
      SELECT ARRAY(
        SELECT DISTINCT c
        FROM unnest(default_channels || ARRAY['in_app', 'email', 'ntfy']::text[]) AS c
        ORDER BY c
      )
    ),
    updated_at = NOW()
WHERE NOT (default_channels @> ARRAY['in_app', 'email', 'ntfy']::text[]);
