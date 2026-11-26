-- Tenant database instances: the platform's administrator login, and the
-- tenant's own administrator account.
--
-- database_admin_state — one row per database instance the platform manages:
-- how the platform reaches its administrator account (db-admin-access.ts:
-- socket, trust, restricted, password, locked, open, unreachable), what the
-- last check changed, and the lockout incident (locked_since / alerted_at) so
-- a lost login is announced once and its recovery once (unreachable_since: the
-- same for an instance that has not answered at all). shaped_at: the last full
-- check — between them a tick only proves the logins still work. hardened_pod:
-- the pod the last hardening pass ran in (a new pod — a restore, a re-point —
-- is hardened again at once). hardened_at: the
-- last pass over what a tenant could have left while it held root
-- (mysql-/pg-/mongo-hardening.ts). MongoDB only: root_secret_cipher is the
-- root password the platform set when it replaced the one the tenant knew
-- (encrypted like the passwords below), kept so a configuration that lost it
-- can be put right; root_rotated_at, when that happened.
--
-- database_admin_accounts — the tenant's administrator account on each
-- instance (tenant-admin.ts): the login the tenant sees in the panel and the
-- SQL console runs as, in place of the platform's root. The password is
-- AES-256-GCM-encrypted with PLATFORM_ENCRYPTION_KEY (oidc/crypto.ts) and only
-- the credentials view decrypts it. ready_at: when the account was first set up
-- in the database — the panel shows the password only from then on.
--
-- Additive: API pods without this change never read or write these tables.
-- Replay-safe (IF NOT EXISTS) for the non-transactional runner.

CREATE TABLE IF NOT EXISTS database_admin_state (
  deployment_id varchar(36) PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  tenant_id varchar(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  engine varchar(16) NOT NULL,
  mode varchar(16) NOT NULL,
  detail text,
  last_changes text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  converted_at timestamptz,
  locked_since timestamptz,
  alerted_at timestamptz,
  hardened_at timestamptz,
  hardened_pod varchar(253),
  shaped_at timestamptz,
  unreachable_since timestamptz,
  root_secret_cipher text,
  root_rotated_at timestamptz
);

CREATE INDEX IF NOT EXISTS database_admin_state_tenant_idx ON database_admin_state (tenant_id);

CREATE TABLE IF NOT EXISTS database_admin_accounts (
  deployment_id varchar(36) PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
  username varchar(64) NOT NULL,
  password_cipher text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  ready_at timestamptz
);
