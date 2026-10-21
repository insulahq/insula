-- admin.node_rebooting: name the notice for what it reports.
--
-- It is sent when the kubelet reports a graceful shutdown. The platform cannot
-- know whether the server will come back until it does, and an operator who
-- shut a server down was told it was "rebooting". The templates are refreshed
-- by the seed loader; the category row is not (the seeder never overwrites an
-- existing row), so its display name and description are brought up to date
-- here. The id stays: preferences and mutes are stored against it.
--
-- Touches ONLY the exact first-seed text: an operator who renamed it keeps
-- their name, and a fresh install (no row yet) is a no-op — the seeder inserts
-- the new text after migrations run.
UPDATE "notification_categories"
   SET "display_name" = 'Node shutting down',
       "description" = 'A cluster node reported a graceful shutdown (it may be a reboot — that is only known once it is back). A node that goes down without one is reported as down instead. On a single-node cluster the control plane goes down with it, so this cannot always be sent — the startup notification reports the restart either way.',
       "updated_at" = now()
 WHERE "id" = 'admin.node_rebooting'
   AND "display_name" = 'Node rebooting';
