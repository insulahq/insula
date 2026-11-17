-- WAF: why a request was not blocked, per-route trusted IPs, and an exclusion
-- of every rule on one path.
--
-- waf_logs.pass_reason — ModSecurity's audit record says whether it refused a
-- request (is_interrupted). A request from an address on the platform's
-- CrowdSec allowlist matched rules, was logged, and was NOT refused (the WAF
-- runs those addresses in detection-only mode on every site), yet its rows
-- looked exactly like a block: detection_only is set only for a route in
-- detection-only mode. NULL = blocked, or logged before this column existed.
-- Every "blocked" count now also requires pass_reason IS NULL.
--
-- waf_trusted_ips — addresses a tenant trusts on ONE route: still inspected
-- and logged, never blocked, on that route's hostname only. The value is
-- canonicalised by the API; the CHECK keeps anything that is not address
-- characters out of the rendered SecRule even on a direct write.
--
-- waf_rule_exclusions scope 'all_rules' — no rule id (stored as '0', which no
-- CRS rule has) and a required path: the WAF does not check that path.
--
-- Replay-safe (IF [NOT] EXISTS / DROP-then-ADD) for the non-transactional runner.
-- The CHECKs are NOT VALID like 0156/0168's: no existing row can violate them,
-- and every INSERT and UPDATE is still checked.

ALTER TABLE waf_logs ADD COLUMN IF NOT EXISTS pass_reason varchar(20);
ALTER TABLE waf_logs DROP CONSTRAINT IF EXISTS waf_logs_pass_reason_enum;
ALTER TABLE waf_logs ADD CONSTRAINT waf_logs_pass_reason_enum
  CHECK (pass_reason IS NULL OR pass_reason IN (
    'allowlisted_ip',
    'trusted_ip',
    'below_threshold',
    'not_enforced'
  )) NOT VALID;

-- The tenant's "by source IP" view and the IP filter of the event list.
CREATE INDEX IF NOT EXISTS waf_logs_route_source_created_idx
  ON waf_logs (route_id, source_ip, created_at);

CREATE TABLE IF NOT EXISTS waf_trusted_ips (
  id varchar(36) PRIMARY KEY,
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  route_id varchar(36) NOT NULL REFERENCES ingress_routes(id) ON DELETE CASCADE,
  value varchar(49) NOT NULL,
  note varchar(200),
  created_by varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waf_trusted_ips_value_chars CHECK (value ~ '^[0-9a-f.:]+(/[0-9]{1,3})?$')
);
CREATE UNIQUE INDEX IF NOT EXISTS waf_trusted_ips_route_value_uniq ON waf_trusted_ips (route_id, value);
CREATE INDEX IF NOT EXISTS waf_trusted_ips_tenant_idx ON waf_trusted_ips (tenant_id);

ALTER TABLE waf_rule_exclusions DROP CONSTRAINT IF EXISTS waf_rule_exclusions_scope_enum;
ALTER TABLE waf_rule_exclusions ADD CONSTRAINT waf_rule_exclusions_scope_enum
  CHECK (scope IN (
    'args',
    'args_names_only',
    'full_disable',
    'text_plain_as_json',
    'all_rules'
  )) NOT VALID;

ALTER TABLE waf_rule_exclusions DROP CONSTRAINT IF EXISTS waf_rule_exclusions_all_rules_shape;
ALTER TABLE waf_rule_exclusions ADD CONSTRAINT waf_rule_exclusions_all_rules_shape
  CHECK (
    (scope = 'all_rules') = (rule_id = '0')
    AND (scope <> 'all_rules' OR path_regex IS NOT NULL)
  ) NOT VALID;
