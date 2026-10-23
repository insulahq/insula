/**
 * Security → AI agents: every AI agent connected to the platform — admins'
 * agents on the admin panel's MCP endpoint and tenant users' agents on the
 * tenant panel's — with who approved each and for which tenant, and the
 * operator's switch for tenant agents. Any of them can be disconnected here.
 */
import { useState } from 'react';
import { Bot, Loader2 } from 'lucide-react';
import { MCP_CONNECTION_MAX_SECONDS } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import AgentConnectionsTable from '@/components/agents/AgentConnectionsTable';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { usePlatformAgents, useUpdateAgentSettings } from '@/hooks/use-api-tokens';

const card = 'rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800';

function TenantAgentsSwitch({ enabled, tenantCount }: { readonly enabled: boolean; readonly tenantCount: number }) {
  const update = useUpdateAgentSettings();
  const [confirmOff, setConfirmOff] = useState(false);
  const error = update.error ? extractOperatorError(update.error) : null;
  const set = (value: boolean) => update.mutate({ tenantAgentsEnabled: value }, { onSuccess: () => setConfirmOff(false) });

  return (
    <section className={card} data-testid="tenant-agents-switch-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Tenant AI agents</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-600 dark:text-gray-300">
            Off by default. When on, any tenant user can connect an AI agent to the tenant panel. The agent acts as
            that user, with that user&apos;s role, inside their own tenant only, and cannot create logins, keys or
            passwords that would outlive it. Switching off disconnects every tenant agent at once.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Tenant AI agents"
          disabled={update.isPending}
          onClick={() => (enabled ? (tenantCount > 0 ? setConfirmOff(true) : set(false)) : set(true))}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus:ring-offset-gray-800 ${
            enabled ? 'bg-brand-500' : 'bg-gray-300 dark:bg-gray-600'
          }`}
          data-testid="tenant-agents-toggle"
        >
          <span
            aria-hidden="true"
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
              enabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>
      {confirmOff && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" data-testid="tenant-agents-off-confirm">
          <p>
            {tenantCount === 1 ? '1 tenant agent is' : `${tenantCount} tenant agents are`} connected. Switching off
            disconnects {tenantCount === 1 ? 'it' : 'them'} now, and tenant users cannot connect new ones.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => set(false)}
              disabled={update.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              data-testid="tenant-agents-off-confirm-button"
            >
              {update.isPending && <Loader2 size={14} className="animate-spin" />} Switch off and disconnect
            </button>
            <button
              type="button"
              onClick={() => setConfirmOff(false)}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-amber-100 dark:text-gray-200 dark:hover:bg-amber-900/40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <div className="mt-4"><ErrorPanel error={error} /></div>}
    </section>
  );
}

export default function AiAgentsPage() {
  const { data, isLoading, error } = usePlatformAgents();
  const loadError = error ? extractOperatorError(error) : null;
  const hours = Math.round(MCP_CONNECTION_MAX_SECONDS / 3600);
  const tenantCount = data?.connections.filter((c) => c.audience === 'tenant').length ?? 0;

  return (
    <div className="space-y-6" data-testid="ai-agents-page">
      <div className="flex items-center gap-3">
        <Bot size={28} className="text-brand-500" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">AI Agents</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Every AI agent connected through MCP, on the admin and the tenant panel. A connection ends by itself
            {` ${hours}`} hours after it was approved.
          </p>
        </div>
      </div>

      {isLoading && <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2 size={14} className="animate-spin" /> Loading…</div>}
      {loadError && <ErrorPanel error={loadError} />}

      {data && (
        <>
          <TenantAgentsSwitch enabled={data.tenantAgentsEnabled} tenantCount={tenantCount} />
          <section className={card}>
            <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">Connected agents</h2>
            <AgentConnectionsTable connections={data.connections} showOwner emptyText="No AI agent is connected." />
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              Personal access tokens are not listed here — each admin manages their own under User Settings.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
