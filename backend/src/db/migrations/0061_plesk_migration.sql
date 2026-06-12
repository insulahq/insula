-- R1 PR 1: Plesk migration — source registry + discovery (read-only).
--
-- A `plesk_source` is an operator-registered Plesk server we migrate
-- FROM (agentless: SSH only). The private key is encrypted at rest with
-- PLATFORM_ENCRYPTION_KEY (same scheme as smtp_relay / imapsync creds).
-- A `plesk_discovery` is one read-only inventory run against a source;
-- `inventory` holds the structured result (subscriptions/domains/dbs/
-- mailboxes/cron) the Migrations UI renders. Provisioning + sync land
-- in later PRs (plesk_migration_jobs).

CREATE TABLE IF NOT EXISTS plesk_sources (
  id                 varchar(36) PRIMARY KEY,
  name               varchar(255) NOT NULL,
  hostname           varchar(255) NOT NULL,
  ssh_port           integer NOT NULL DEFAULT 22,
  ssh_user           varchar(64) NOT NULL DEFAULT 'root',
  -- iv:tag:ciphertext (AES-256-GCM via oidc/crypto.ts) of the private key.
  ssh_key_encrypted  text NOT NULL,
  -- Filled by the first successful discovery.
  plesk_version      varchar(64),
  -- Password storage mode observed at discovery: 'sym' (reversible,
  -- plaintext extractable) | 'crypt' (hashed) | 'mixed' | null.
  password_storage   varchar(16),
  last_discovered_at timestamptz,
  status             varchar(24) NOT NULL DEFAULT 'registered',
  created_by         varchar(36),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plesk_discoveries (
  id           varchar(36) PRIMARY KEY,
  source_id    varchar(36) NOT NULL REFERENCES plesk_sources(id) ON DELETE CASCADE,
  status       varchar(16) NOT NULL DEFAULT 'pending',  -- pending|running|completed|failed
  started_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  inventory    jsonb,
  error        text,
  log_tail     text
);

CREATE INDEX IF NOT EXISTS plesk_discoveries_source_idx
  ON plesk_discoveries (source_id, started_at DESC);
