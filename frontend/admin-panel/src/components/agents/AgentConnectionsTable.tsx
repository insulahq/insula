/**
 * Connected AI agents — one row per approval on a consent page, until it ends
 * (8 hours after approval) or someone revokes it. Used for the signed-in
 * user's own agents (User Settings) and for every agent on the platform
 * (Security → AI agents, with who approved it and for which tenant).
 */
import { useState } from 'react';
import { Loader2, Unplug } from 'lucide-react';
import type { McpConnection, McpScope } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { formatRelativeTime } from '@/lib/format-relative-time';
import { useRevokeConnection } from '@/hooks/use-api-tokens';

const btn = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50';

/** "in 3 h 20 min" — how long until a connection ends on its own. */
export function formatEndsIn(iso: string, now: number = Date.now()): string {
  const min = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  if (min < 1) return 'ending now';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `in ${m} min`;
  return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
}

export function ScopeChips({ scopes }: { readonly scopes: readonly McpScope[] }) {
  const tone: Record<McpScope, string> = {
    read: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
    write: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
    delete: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  };
  return (
    <span className="inline-flex gap-1">
      {scopes.map((s) => <span key={s} className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tone[s]}`}>{s}</span>)}
    </span>
  );
}

function ConnectionRow({ connection, showOwner }: { readonly connection: McpConnection; readonly showOwner: boolean }) {
  const revoke = useRevokeConnection();
  const [confirming, setConfirming] = useState(false);
  const error = revoke.error ? extractOperatorError(revoke.error) : null;
  return (
    <tr className="border-t border-gray-100 align-top dark:border-gray-700" data-testid={`agent-connection-row-${connection.id}`}>
      <td className="py-2 pr-3">
        <div className="font-medium text-gray-900 dark:text-gray-100">{connection.clientName}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {connection.audience === 'tenant' ? 'Tenant panel' : 'Admin panel'} · connected {formatRelativeTime(connection.createdAt)}
        </div>
        {error && <div className="mt-2"><ErrorPanel error={error} /></div>}
      </td>
      {showOwner && (
        <td className="py-2 pr-3 text-xs text-gray-700 dark:text-gray-300">
          <div>{connection.user.fullName}</div>
          <div className="text-gray-500 dark:text-gray-400">{connection.user.email}</div>
          {connection.tenant && <div className="mt-0.5 text-gray-500 dark:text-gray-400" data-testid="agent-connection-tenant">{connection.tenant.name}</div>}
        </td>
      )}
      <td className="py-2 pr-3"><ScopeChips scopes={connection.scopes} /></td>
      <td className="hidden py-2 pr-3 text-xs text-gray-600 md:table-cell dark:text-gray-300">
        {connection.lastUsedAt ? formatRelativeTime(connection.lastUsedAt) : '—'}
      </td>
      <td className="py-2 pr-3 text-xs text-gray-600 dark:text-gray-300" title={new Date(connection.expiresAt).toLocaleString()}>
        {formatEndsIn(connection.expiresAt)}
      </td>
      <td className="py-2 text-right">
        {confirming ? (
          <span className="inline-flex gap-1">
            <button type="button" onClick={() => revoke.mutate(connection.id)} disabled={revoke.isPending} className={`${btn} bg-red-600 text-white hover:bg-red-700`} data-testid="agent-connection-revoke-confirm">
              {revoke.isPending ? <Loader2 size={14} className="animate-spin" /> : null} Disconnect
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={`${btn} text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700`}>Keep</button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} className={`${btn} text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20`} data-testid="agent-connection-revoke">
            <Unplug size={14} /> Disconnect
          </button>
        )}
      </td>
    </tr>
  );
}

export default function AgentConnectionsTable({
  connections, showOwner = false, emptyText,
}: {
  readonly connections: readonly McpConnection[];
  /** Show who approved each agent and for which tenant (the platform-wide view). */
  readonly showOwner?: boolean;
  readonly emptyText: string;
}) {
  if (connections.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="agent-connections-empty">{emptyText}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid="agent-connections-table">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <th className="pb-2 pr-3 font-medium">Agent</th>
            {showOwner && <th className="pb-2 pr-3 font-medium">Acts as</th>}
            <th className="pb-2 pr-3 font-medium">Scopes</th>
            <th className="hidden pb-2 pr-3 font-medium md:table-cell">Last active</th>
            <th className="pb-2 pr-3 font-medium">Ends</th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody>{connections.map((c) => <ConnectionRow key={c.id} connection={c} showOwner={showOwner} />)}</tbody>
      </table>
    </div>
  );
}
