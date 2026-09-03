-- Scoped credentials for GET /api/v1/certs/:domain/download, so an external
-- web server or deploy pipeline can pick up a renewed certificate on its own.
-- Let's Encrypt renews every 90 days; without this the customer has to notice
-- and re-copy the files by hand.
--
-- Deliberately NOT a JWT and deliberately not tied to a user session:
--
--   * It must keep working when the platform is configured for OIDC. The token
--     is an opaque random string checked against this table, so the download
--     route never touches the JWT/OIDC path — an SSO-only deployment can still
--     automate certificate pickup.
--   * It must be revocable instantly. A stateless JWT cannot be; a row can.
--   * It is bound to ONE domain, so a leaked token exposes that domain's
--     certificate and nothing else — no panel access, no other domain.
--
-- Only the sha256 of the token is stored, like refresh_tokens: a database leak
-- does not yield usable credentials. The plaintext is shown once at creation.
--
-- No FK on domain_id: `domains` rows are removed by the tenant cascade, and a
-- token whose domain has gone simply stops resolving (the download route joins
-- through domains and 404s). tenant_id DOES cascade so deleting a tenant takes
-- its tokens with it rather than leaving orphaned credentials behind.
CREATE TABLE IF NOT EXISTS cert_download_tokens (
  id            VARCHAR(36) PRIMARY KEY,
  tenant_id     VARCHAR(36) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain_id     VARCHAR(36) NOT NULL,
  name          VARCHAR(100) NOT NULL,
  token_hash    VARCHAR(64) NOT NULL,
  expires_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_by    VARCHAR(36),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The download route's only lookup is by hash. UNIQUE so a collision surfaces
-- as a constraint error instead of an ambiguous multi-row match.
CREATE UNIQUE INDEX IF NOT EXISTS cert_download_tokens_hash_unique
  ON cert_download_tokens (token_hash);
CREATE INDEX IF NOT EXISTS cert_download_tokens_domain_idx
  ON cert_download_tokens (domain_id);
CREATE INDEX IF NOT EXISTS cert_download_tokens_tenant_idx
  ON cert_download_tokens (tenant_id);
