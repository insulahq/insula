import { HardDrive, AlertTriangle, Loader2, Activity, Snowflake } from 'lucide-react';
import { useMailNodeStorage } from '@/hooks/use-mail-node-storage';
import type { MailNodeStorage } from '@insula/api-contracts';

/**
 * Per-mail-node storage cards — replaces the legacy single MailStorageCard.
 *
 * Renders one card per mail-relevant node (active + primary/secondary/
 * tertiary placement slots + standby-labelled nodes), each showing:
 *
 *   - Total       — node ephemeral-storage capacity
 *   - Scheduled   — sum of PVC requests bound to PVs on this node
 *                   (informational; local-path doesn't enforce quotas
 *                   but the number tells the operator how much disk
 *                   they've already reserved)
 *   - Mail data   — bytes actually consumed by mail
 *                     active: live `du` in stalwart pod
 *                     standby: latest standby-replicate report
 *   - Headroom    — total − scheduled, color-coded
 *
 * Backend: GET /admin/mail/storage/per-node
 * Endpoint: backend/src/modules/mail-admin/mail-node-storage.ts
 */
export default function MailNodeStorageCards() {
  const q = useMailNodeStorage();

  if (q.isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading per-node storage…
        </div>
      </div>
    );
  }

  if (q.isError || !q.data) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-5">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" />
          <div className="text-sm text-red-700 dark:text-red-300">
            Could not read per-node mail storage.{' '}
            {q.error instanceof Error ? q.error.message : 'See server logs.'}
          </div>
        </div>
      </div>
    );
  }

  const nodes = q.data.data.nodes;
  if (nodes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-8 text-center">
        <HardDrive size={28} className="mx-auto mb-2 text-gray-400" />
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No mail-relevant nodes configured — set a primary node under
          Placement & migration, or label a standby node with{' '}
          <code className="font-mono">platform.example.test/mail-standby=&quot;true&quot;</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="mail-node-storage-cards">
      {nodes.map((n) => <NodeStorageCard key={n.nodeName} node={n} />)}
    </div>
  );
}

function NodeStorageCard({ node }: { readonly node: MailNodeStorage }) {
  const headroom =
    node.totalBytes != null && node.scheduledBytes != null
      ? Math.max(0, node.totalBytes - node.scheduledBytes)
      : null;
  const headroomPct =
    node.totalBytes != null && headroom != null && node.totalBytes > 0
      ? (headroom / node.totalBytes) * 100
      : null;

  // Headroom band colours — calibrated by % free of total disk:
  //   ≥20%  green (safe)
  //   ≥10%  amber (watch)
  //   else  red (act)
  const headroomCls =
    headroomPct == null
      ? 'text-gray-500'
      : headroomPct >= 20
      ? 'text-emerald-700 dark:text-emerald-300'
      : headroomPct >= 10
      ? 'text-amber-700 dark:text-amber-300'
      : 'text-red-700 dark:text-red-300';

  const ageStr = formatAge(node.mailUsedReportedAt);

  return (
    <div
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-4 space-y-3"
      data-testid={`mail-node-storage-${node.nodeName}`}
    >
      {/* Header — node name + role badges */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {node.isActive ? (
            <Activity
              size={16}
              className="shrink-0 text-emerald-500"
              aria-label="Active mail node"
              role="img"
            />
          ) : node.isStandby ? (
            <Snowflake
              size={16}
              className="shrink-0 text-blue-400"
              aria-label="Standby mail node"
              role="img"
            />
          ) : (
            <HardDrive
              size={16}
              className="shrink-0 text-gray-400"
              aria-label="Assigned mail node"
              role="img"
            />
          )}
          <code className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
            {node.nodeName}
          </code>
        </div>
        <div className="flex flex-wrap gap-1 shrink-0">
          {node.roles.map((r) => (
            <span
              key={r}
              className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${roleClass(r)}`}
            >
              {r}
            </span>
          ))}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <Stat label="Total disk" value={formatBytes(node.totalBytes)} />
        <Stat label="Scheduled (PVC requests)" value={formatBytes(node.scheduledBytes)} />
        <Stat label="Mail data used" value={formatBytes(node.mailUsedBytes)} />
        <Stat
          label="Headroom"
          value={
            headroom != null && headroomPct != null
              ? `${formatBytes(headroom)} (${headroomPct.toFixed(0)}%)`
              : '—'
          }
          valueCls={headroomCls}
        />
      </div>

      {/* Freshness footer (only when we have a mailUsed time) */}
      {ageStr && (
        <div className="text-[11px] text-gray-500 dark:text-gray-400 pt-1 border-t border-gray-100 dark:border-gray-700">
          Mail data measurement: {ageStr}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  valueCls,
}: {
  readonly label: string;
  readonly value: string;
  readonly valueCls?: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className={`font-mono text-sm ${valueCls ?? 'text-gray-900 dark:text-gray-100'}`}>
        {value}
      </div>
    </div>
  );
}

function roleClass(role: string): string {
  switch (role) {
    case 'active':
      return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300';
    case 'primary':
      return 'bg-brand-100 dark:bg-brand-900/30 text-brand-700 dark:text-brand-300';
    case 'secondary':
      return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300';
    case 'tertiary':
      return 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300';
    case 'standby':
      return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300';
    default:
      return 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300';
  }
}

function formatBytes(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function formatAge(iso: string | null): string | null {
  if (!iso) return null;
  const now = Date.now();
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 5) return 'live';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}
