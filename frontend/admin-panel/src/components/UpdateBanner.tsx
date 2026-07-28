import { useState } from 'react';
import { RefreshCw, X, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePlatformVersion } from '@/hooks/use-platform-updates';
import { useAuth } from '@/hooks/use-auth';

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
            Platform update available: <strong>{version.latestVersion}</strong>{' '}
            (current: {version.currentVersion})
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Route to the real upgrade flow (pre-flight → interruption preview →
              confirm → live progress + a re-openable Tasks entry). The old inline
              "Update Now" trigger was a no-op on the pull model — removed
              2026-07-28. Apply is super_admin-only (backend-enforced), so only
              they get the action button. */}
          {isSuperAdmin ? (
            <Link
              to="/platform/upgrades"
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
