-- Migration 0076: restore-cart pattern (ADR-034)
--
-- One row per cart in restore_jobs; one row per planned operation in
-- restore_items. The cart is the user's mental model — items are
-- added incrementally and executed sequentially.
--
-- Pre-restore snapshot is per-cart (one storage_snapshots row that
-- covers all items). Failure of one item does NOT roll back the
-- earlier ones — operator decides via an explicit roll-back action.

CREATE TYPE restore_job_status AS ENUM ('draft', 'executing', 'paused', 'done', 'failed');
CREATE TYPE restore_item_type AS ENUM (
  'files-paths',
  'mailboxes-by-address',
  'deployments-by-id',
  'domains-by-id',
  'config-tables'
);
CREATE TYPE restore_item_status AS ENUM ('pending', 'applying', 'done', 'failed', 'skipped');

CREATE TABLE restore_jobs (
  id                       VARCHAR(64) PRIMARY KEY,
  client_id                VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  initiator_user_id        VARCHAR(36) REFERENCES users(id) ON DELETE SET NULL,
  status                   restore_job_status NOT NULL DEFAULT 'draft',
  -- Pre-restore snapshot ID; null until the first mutating item runs.
  pre_restore_snapshot_id  VARCHAR(36),
  description              TEXT,
  started_at               TIMESTAMP,
  finished_at              TIMESTAMP,
  last_error               TEXT,
  created_at               TIMESTAMP NOT NULL DEFAULT now(),
  updated_at               TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX restore_jobs_client_idx    ON restore_jobs(client_id);
CREATE INDEX restore_jobs_status_idx    ON restore_jobs(status);
CREATE INDEX restore_jobs_created_idx   ON restore_jobs(created_at);

CREATE TABLE restore_items (
  id                VARCHAR(36) PRIMARY KEY,
  restore_job_id    VARCHAR(64) NOT NULL REFERENCES restore_jobs(id) ON DELETE CASCADE,
  -- Source bundle for this item. Different items in one cart MAY come
  -- from different bundles (mix-and-match restore). FK is loose
  -- (no ON DELETE CASCADE) so deleting a bundle leaves orphan items
  -- visible — the operator sees the broken reference and decides.
  bundle_id         VARCHAR(64) NOT NULL,
  type              restore_item_type NOT NULL,
  -- Type-specific selector — e.g.
  --   files-paths:           {"paths": ["/wp-content", "/wp-config.php"]} or {"paths": ["*"]} for full
  --   mailboxes-by-address:  {"addresses": ["a@x.com"]} or {"all": true}
  --   deployments-by-id:     {"deploymentIds": ["..."]} or {"all": true}
  --   domains-by-id:         {"domainIds": ["..."]} or {"all": true}
  --   config-tables:         {"tables": ["domains","mailboxes"]} or {"all": true}
  selector          JSONB NOT NULL,
  -- Operator-friendly label rendered in the cart UI.
  label             VARCHAR(255),
  -- Sequencing — items execute in ascending order. Inserted as
  -- max(seq)+1 by the cart-add route, never written by the executor.
  seq               INT NOT NULL,
  status            restore_item_status NOT NULL DEFAULT 'pending',
  progress_message  VARCHAR(500),
  size_bytes        BIGINT NOT NULL DEFAULT 0,
  started_at        TIMESTAMP,
  finished_at       TIMESTAMP,
  last_error        TEXT,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX restore_items_job_idx    ON restore_items(restore_job_id);
CREATE INDEX restore_items_status_idx ON restore_items(status);
CREATE UNIQUE INDEX restore_items_seq_unique ON restore_items(restore_job_id, seq);
