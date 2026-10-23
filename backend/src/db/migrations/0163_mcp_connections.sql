-- AI agents (MCP): an approved agent becomes a CONNECTION, and tenants can
-- connect agents of their own.
--
-- mcp_connections: one row per approval on the consent page — who approved it,
-- for which panel ('admin' or 'tenant'), which client, which scopes. The agent
-- holds a 1-hour access token (mcp_tokens, kind 'oauth', connection_id set) and
-- a refresh token whose hash lives here, replaced on every refresh. The
-- connection itself ends at expires_at (8 hours after approval) or when it is
-- revoked; every token issued under it ends with it (resolve checks the row,
-- ON DELETE CASCADE removes them).
--
-- previous_refresh_hash: the refresh token this one replaced. Presenting it
-- again means two holders share the connection, so the connection is revoked
-- (refresh-token reuse detection).
--
-- The 8-hour OAuth tokens issued before connections existed have no row to
-- show or revoke them from, so they are removed: those agents sign in again.
-- Personal access tokens (kind 'pat') are untouched. Idempotent.

CREATE TABLE IF NOT EXISTS "mcp_connections" (
  "id" varchar(36) PRIMARY KEY,
  "user_id" varchar(36) NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "tenant_id" varchar(36) REFERENCES "tenants"("id") ON DELETE CASCADE,
  "client_id" varchar(64) NOT NULL REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE,
  "audience" varchar(10) NOT NULL CHECK ("audience" IN ('admin', 'tenant')),
  "name" varchar(200) NOT NULL,
  "scopes" text[] NOT NULL,
  "resource" text NOT NULL,
  "refresh_token_hash" varchar(64) NOT NULL,
  "previous_refresh_hash" varchar(64),
  "expires_at" timestamptz NOT NULL,
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_connections_refresh_hash_idx" ON "mcp_connections" ("refresh_token_hash");
CREATE INDEX IF NOT EXISTS "mcp_connections_previous_refresh_hash_idx" ON "mcp_connections" ("previous_refresh_hash");
CREATE INDEX IF NOT EXISTS "mcp_connections_user_idx" ON "mcp_connections" ("user_id");
CREATE INDEX IF NOT EXISTS "mcp_connections_tenant_idx" ON "mcp_connections" ("tenant_id");

ALTER TABLE "mcp_tokens"
  ADD COLUMN IF NOT EXISTS "connection_id" varchar(36) REFERENCES "mcp_connections"("id") ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS "mcp_tokens_connection_idx" ON "mcp_tokens" ("connection_id");

DELETE FROM "mcp_tokens" WHERE "kind" = 'oauth' AND "connection_id" IS NULL;
