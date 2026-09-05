-- waf_logs: give each ModSecurity rule-match a stable identity.
--
-- The scraper reads a 35s log window every 30s, so ~5s of every cycle is
-- re-read on purpose (a smaller window would drop events between cycles).
-- Nothing made that re-read idempotent: the insert generated a fresh random
-- UUID each time and relied on catching SQLSTATE 23505, but NO unique
-- constraint existed on this table, so that catch could never fire.
--
-- Measured on DEV 2026-09-05: 12 requests spread evenly across one cycle
-- produced 76 rows for 60 distinct (request_uri, rule_id) pairs — every rule of
-- the three requests that landed in the overlap band was written twice.
--
-- This is not merely cosmetic. crowdsec-autoban decides with
-- `qualifyingCount < eventThreshold`, which counts ROWS, so a duplicated event
-- pushed a source IP across the operator's configured threshold on roughly half
-- the traffic they asked for.

ALTER TABLE waf_logs ADD COLUMN IF NOT EXISTS event_key varchar(128);

-- Existing rows keep event_key = NULL and are LEFT ALONE. Two reasons, and the
-- second is the important one:
--
--  1. It is not needed. Postgres treats NULLs as distinct under a unique index,
--     so the index below builds over a fully-NULL column without conflict.
--
--  2. Deduplicating them would destroy real data. ModSecurity's unique_id was
--     never stored, so for a historical row there is nothing that distinguishes
--     a scrape-overlap duplicate from a scanner that genuinely sent the same
--     request twice. A "delete rows identical within N seconds" heuristic must
--     use N > 30 to catch the overlap pairs at all (they are inserted a full
--     cycle apart) — which is wide enough to also swallow real repeat hits. On
--     DEV that heuristic matched 69 of 500 rows, and this is a security audit
--     log feeding ban decisions: silently dropping genuine events from it is
--     worse than leaving a known-bounded number of duplicates to age out
--     through the existing per-route pruning.
CREATE UNIQUE INDEX IF NOT EXISTS waf_logs_event_key_uniq ON waf_logs (event_key);
