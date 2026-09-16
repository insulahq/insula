import { AlertTriangle } from 'lucide-react';
import { summariseIssues, type TenantIssue } from '@/hooks/use-tenant-issues';

/**
 * "3 issues" in the tenants-table status column.
 *
 * Renders nothing for a healthy tenant — a badge that is always present stops
 * being a signal. Yellow for warnings, red when any issue is critical, so the
 * row that needs attention reads at a glance without opening anything.
 */
export default function TenantIssuesChip({ issues }: { readonly issues: readonly TenantIssue[] | undefined }) {
  const { count, severity } = summariseIssues(issues);
  if (count === 0) return null;

  const critical = severity === 'critical';
  const tone = critical
    ? 'bg-red-100 text-red-800 ring-red-600/20 dark:bg-red-900/40 dark:text-red-200 dark:ring-red-400/30'
    : 'bg-amber-100 text-amber-800 ring-amber-600/20 dark:bg-amber-900/40 dark:text-amber-200 dark:ring-amber-400/30';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
      title={issues?.map((i) => `${i.objectLabel}: ${i.detail}`).join('\n')}
      data-testid="tenant-issues-chip"
    >
      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
      {count} {count === 1 ? 'issue' : 'issues'}
    </span>
  );
}
