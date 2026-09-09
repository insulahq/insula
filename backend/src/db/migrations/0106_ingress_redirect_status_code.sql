-- Selectable redirect status code for operator-configured URL redirects.
--
-- `annotation-sync.ts` previously hardcoded `permanent: true` on the
-- redirectRegex middleware, so every configured redirect emitted a 301.
-- Operators asked to choose, with 302 as the default for new routes.
--
-- WHY THE BACKFILL: a bare `DEFAULT 302` would silently move every EXISTING
-- redirect from 301 to 302 on the next reconcile. A 301 already sitting in
-- browser and CDN caches is not something to change as a side effect of
-- shipping a picker, so existing rows are pinned to the 301 they are already
-- serving. Only rows created from here on get the new 302 default. An
-- operator who wants an existing route on 302 can now say so explicitly.
--
-- The column is NOT NULL with a default, so it binds no existing writer:
-- every INSERT that omits it (and they all do today) still succeeds.
ALTER TABLE ingress_routes
  ADD COLUMN IF NOT EXISTS redirect_status_code SMALLINT NOT NULL DEFAULT 302;

-- Preserve the behaviour every already-configured redirect is serving today.
UPDATE ingress_routes
   SET redirect_status_code = 301
 WHERE redirect_url IS NOT NULL;

-- Only the two codes the UI offers are valid. Anything else would silently
-- degrade to `permanent: false` (302) in the Traefik middleware builder.
ALTER TABLE ingress_routes
  DROP CONSTRAINT IF EXISTS ingress_routes_redirect_status_code_check;
ALTER TABLE ingress_routes
  ADD CONSTRAINT ingress_routes_redirect_status_code_check
  CHECK (redirect_status_code IN (301, 302));
