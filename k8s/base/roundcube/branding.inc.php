<?php
/*
 * Platform branding for Roundcube.
 *
 * The Roundcube docker entrypoint loads any *.inc.php in
 * /var/roundcube/config/ alongside the main config — see the
 * existing jwt_auth.inc.php pattern.
 *
 * What this file does:
 *   1. Sets product_name → drives browser tab title + login page
 *      title bar.
 *   2. Points skin_logo at our mounted SVG so the elastic skin's
 *      logo slot renders our wordmark.
 *   3. Registers an html_head hook that injects a <link> to
 *      branding.css on every Roundcube page (login + post-login),
 *      so the CSS variable overrides reach every screen without
 *      needing to fork the elastic skin.
 *
 * Mount layout (configured in deployment.yaml):
 *   /var/www/html/branding/branding.css
 *   /var/www/html/branding/logo.svg
 *
 * Both paths are served by Apache as /branding/* — same origin as
 * Roundcube itself, so no CORS or CSP issues.
 */

$config['product_name'] = 'K8s Hosting Platform Webmail';

// skin_logo accepts a string OR a state→url map. The state '*' covers
// every screen that doesn't have a more specific entry.
//   '*'     — default skin logo (top bar after login)
//   'login' — login screen logo
//   '[favicon]' — browser tab icon
$config['skin_logo'] = [
  '*'         => '/branding/logo.svg',
  'login'     => '/branding/logo.svg',
  '[favicon]' => '/branding/logo.svg',
];

// Inject branding.css into <head> on every page render. Using the
// html_head hook is the supported extension point for adding
// stylesheets/scripts without forking the skin. The hook fires
// during template rendering for both the login page and the post-
// login UI.
//
// Late binding: register the hook only if the rcmail singleton is
// already up. Roundcube includes this file early (in rcube_config
// merge) and again in the request lifecycle — guard against double
// registration.
if (class_exists('rcmail') && method_exists('rcmail', 'get_instance')) {
  $rcmail_for_branding = rcmail::get_instance();
  if ($rcmail_for_branding && method_exists($rcmail_for_branding, 'add_hook')) {
    static $branding_hook_registered = false;
    if (!$branding_hook_registered) {
      $branding_hook_registered = true;
      $rcmail_for_branding->add_hook('html_head', function ($args) {
        $link = '<link rel="stylesheet" href="/branding/branding.css">';
        $args['content'] = (isset($args['content']) ? $args['content'] : '') . $link;
        return $args;
      });
    }
  }
}
