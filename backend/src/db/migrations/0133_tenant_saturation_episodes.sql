-- Per-tenant resource saturation: an EPISODE, not an hourly re-announcement.
--
-- What was wrong
-- --------------
-- `evaluateTenantSaturation()` ran on every metrics cycle and deduped with a
-- key that embedded the current hour (`sat:<tenant>:<resource>:<level>:<hour>`).
-- The metrics scheduler ticks once an hour, so the bucket width and the tick
-- period were identical: every cycle minted a key that had never been seen and
-- nothing was ever deduplicated. The comment above it read "re-fires at most
-- once per hour" — written as a CEILING against a fast evaluation loop. With a
-- one-hour loop the ceiling is also the floor, and a sustained condition
-- announced itself to both audiences on both channels every hour without end.
--
-- There was also no all-clear. Dropping back under the threshold simply made
-- the messages stop, which is indistinguishable from the alerting breaking.
--
-- A dedupe key must therefore be keyed on the IDENTITY of the thing being
-- announced, never on a wall-clock bucket whose width can coincide with the
-- caller's period.
--
-- The shape used here
-- -------------------
-- One row per (tenant, resource) — `level` is a COLUMN, not part of the key,
-- so warning→critical is a transition inside one episode rather than a second
-- everlasting row that can never clear. Modelled on `mailbox_quota_events`
-- (claim via ON CONFLICT, hysteresis, GC of cleared rows) and on
-- `node_health_state` (severity as a column, `last_notified_at` throttle).
--
-- `notify_count` drives a backoff ladder — 1h, then 6h, then daily — so a
-- sustained problem still nags, but at a cadence a human can live with, and a
-- fast-filling disk is not silent for a whole day after its first alert.
--
-- Every write is a single guarded statement. The metrics scheduler runs on
-- EVERY api replica with no lease (see app.ts), and until now the hour bucket
-- was what accidentally kept HA mode from double-sending. The row is now that
-- interlock: each claim re-checks the state it decided on, so exactly one
-- replica wins and the losers send nothing.

CREATE TABLE IF NOT EXISTS tenant_saturation_events (
  tenant_id        varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource         varchar(16) NOT NULL,
  level            varchar(16) NOT NULL,
  used_pct         integer     NOT NULL,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz NOT NULL DEFAULT now(),
  notify_count     integer     NOT NULL DEFAULT 1,
  cleared_at       timestamptz,
  PRIMARY KEY (tenant_id, resource)
);

-- The evaluator reads open episodes only; cleared rows are a short audit tail.
CREATE INDEX IF NOT EXISTS tenant_saturation_events_open_idx
  ON tenant_saturation_events (tenant_id)
  WHERE cleared_at IS NULL;
