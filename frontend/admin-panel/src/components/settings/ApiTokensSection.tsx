/**
 * User Settings → API tokens & AI agents.
 *
 * Personal access tokens work on the whole REST API (scripts, CI) and on the
 * MCP endpoint (AI agents). AI clients that sign in with OAuth show up here
 * too, so every live credential acting as this user can be seen and revoked
 * in one place. Only users with the admin role may hold either.
 */
import { useState } from 'react';
import { Bot, Check, Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import { MCP_PAT_EXPIRY_DAYS, MCP_SCOPES, type CreatedMcpPat, type McpScope, type McpToken } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { useApiTokens, useCreateApiToken, useRevokeApiToken } from '@/hooks/use-api-tokens';

const SCOPE_HELP: Record<McpScope, string> = {
  read: 'View anything the admin role can see.',
  write: 'Make changes — create, update, suspend, move files to the trash.',
  delete: 'Irreversible actions — delete, purge, restore over existing data, rotate credentials.',
};

const card = 'rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800';
const btn = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50';

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function CopyButton({ value, label }: { value: string; label: string }) {
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

function ScopeChips({ scopes }: { scopes: readonly McpScope[] }) {
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

function CreateTokenForm({ onCreated, onCancel }: { onCreated: (t: CreatedMcpPat) => void; onCancel: () => void }) {
  const create = useCreateApiToken();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<McpScope[]>(['read']);
  const [expiry, setExpiry] = useState<string>('90');
  const toggle = (s: McpScope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const error = create.error ? extractOperatorError(create.error) : null;

  return (
    <form
      data-testid="api-token-create-form"
      className="mt-4 space-y-4 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(
          { name: name.trim(), scopes, expiresInDays: expiry === 'never' ? null : Number(expiry) },
          { onSuccess: onCreated },
        );
      }}
    >
      <div>
        <label htmlFor="api-token-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Name</label>
        <input
          id="api-token-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          placeholder="e.g. Claude Desktop, nightly report script"
          className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">Scopes</legend>
        <div className="mt-2 space-y-2">
          {MCP_SCOPES.map((s) => (
            <label key={s} className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} className="mt-0.5" data-testid={`api-token-scope-${s}`} />
              <span><strong className="font-medium">{s}</strong> <span className="text-gray-500 dark:text-gray-400">— {SCOPE_HELP[s]}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor="api-token-expiry" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Expires</label>
        <select
          id="api-token-expiry"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          className="mt-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        >
          {MCP_PAT_EXPIRY_DAYS.map((d) => <option key={d} value={String(d)}>in {d} days</option>)}
          <option value="never">never</option>
        </select>
        {expiry === 'never' && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">A token that never expires works until you revoke it. Keep it somewhere safe.</p>
        )}
      </div>
      {error && <ErrorPanel error={error} />}
      <div className="flex gap-2">
        <button type="submit" disabled={!name.trim() || scopes.length === 0 || create.isPending} className={`${btn} bg-blue-600 text-white hover:bg-blue-700`} data-testid="api-token-create-submit">
          {create.isPending ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />} Create token
        </button>
        <button type="button" onClick={onCancel} className={`${btn} border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700`}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function TokenRow({ token }: { token: McpToken }) {
  const revoke = useRevokeApiToken();
  const [confirming, setConfirming] = useState(false);
  return (
    <tr className="border-t border-gray-100 dark:border-gray-700" data-testid={`api-token-row-${token.id}`}>
      <td className="py-2 pr-3">
        <div className="font-medium text-gray-900 dark:text-gray-100">{token.kind === 'oauth' ? (token.clientName ?? token.name) : token.name}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {token.kind === 'oauth' ? 'AI client (OAuth)' : 'Personal access token'} · <code>{token.prefix}…</code>
        </div>
      </td>
      <td className="py-2 pr-3"><ScopeChips scopes={token.scopes} /></td>
      <td className="hidden py-2 pr-3 text-xs text-gray-600 md:table-cell dark:text-gray-300">{formatDate(token.createdAt)}</td>
      <td className="py-2 pr-3 text-xs text-gray-600 dark:text-gray-300">{token.expiresAt ? formatDate(token.expiresAt) : 'never'}</td>
      <td className="hidden py-2 pr-3 text-xs text-gray-600 md:table-cell dark:text-gray-300">{formatDate(token.lastUsedAt)}</td>
      <td className="py-2 text-right">
        {confirming ? (
          <span className="inline-flex gap-1">
            <button type="button" onClick={() => revoke.mutate(token.id)} disabled={revoke.isPending} className={`${btn} bg-red-600 text-white hover:bg-red-700`} data-testid="api-token-revoke-confirm">
              {revoke.isPending ? <Loader2 size={14} className="animate-spin" /> : null} Revoke
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={`${btn} text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700`}>Keep</button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} className={`${btn} text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20`} data-testid="api-token-revoke">
            <Trash2 size={14} /> Revoke
          </button>
        )}
      </td>
    </tr>
  );
}

export default function ApiTokensSection() {
  const { data, isLoading, error } = useApiTokens();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedMcpPat | null>(null);
  const loadError = error ? extractOperatorError(error) : null;

  return (
    <section className={card} data-testid="api-tokens-section">
      <div className="mb-2 flex items-center gap-3">
        <Bot size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">API tokens &amp; AI agents</h2>
      </div>
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">
        A personal access token lets a script use the platform API, and an AI agent use it through MCP. AI clients
        can also connect with the MCP address below and sign in here (access lasts 8 hours). Either way they act
        as you, never with more than your role allows, and every action is in the audit log.
      </p>

      {isLoading && <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2 size={14} className="animate-spin" /> Loading…</div>}
      {loadError && <ErrorPanel error={loadError} />}

      {data && (
        <>
          <div className="mb-4 flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-gray-900/60">
            <span className="text-gray-500 dark:text-gray-400">MCP endpoint</span>
            <code className="truncate text-gray-900 dark:text-gray-100" data-testid="mcp-endpoint">{data.endpoint}</code>
            <CopyButton value={data.endpoint} label="Copy MCP endpoint" />
          </div>

          {!data.canUse ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100" data-testid="api-tokens-not-allowed">
              Only users with the <strong>admin</strong> role can create API tokens or connect AI agents.
            </p>
          ) : (
            <>
              {created && (
                <div className="mb-4 rounded-lg border border-green-300 bg-green-50 p-3 dark:border-green-800 dark:bg-green-900/20" data-testid="api-token-created">
                  <p className="text-sm font-medium text-green-900 dark:text-green-100">Token “{created.name}” created. Copy it now — it will not be shown again.</p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="break-all rounded bg-white px-2 py-1 text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100" data-testid="api-token-secret">{created.token}</code>
                    <CopyButton value={created.token} label="Copy token" />
                  </div>
                  <button type="button" onClick={() => setCreated(null)} className="mt-2 text-xs text-green-800 underline dark:text-green-200">I have stored it</button>
                </div>
              )}

              {data.tokens.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">No tokens yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        <th className="pb-2 pr-3 font-medium">Token</th>
                        <th className="pb-2 pr-3 font-medium">Scopes</th>
                        <th className="hidden pb-2 pr-3 font-medium md:table-cell">Created</th>
                        <th className="pb-2 pr-3 font-medium">Expires</th>
                        <th className="hidden pb-2 pr-3 font-medium md:table-cell">Last used</th>
                        <th className="pb-2" />
                      </tr>
                    </thead>
                    <tbody>{data.tokens.map((t) => <TokenRow key={t.id} token={t} />)}</tbody>
                  </table>
                </div>
              )}

              {creating ? (
                <CreateTokenForm onCreated={(t) => { setCreated(t); setCreating(false); }} onCancel={() => setCreating(false)} />
              ) : (
                <button type="button" onClick={() => setCreating(true)} className={`${btn} mt-4 bg-blue-600 text-white hover:bg-blue-700`} data-testid="api-token-new">
                  <Plus size={14} /> New token
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
