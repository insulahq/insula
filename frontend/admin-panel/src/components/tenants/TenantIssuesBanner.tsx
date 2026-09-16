import { AlertTriangle, ArrowRight } from 'lucide-react';
import { summariseIssues, type TenantIssue } from '@/hooks/use-tenant-issues';

function age(since: string | null): string | null {
  if (!since) return null;
  const ms = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Every open issue for one tenant, at the top of its detail page.
 *
 * Each line names the object, the value and how long it has been true, and
 * links to the tab that fixes it — the issue belongs on the surface that
 * resolves it, not on a page about the category of problem.
 *
 * Renders nothing when the tenant is healthy.
 */
export default function TenantIssuesBanner({
  issues,
  onNavigate,
}: {
  readonly issues: readonly TenantIssue[] | undefined;
  readonly onNavigate?: (actionPath: string) => void;
}) {
  const { count, severity } = summariseIssues(issues);
  if (count === 0 || !issues) return null;

  const critical = severity === 'critical';
  const shell = critical
    ? 'border-red-300 bg-red-50 dark:border-red-500/40 dark:bg-red-950/40'
    : 'border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/40';
  const head = critical
    ? 'text-red-900 dark:text-red-200'
    : 'text-amber-900 dark:text-amber-200';

  return (
    <div className={`mb-4 rounded-lg border p-4 ${shell}`} data-testid="tenant-issues-banner">
      <div className={`mb-2 flex items-center gap-2 text-sm font-semibold ${head}`}>
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        {count} open {count === 1 ? 'issue' : 'issues'}
      </div>
      <ul className="space-y-1.5">
        {issues.map((issue) => {
          const since = age(issue.since);
          return (
            <li
              key={`${issue.kind}:${issue.objectLabel}`}
              className="flex flex-wrap items-center gap-x-2 text-sm text-gray-800 dark:text-gray-200"
              data-testid={`tenant-issue-${issue.kind}`}
            >
              <span className="font-medium">{issue.objectLabel}</span>
              <span className="text-gray-600 dark:text-gray-400">{issue.detail}</span>
              {since && <span className="text-xs text-gray-500 dark:text-gray-500">· {since}</span>}
              {onNavigate && (
                <button
                  type="button"
                  onClick={() => onNavigate(issue.actionPath)}
                  className="inline-flex items-center gap-0.5 text-xs font-medium text-blue-700 underline-offset-2 hover:underline dark:text-blue-300"
                >
                  Fix
                  <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
