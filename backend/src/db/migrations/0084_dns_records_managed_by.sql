-- Mark platform-provisioned DNS records.
--
-- WHY: five modules auto-provision DNS (ingress routes, email domains, DKIM,
-- JMAP autodiscover, apex drift repair). Every one of them called
-- syncRecordToProviders — which writes to the DNS SERVER — without ever
-- inserting a row into dns_records. So the records existed upstream and the
-- platform had no idea they did: they never appeared in the domain's DNS
-- Records list, and the route-deletion cleanup that tries to remove them by
-- name found nothing to remove.
--
-- Reported twice by the operator (ingress-route records, then mail records)
-- before it was recognised as one systemic bug rather than two.
--
-- `managed_by` records WHICH subsystem owns a row, so:
--   * the UI can show platform-managed records and warn before editing one
--   * "refresh ingress route DNS records" can replace exactly the rows it owns
--     instead of matching on (type, name, content), which breaks the moment an
--     ingress IP changes — the very case that action exists for
--   * a user-created record (NULL) is never touched by a reconciler
--
-- NULL = user-created. That is the default precisely so existing rows, which
-- were all user-created by definition, keep their meaning without a backfill.
ALTER TABLE dns_records
  ADD COLUMN IF NOT EXISTS managed_by VARCHAR(32);

-- Reconcilers look records up by (domain, owner) on every pass; without this
-- that is a sequential scan of the whole table per pass per domain.
CREATE INDEX IF NOT EXISTS dns_records_domain_managed_by_idx
  ON dns_records (domain_id, managed_by);

COMMENT ON COLUMN dns_records.managed_by IS
  'Subsystem that provisioned this record (ingress-route, mail, dkim, jmap, apex-drift). NULL = user-created; reconcilers must never modify a NULL row.';
