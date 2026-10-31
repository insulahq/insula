-- waf_logs is kept by age now (30 days by default, a platform setting)
-- instead of the newest 50 rows per route. Two queries read a route's rows
-- newest-first: the per-route ceiling (the row at offset 20 000) and the
-- tenant's "would block" summary for a window. Both need the route and the
-- time together; the existing indexes have one or the other.
--
-- IF NOT EXISTS keeps it replay-safe for the non-transactional runner.
CREATE INDEX IF NOT EXISTS waf_logs_route_created_idx ON waf_logs (route_id, created_at);
