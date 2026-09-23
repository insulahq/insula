import { useState } from 'react';
import { RefreshCw, X, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePlatformVersion } from '@/hooks/use-platform-updates';
import { useAuth } from '@/hooks/use-auth';
import { formatVersion } from '@/lib/format-version';

export default function UpdateBanner() {
  const [dismissed, setDismissed] = useState(false);
  const { data: versionRes } = usePlatformVersion();
  const { user } = useAuth();

  const version = versionRes?.data;

  if (!version?.updateAvailable || dismissed) {
    return null;
  }

  const isSuperAdmin = user?.role === 'super_admin';

  return (
    <div
      data-testid="update-banner"
      className="mx-4 mt-4 lg:mx-6 lg:mt-6 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 px-4 py-3"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm text-blue-800 dark:text-blue-200">
          <RefreshCw size={16} className="shrink-0" />
          <span>
            {/* `available` — the cosign-VERIFIED version the poller stored — is
                the field `updateAvailable` is computed from, so it has to be
                the field shown. This rendered `latestVersion`, a lazily
                refreshed unverified mirror that the hourly poller never
                writes, and the banner read "update available: 2026.9.30
                (current: 2026.9.30)" while the verified value was 2026.9.31.
                Deciding from one field and captioning from another is how a
                banner ends up contradicting itself. */}
            Platform update available:{' '}
            <strong>{formatVersion(version.available ?? version.latestVersion)}</strong>{' '}
            (current: {formatVersion(version.installed ?? version.currentVersion)})
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Route to the real upgrade flow (pre-flight → interruption preview →
              confirm → live progress + a re-openable Tasks entry). The old inline
              "Update Now" trigger was a no-op on the pull model — removed
              2026-07-28. Apply is super_admin-only (backend-enforced), so only
              they get the action button. */}
          {isSuperAdmin ? (
            /* `?review=1` makes the page open the review modal on arrival
               instead of landing the operator on the Updates page to hunt for
               the same button. The modal needs the page's pre-flight/dry-run
               queries, so it cannot be rendered from the banner itself — the
               query param is the handoff. */
            <Link
              to="/platform/updates?review=1"
              data-testid="update-banner-review"
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
            >
              Review &amp; apply
              <ArrowRight size={14} />
            </Link>
          ) : (
            <Link
              to="/platform/updates"
              data-testid="update-banner-details"
              className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 dark:border-blue-700 px-3 py-1.5 text-sm font-medium text-blue-700 dark:text-blue-200 hover:bg-blue-100 dark:hover:bg-blue-800 transition-colors"
            >
              View details
            </Link>
          )}
          <button
            type="button"
            data-testid="update-banner-dismiss"
            onClick={() => setDismissed(true)}
            className="rounded-md p-1 text-blue-600 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-800 transition-colors"
            aria-label="Dismiss update banner"
          >
            <X size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
