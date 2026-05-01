-- Migration 0067: widen backup_jobs.id (and FK) to fit `bkp-<uuid>` (40 chars).
--
-- 0066 sized them at varchar(36) — the canonical UUID width — but the
-- orchestrator (per ADR-032 / BACKUP_COMPONENT_MODEL.md) prefixes
-- `bkp-` to bundle ids so operators can spot them in S3 listings and
-- distinguish from snapshot ids. That makes the id 40 chars, which
-- 0066 truncates and Postgres rejects with `value too long for
-- character varying(36)`.
--
-- Picking 64 here gives headroom for future prefixes (e.g. `dr-`,
-- `gdpr-`) without another migration. The FK in backup_components
-- must match the parent column width.

ALTER TABLE backup_jobs       ALTER COLUMN id            TYPE VARCHAR(64);
ALTER TABLE backup_components ALTER COLUMN backup_job_id TYPE VARCHAR(64);
