-- Traffic history in the platform database, for every traffic graph.
--
-- The metrics store keeps 30 days, runs as one pod and is not backed up, so
-- beyond 30 days only a tenant's billed egress had any history, and losing
-- the store would lose a month of everything else. A collector now writes each
-- graph's series here hourly; the daily reaper folds hours older than 30 days
-- into days, days older than a year into months, and drops months older than
-- five years. The same reaper now folds usage_metrics days into months instead
-- of deleting them at one year.

-- Monthly rollup rows. ADD VALUE commits on its own; nothing below uses it.
ALTER TYPE usage_resolution ADD VALUE IF NOT EXISTS 'monthly';

CREATE TABLE IF NOT EXISTS traffic_rollup_series (
  id bigserial PRIMARY KEY,
  scope varchar(16) NOT NULL,
  metric varchar(16) NOT NULL,
  series_key varchar(512) NOT NULL,
  direction varchar(3) NOT NULL,
  subject varchar(512),
  namespace varchar(63),
  ref varchar(512),
  name varchar(512) NOT NULL,
  kind varchar(16) NOT NULL,
  grp varchar(16),
  last_seen_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS traffic_rollup_series_uniq
  ON traffic_rollup_series (scope, metric, series_key);

-- value: bytes or requests in the bucket; for latency the mean in ms, with
-- weight = the requests it averages. No row in a measured bucket = nothing moved.
CREATE TABLE IF NOT EXISTS traffic_rollup (
  series_id bigint NOT NULL REFERENCES traffic_rollup_series (id) ON DELETE CASCADE,
  resolution usage_resolution NOT NULL,
  bucket timestamp NOT NULL,
  value double precision NOT NULL,
  weight double precision,
  PRIMARY KEY (series_id, resolution, bucket)
);
CREATE INDEX IF NOT EXISTS traffic_rollup_series_bucket_idx ON traffic_rollup (series_id, bucket);
CREATE INDEX IF NOT EXISTS traffic_rollup_bucket_idx ON traffic_rollup (resolution, bucket);

-- Buckets the collector measured, per view and direction (and per tenant for
-- pod views); a bucket not listed was never measured — a gap, not a zero.
CREATE TABLE IF NOT EXISTS traffic_rollup_coverage (
  scope varchar(16) NOT NULL,
  metric varchar(16) NOT NULL,
  direction varchar(3) NOT NULL,
  namespace varchar(63) NOT NULL DEFAULT '',
  resolution usage_resolution NOT NULL,
  bucket timestamp NOT NULL,
  PRIMARY KEY (scope, metric, direction, namespace, resolution, bucket)
);
