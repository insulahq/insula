-- M12.3 — Rename email_dkim_keys to email_dkim_keys_legacy.
--
-- The platform no longer manages DKIM keys. Stalwart 0.16 owns DKIM
-- key generation and rotation natively. DKIM status is now read from
-- Stalwart's dnsZoneFile via JMAP (see jmap-status.ts).
--
-- Renaming (not dropping) surfaces any lingering code references at
-- compile time. The hard drop happens in migration 0075 (M13).
--
-- This migration is safe to apply while the service is running:
-- no code path reads or writes email_dkim_keys after M12 ships
-- (the import was removed from app.ts and all service/routes files
-- are deleted in this commit).

ALTER TABLE email_dkim_keys RENAME TO email_dkim_keys_legacy;
