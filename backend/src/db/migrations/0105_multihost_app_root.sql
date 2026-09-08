-- Multi-host isolation: separate the PHP sandbox root from the served folder.
--
-- `site_folder` alone conflated two different things. It named the document
-- root, and — because the pod mounts the tenant PVC ROOT at sites_root — it
-- placed no bound at all on what the site's PHP could reach. Every vhost in a
-- multi-host pod could read and write the whole tenant volume: a sibling
-- site's config.php (database credentials), another deployment's data dir.
--
--  ingress_routes.app_root — the APPLICATION root, relative to the tenant PVC
--    root. It is the sandbox boundary: the generated vhost sets PHP's
--    open_basedir to this path, so the site's PHP cannot escape it.
--
--  ingress_routes.site_folder — unchanged meaning: the DOCUMENT root, what the
--    web server serves. It must equal app_root or sit inside it.
--
-- The two differ for apps with a public/ entry point (Nextcloud, Laravel,
-- Symfony): document root `myapp/public`, app root `myapp`, so the app can
-- still reach `myapp/data` while the web serves only `myapp/public`. Where
-- they are equal — the common case — behaviour is what it always was, only
-- sandboxed.

ALTER TABLE ingress_routes
  ADD COLUMN IF NOT EXISTS app_root varchar(500);

-- Existing rows served their site_folder with no sandbox. Backfilling
-- app_root = site_folder preserves exactly what they serve and adds the
-- boundary at the same place, so no route changes behaviour on upgrade.
UPDATE ingress_routes
  SET app_root = site_folder
  WHERE site_folder IS NOT NULL AND app_root IS NULL;

-- Same rule as site_folder: meaningless without a deployment to resolve it in.
ALTER TABLE ingress_routes
  DROP CONSTRAINT IF EXISTS ingress_routes_app_root_needs_deployment;
ALTER TABLE ingress_routes
  ADD CONSTRAINT ingress_routes_app_root_needs_deployment
  CHECK (app_root IS NULL OR deployment_id IS NOT NULL);

-- A folder is served out of an app root, so one cannot exist without the
-- other, and the document root must be the app root or live inside it.
-- Enforced here as well as in the service because a row that violates it
-- produces a vhost whose open_basedir excludes its own DocumentRoot — every
-- request 500s, and the cause is three layers from the symptom.
ALTER TABLE ingress_routes
  DROP CONSTRAINT IF EXISTS ingress_routes_site_folder_within_app_root;
ALTER TABLE ingress_routes
  ADD CONSTRAINT ingress_routes_site_folder_within_app_root
  CHECK (
    (site_folder IS NULL AND app_root IS NULL)
    OR (
      site_folder IS NOT NULL AND app_root IS NOT NULL
      -- LIKE would treat `_` as a single-character wildcard, and folder names
      -- may contain underscores — so `app_root = 'my_app'` would also accept
      -- `site_folder = 'myXapp/x'`. left(...) is an exact comparison and needs
      -- no escaping.
      AND (
        site_folder = app_root
        OR left(site_folder, length(app_root) + 1) = app_root || '/'
      )
    )
  );
