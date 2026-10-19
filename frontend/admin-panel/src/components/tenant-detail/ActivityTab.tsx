/**
 * Tenant → Activity: everything recorded against this tenant, newest first,
 * named in words — with the request underneath for whoever needs it.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuditLogs, type AuditLogEntry } from '@/hooks/use-audit-logs';
import { Card } from './ui';
import { describeAuditEntry } from './audit-describe';

const PAGE = 50;

export default function ActivityTab({ tenantId }: { readonly tenantId: string }) {
  // Pages already seen, and the cursor of the one being read.
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  return (
    <Card title="Activity" bodyClassName="" testId="tenant-activity">
      <ol>
        {cursors.map((c, i) => (
          <ActivityPage
            key={c ?? 'first'}
            tenantId={tenantId}
            cursor={c}
            last={i === cursors.length - 1}
            onMore={(next) => setCursors((prev) => [...prev, next])}
          />
        ))}
      </ol>
    </Card>
  );
}

function ActivityPage({ tenantId, cursor, last, onMore }: {
  readonly tenantId: string;
  readonly cursor: string | undefined;
  readonly last: boolean;
  readonly onMore: (cursor: string) => void;
}) {
  const { data, isLoading, error } = useAuditLogs({ tenant_id: tenantId, limit: PAGE, cursor });
  if (isLoading) {
    return <li className="flex items-center gap-2 px-5 py-4 text-sm text-gray-500"><Loader2 size={14} className="animate-spin" /> Loading…</li>;
  }
  if (error) {
    return <li className="px-5 py-4 text-sm text-red-600 dark:text-red-400">Could not load the activity log.</li>;
  }
  const entries = data?.data ?? [];
  if (entries.length === 0 && !cursor) {
    return <li className="px-5 py-4 text-sm text-gray-600 dark:text-gray-400">No recorded activity yet.</li>;
  }
  return (
    <>
      {entries.map((e) => <ActivityRow key={e.id} entry={e} />)}
      {last && data?.pagination.has_more && data.pagination.cursor && (
        <li className="px-5 py-3">
          <button
            type="button"
            onClick={() => onMore(data.pagination.cursor!)}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            data-testid="activity-load-more"
          >
            Show older activity
          </button>
        </li>
      )}
    </>
  );
}

function ActivityRow({ entry }: { readonly entry: AuditLogEntry }) {
  const d = describeAuditEntry(entry);
  const failed = entry.httpStatus != null && entry.httpStatus >= 400;
  return (
    <li className="flex gap-3.5 border-b border-gray-100 px-5 py-3 last:border-0 dark:border-gray-700" data-testid={`activity-${entry.id}`}>
      <span aria-hidden="true" className={`mt-1.5 h-2 w-2 flex-none rounded-full ${failed ? 'bg-red-500' : 'bg-gray-300 dark:bg-gray-600'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 text-[13px]">
          <span className="min-w-0 text-gray-900 dark:text-gray-100">
            {d.what}
            {failed && <span className="text-red-600 dark:text-red-400"> — refused ({entry.httpStatus})</span>}
            <span className="text-gray-500 dark:text-gray-400"> · {d.who}</span>
          </span>
          <span className="whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">{new Date(entry.createdAt).toLocaleString()}</span>
        </div>
        {entry.httpPath && (
          <div className="mt-0.5 truncate font-mono text-[11px] text-gray-500 dark:text-gray-400" title={entry.httpPath}>
            {entry.httpMethod} {entry.httpPath}
          </div>
        )}
      </div>
    </li>
  );
}
