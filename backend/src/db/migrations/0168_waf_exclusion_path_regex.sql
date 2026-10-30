-- Path-scoped WAF rule exclusions + the text_plain_as_json scope.
--
-- path_regex narrows an exclusion to requests whose path (REQUEST_FILENAME,
-- no query string) matches it; NULL keeps today's meaning, every path on the
-- host. It is interpolated into a SecRule string exactly like hostname_regex,
-- so it gets the same last-resort checks: no double-quote (would close the
-- @rx string and let the rest of the line become rule text), no CR/LF, no
-- trailing backslash (escapes the closing quote and crash-loops modsec-crs,
-- a cluster-wide WAF outage). It must also start with `^/` — the API refuses
-- anything else, and an unanchored path would cover more than was meant.
--
-- text_plain_as_json accepts a text/plain body and parses it as JSON instead
-- of dropping rule 920420, so the body stays inspected. It means nothing for
-- any other rule, hence the second CHECK.
--
-- Both new CHECKs are NOT VALID, like 0156's: Postgres then skips the scan of
-- existing rows (none can violate them — path_regex is new and NULL, and no row
-- has the new scope) while every INSERT and UPDATE is still checked.
--
-- The partial unique index now includes the path: one rule on one host may
-- be excluded on several paths, or host-wide and on a path. The existing rows
-- all have path_regex NULL and were unique on (rule, host, scope), so the new
-- index builds over them.
--
-- Replay-safe (IF [NOT] EXISTS / DROP-then-ADD) for the non-transactional runner.
ALTER TABLE waf_rule_exclusions ADD COLUMN IF NOT EXISTS path_regex varchar(255);

ALTER TABLE waf_rule_exclusions DROP CONSTRAINT IF EXISTS waf_rule_exclusions_path_regex_safe;
ALTER TABLE waf_rule_exclusions ADD CONSTRAINT waf_rule_exclusions_path_regex_safe
  CHECK (
    path_regex IS NULL OR (
      position('"' in path_regex) = 0
      AND position(E'\n' in path_regex) = 0
      AND position(E'\r' in path_regex) = 0
      AND right(path_regex, 1) <> '\'
      AND left(path_regex, 2) = '^/'
    )
  ) NOT VALID;

ALTER TABLE waf_rule_exclusions DROP CONSTRAINT IF EXISTS waf_rule_exclusions_scope_enum;
ALTER TABLE waf_rule_exclusions ADD CONSTRAINT waf_rule_exclusions_scope_enum
  CHECK (scope IN (
    'args',
    'args_names_only',
    'full_disable',
    'text_plain_as_json'
  )) NOT VALID;

ALTER TABLE waf_rule_exclusions DROP CONSTRAINT IF EXISTS waf_rule_exclusions_text_plain_as_json_rule;
ALTER TABLE waf_rule_exclusions ADD CONSTRAINT waf_rule_exclusions_text_plain_as_json_rule
  CHECK (scope <> 'text_plain_as_json' OR rule_id = '920420') NOT VALID;

DROP INDEX IF EXISTS waf_rule_exclusions_unique_enabled;
CREATE UNIQUE INDEX IF NOT EXISTS waf_rule_exclusions_unique_enabled
  ON waf_rule_exclusions (rule_id, hostname_regex, scope, (COALESCE(path_regex, '')))
  WHERE disabled = false;
