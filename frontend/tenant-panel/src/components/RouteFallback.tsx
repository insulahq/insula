/**
 * Placeholder shown while a lazily-loaded route chunk is fetched.
 *
 * Routes are code-split (App.tsx, React.lazy) for a reason that is not
 * primarily about bundle size: every page used to be a static import, so every
 * page's markup — including the password inputs on Login, AdminUsers, OidcPage,
 * RemoteStorageTargetsPage and the rest — shipped in the single entry chunk
 * that loads on EVERY page view. Password managers detect those fields and pop
 * up their autofill prompt on each navigation, even for an operator who is
 * already signed in. Splitting the routes is what keeps a password input out of
 * the bytes a page that has no password field actually loads.
 *
 * Deliberately minimal: a full skeleton here would flash on fast connections,
 * where these chunks resolve in a few milliseconds from the same origin.
 */
export default function RouteFallback() {
  return (
    <div
      className="flex min-h-[40vh] w-full items-center justify-center"
      role="status"
      aria-live="polite"
      data-testid="route-fallback"
    >
      <span className="sr-only">Loading…</span>
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-blue-600 dark:border-gray-700 dark:border-t-blue-400"
        aria-hidden="true"
      />
    </div>
  );
}
