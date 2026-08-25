-- 0087_ntfy_notification_channel.sql
--
-- ntfy push-notification channel (self-hosted-friendly).
--
-- WHY: operators want platform notifications on their phones without
-- running a mail client — ntfy (ntfy.sh or self-hosted) is the
-- lightest way there. A new 'ntfy' channel joins in_app/email:
-- providers carry the server URL + topic + optional auth (private
-- topics via access token or user/password), categories can opt into
-- the channel, and the dispatcher publishes ONE message per event
-- (topic broadcast — not per recipient).
--
-- PG12+ allows ALTER TYPE ... ADD VALUE inside a transaction as long
-- as the new value is not USED before commit — this file only adds.

ALTER TYPE channel_id_enum ADD VALUE IF NOT EXISTS 'ntfy';
ALTER TYPE notification_provider_type ADD VALUE IF NOT EXISTS 'ntfy';

ALTER TABLE notification_providers
  ADD COLUMN IF NOT EXISTS ntfy_server_url varchar(500),
  ADD COLUMN IF NOT EXISTS ntfy_topic varchar(64),
  ADD COLUMN IF NOT EXISTS ntfy_auth_method varchar(16),
  ADD COLUMN IF NOT EXISTS ntfy_token_encrypted varchar(500);
