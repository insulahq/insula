/**
 * User Settings → AI agents.
 *
 * An AI client (Claude, Cursor, VS Code, …) connects to the tenant panel's MCP
 * address and signs in here; it then acts as the user who approved it, with
 * that user's role, inside this account only. The list shows the user's own
 * agents — or, for a tenant admin, every agent connected to the account — and
 * any of them can be disconnected. The provider can switch tenant agents off.
 */
import { useEffect, useRef, useState } from 'react';
import { Bot, Check, Copy, Loader2, Unplug } from 'lucide-react';
import {
  MCP_CONNECTION_MAX_SECONDS, MCP_OAUTH_TOKEN_TTL_SECONDS, type McpConnection, type McpScope,
} from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { formatRelativeTime } from '@/lib/format-relative-time';
import { useRevokeTenantAgent, useTenantAgents } from '@/hooks/use-ai-agents';

const card = 'rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800';
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

function CopyButton({ value, label }: { readonly value: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-100"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function ScopeChips({ scopes }: { readonly scopes: readonly McpScope[] }) {
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

function AgentRow({ agent, showUser }: { readonly agent: McpConnection; readonly showUser: boolean }) {
  const revoke = useRevokeTenantAgent();
  const [confirming, setConfirming] = useState(false);
  const error = revoke.error ? extractOperatorError(revoke.error) : null;
  return (
    <tr className="border-t border-gray-100 align-top dark:border-gray-700" data-testid={`ai-agent-row-${agent.id}`}>
      <td className="py-2 pr-3">
        <div className="font-medium text-gray-900 dark:text-gray-100">{agent.clientName}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">connected {formatRelativeTime(agent.createdAt)}</div>
        {error && <div className="mt-2"><ErrorPanel error={error} /></div>}
      </td>
      {showUser && (
        <td className="py-2 pr-3 text-xs text-gray-700 dark:text-gray-300">
          <div>{agent.user.fullName}</div>
          <div className="text-gray-500 dark:text-gray-400">{agent.user.email}</div>
        </td>
      )}
      <td className="py-2 pr-3"><ScopeChips scopes={agent.scopes} /></td>
      <td className="hidden py-2 pr-3 text-xs text-gray-600 md:table-cell dark:text-gray-300">
        {agent.lastUsedAt ? formatRelativeTime(agent.lastUsedAt) : '—'}
      </td>
      <td className="py-2 pr-3 text-xs text-gray-600 dark:text-gray-300" title={new Date(agent.expiresAt).toLocaleString()}>
        {formatEndsIn(agent.expiresAt)}
      </td>
      <td className="py-2 text-right">
        {confirming ? (
          <span className="inline-flex gap-1">
            <button type="button" onClick={() => revoke.mutate(agent.id)} disabled={revoke.isPending} className={`${btn} bg-red-600 text-white hover:bg-red-700`} data-testid="ai-agent-revoke-confirm">
              {revoke.isPending ? <Loader2 size={14} className="animate-spin" /> : null} Disconnect
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={`${btn} text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700`}>Keep</button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} className={`${btn} text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20`} data-testid="ai-agent-revoke">
            <Unplug size={14} /> Disconnect
          </button>
        )}
      </td>
    </tr>
  );
}

export default function AiAgentsSection() {
  const { data, isLoading, error } = useTenantAgents();
  const loadError = error ? extractOperatorError(error) : null;
  const sectionRef = useRef<HTMLElement>(null);
  const loaded = Boolean(data);
  const accessMinutes = Math.round(MCP_OAUTH_TOKEN_TTL_SECONDS / 60);
  const connectionHours = Math.round(MCP_CONNECTION_MAX_SECONDS / 3600);

  // The header's agent chip links to #ai-agents; the router does not scroll to it.
  useEffect(() => {
    if (loaded && window.location.hash === '#ai-agents') sectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, [loaded]);

  return (
    <section id="ai-agents" ref={sectionRef} className={card} data-testid="ai-agents-section">
      <div className="mb-2 flex items-center gap-2">
        <Bot size={18} className="text-gray-500 dark:text-gray-400" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">AI agents</h2>
      </div>
      <p className="mb-4 max-w-2xl text-sm text-gray-600 dark:text-gray-400">
        Connect an AI client — Claude, Cursor, VS Code and others — to this panel through MCP. It signs in here and
        then acts as you, with your role, in this account only. Its access lasts {accessMinutes} minutes and renews by
        itself for up to {connectionHours} hours; after that the client asks you again. Everything it does is in the
        audit log.
      </p>

      {isLoading && <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2 size={14} className="animate-spin" /> Loading…</div>}
      {loadError && <ErrorPanel error={loadError} />}

      {data && !data.enabled && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100" data-testid="ai-agents-disabled">
          AI agents are switched off on this platform. Ask your provider if you need them.
        </p>
      )}

      {data && data.enabled && (
        <>
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-gray-900/60">
            <span className="shrink-0 text-gray-500 dark:text-gray-400">MCP address</span>
            <code className="truncate text-gray-900 dark:text-gray-100" data-testid="ai-agents-endpoint">{data.endpoint}</code>
            <CopyButton value={data.endpoint} label="Copy MCP address" />
          </div>
          <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
            Add it to your AI client as a remote (HTTP) MCP server — e.g.{' '}
            <code className="rounded bg-gray-100 px-1 py-0.5 text-gray-800 dark:bg-gray-900 dark:text-gray-200">claude mcp add --transport http hosting {data.endpoint}</code>
            {' '}— and approve it on the page that opens.
          </p>
          {!data.canConnect && (
            <p className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900/60 dark:text-gray-300" data-testid="ai-agents-impersonating">
              You are signed in on behalf of this account, so you cannot connect an agent here. Only its own users can.
            </p>
          )}

          <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {data.view === 'tenant' ? 'Agents connected to this account' : 'Your connected agents'}
          </h3>
          {data.connections.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="ai-agents-empty">No AI agent is connected.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    <th className="pb-2 pr-3 font-medium">Agent</th>
                    {data.view === 'tenant' && <th className="pb-2 pr-3 font-medium">Acts as</th>}
                    <th className="pb-2 pr-3 font-medium">Scopes</th>
                    <th className="hidden pb-2 pr-3 font-medium md:table-cell">Last active</th>
                    <th className="pb-2 pr-3 font-medium">Ends</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.connections.map((c) => <AgentRow key={c.id} agent={c} showUser={data.view === 'tenant'} />)}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
