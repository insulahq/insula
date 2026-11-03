-- A domain's child rows go with the domain.
--
-- Four tables hold a domain_id with no foreign key: ssl_certificates,
-- protected_directories, hosting_settings and cert_download_tokens. Deleting a
-- domain removes its cert-manager Certificate and Secret, and migration 0020's
-- cascades take dns_records, email_domains and ingress_routes with it — but
-- nothing ever deleted these rows. On production six ssl_certificates rows
-- outlived the six domains they belonged to; the dashboard counted two of them as
-- "Certificates expiring" for a wildcard whose live certificate was healthy,
-- and the other four would have followed as their stale expiry dates came up.
--
-- So: reap the rows whose domain is already gone, then add the missing foreign
-- keys with ON DELETE CASCADE, so every delete path — single, bulk, or one not
-- written yet — takes them along.
--
-- NOT VALID: the runner is not transactional, and an old API pod still serving
-- during the rollout can delete a domain between the DELETE and the ADD. A
-- validating ADD would then abort the boot over a row this file just failed to
-- reap. NOT VALID skips only that check of existing rows; inserts and updates
-- are checked, and the cascade applies to every later delete.
--
-- Replay-safe: DELETE … WHERE NOT EXISTS is a no-op once clean, and each
-- constraint is dropped IF EXISTS before it is added.

DELETE FROM ssl_certificates c
 WHERE NOT EXISTS (SELECT 1 FROM domains d WHERE d.id = c.domain_id);
DELETE FROM protected_directories p
 WHERE NOT EXISTS (SELECT 1 FROM domains d WHERE d.id = p.domain_id);
DELETE FROM hosting_settings h
 WHERE NOT EXISTS (SELECT 1 FROM domains d WHERE d.id = h.domain_id);
DELETE FROM cert_download_tokens t
 WHERE NOT EXISTS (SELECT 1 FROM domains d WHERE d.id = t.domain_id);

ALTER TABLE ssl_certificates DROP CONSTRAINT IF EXISTS ssl_certificates_domain_id_domains_id_fk;
ALTER TABLE ssl_certificates ADD CONSTRAINT ssl_certificates_domain_id_domains_id_fk
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE protected_directories DROP CONSTRAINT IF EXISTS protected_directories_domain_id_domains_id_fk;
ALTER TABLE protected_directories ADD CONSTRAINT protected_directories_domain_id_domains_id_fk
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE hosting_settings DROP CONSTRAINT IF EXISTS hosting_settings_domain_id_domains_id_fk;
ALTER TABLE hosting_settings ADD CONSTRAINT hosting_settings_domain_id_domains_id_fk
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE cert_download_tokens DROP CONSTRAINT IF EXISTS cert_download_tokens_domain_id_domains_id_fk;
ALTER TABLE cert_download_tokens ADD CONSTRAINT cert_download_tokens_domain_id_domains_id_fk
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE NOT VALID;
