-- Sending limits are per mail domain; two things here still counted per tenant.
--
-- email_send_counters.rate_limited_daily_count: of the held messages counted
-- in rate_limited_count, the ones the DAILY limit held. Stalwart's windows are
-- fixed (whole UTC hours and days), so a daily hold is retried at 00:00 UTC
-- and an hourly one at the next full hour. Without the split nothing could
-- say whether a message held at 09:10 was already released or still waits
-- until midnight. The remainder (rate_limited_count minus this) is hourly.
--
-- email_quota_events.domain: the 80%/100% crossing dedupe was keyed by tenant,
-- so the first of a tenant's domains to reach its limit used up the day's
-- alert and a second domain reaching its own limit was never reported. Rows
-- written before this migration keep domain '' and age out within 7 days;
-- they do not match the per-domain rows, so a crossing already notified in
-- the current hour or day is notified once more, naming its domain.
-- Holds counted before this migration have no window recorded and count as
-- hourly until the day ends.
ALTER TABLE email_send_counters ADD COLUMN IF NOT EXISTS rate_limited_daily_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE email_quota_events ADD COLUMN IF NOT EXISTS domain VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE email_quota_events DROP CONSTRAINT IF EXISTS email_quota_events_pkey;
ALTER TABLE email_quota_events ADD PRIMARY KEY (tenant_id, domain, window_kind, threshold, window_start);
