-- A tenant route's WAF gains a third setting, "Detection only": every request
-- is checked and every rule match logged, but nothing is blocked — a sustained
-- dry run before enforcing.
--
-- ingress_routes.waf_detection_only: 1 = detection only, read only while
-- waf_enabled = 1 (off stays off). Kept beside waf_enabled rather than turning
-- it into a mode, so everything that asks "is the WAF on for this route" keeps
-- its answer; the route attaches modsecurity-crs-detect instead of
-- modsecurity-crs.
--
-- waf_logs.detection_only: the event was logged on a route in detection-only
-- mode, so the request was NOT blocked. The scraper reads it from the audit
-- record (the plugin's X-Insula-Waf-Mode: detect). Auto-ban and the "blocked"
-- counts leave these rows out.
--
-- Constant defaults: both ADD COLUMNs are metadata-only, whatever the row count.
ALTER TABLE ingress_routes
  ADD COLUMN IF NOT EXISTS waf_detection_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE waf_logs
  ADD COLUMN IF NOT EXISTS detection_only BOOLEAN NOT NULL DEFAULT FALSE;
