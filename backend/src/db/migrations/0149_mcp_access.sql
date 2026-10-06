-- AI agents (MCP): OAuth clients (dynamic registration), pending authorizations
-- + authorization codes, and bearer tokens (OAuth 8 h + personal access tokens).
-- Secrets (codes, tokens) are stored as SHA-256 hashes only. Idempotent.

CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
  "id" varchar(64) PRIMARY KEY,
  "name" varchar(200) NOT NULL,
  "redirect_uris" text[] NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "mcp_oauth_requests" (
  "id" varchar(64) PRIMARY KEY,
  "client_id" varchar(64) NOT NULL REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE,
  "redirect_uri" text NOT NULL,
  "state" text,
  "code_challenge" varchar(128) NOT NULL,
  "resource" text NOT NULL,
  "requested_scopes" text[] NOT NULL,
  "user_id" varchar(36) REFERENCES "users"("id") ON DELETE CASCADE,
  "granted_scopes" text[],
  "code_hash" varchar(64),
  "code_used_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_requests_code_hash_idx" ON "mcp_oauth_requests" ("code_hash");

CREATE TABLE IF NOT EXISTS "mcp_tokens" (
  "id" varchar(36) PRIMARY KEY,
  "kind" varchar(10) NOT NULL CHECK ("kind" IN ('pat', 'oauth')),
  "token_hash" varchar(64) NOT NULL,
  "prefix" varchar(24) NOT NULL,
  "user_id" varchar(36) NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "client_id" varchar(64) REFERENCES "mcp_oauth_clients"("id") ON DELETE CASCADE,
  "name" varchar(200) NOT NULL,
  "scopes" text[] NOT NULL,
  "resource" text,
  "expires_at" timestamptz,
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_tokens_token_hash_idx" ON "mcp_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "mcp_tokens_user_idx" ON "mcp_tokens" ("user_id");
