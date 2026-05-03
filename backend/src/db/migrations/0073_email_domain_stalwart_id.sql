-- Migration 0073: add stalwart_domain_id to email_domains table.
-- Stalwart 0.16 owns each mail domain as a Principal in its own JMAP
-- directory. The platform mirrors domain rows in email_domains for fast
-- listing. This column tracks the Stalwart domain-principal ID so DNS-sync
-- can call getDomainDnsZoneFile(id) without a name lookup each cycle.
-- Nullable: legacy rows have no ID; principals-sync backfills on next cycle.

ALTER TABLE email_domains
  ADD COLUMN IF NOT EXISTS stalwart_domain_id TEXT;

CREATE INDEX IF NOT EXISTS email_domains_stalwart_domain_idx
  ON email_domains (stalwart_domain_id)
  WHERE stalwart_domain_id IS NOT NULL;
