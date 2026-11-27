-- Daily auto-sync (0193) stays on for the Official Catalog only. A repository
-- an admin added starts with it off: it changes the catalog — and, through
-- automatic upgrades, the deployments made from it — on its own only once
-- someone switches it on. 0193 turned it on for every repository; none of them
-- synced on a timer before 0193, so switching the others off keeps what they did.
UPDATE catalog_repositories SET auto_sync_enabled = false
 WHERE regexp_replace(lower(rtrim(url, '/')), '\.git$', '') <> 'https://github.com/insulahq/application-catalog';

-- Repository fetches now refuse private addresses unless an admin allows them
-- (Applications → Repositories; modules/catalog/service.ts catalogFetchPolicy).
-- An install that already syncs a repository from its own network keeps
-- working: the setting starts on where a repository's host is a private IPv4
-- address, a single-label name or a name under .local/.internal/.lan/
-- .home.arpa/.corp/.intranet. A repository on a public host does not need it.
-- Loopback, cloud metadata and the cluster's own networks are refused either way.
INSERT INTO platform_settings (setting_key, setting_value)
SELECT 'catalog_repos_allow_private_hosts', 'true'
 WHERE EXISTS (
   SELECT 1 FROM (
     SELECT lower(substring(url FROM '^[a-z+]*https?://(?:[^@/]*@)?([^/:?#]+)')) AS host FROM catalog_repositories
   ) h
   WHERE h.host ~ '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)'
      OR h.host ~ '\.(local|internal|lan|home\.arpa|corp|intranet)$'
      OR h.host !~ '\.'
 )
ON CONFLICT (setting_key) DO NOTHING;
