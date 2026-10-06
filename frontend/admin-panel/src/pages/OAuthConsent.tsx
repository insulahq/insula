/**
 * OAuth consent — an AI client (MCP) asks to act as the signed-in user.
 *
 * Reached from GET /api/v1/oauth/authorize, which parks the request and sends
 * the browser here. The client's NAME is whatever the client registered, so
 * the page leads with where the approval is sent (the redirect host): that is
 * what the user can actually judge.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bot, Loader2, ShieldCheck } from 'lucide-react';
import { MCP_OAUTH_TOKEN_TTL_SECONDS, type McpScope } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { useConsentDecision, useConsentRequest } from '@/hooks/use-api-tokens';

const SCOPE_TEXT: Record<McpScope, string> = {
  read: 'See everything the admin role can see',
  write: 'Make changes (create, update, suspend, move tenant files to the trash)',
  delete: 'Take irreversible actions (delete, purge, restore over existing data)',
};

export default function OAuthConsent() {
  const [params] = useSearchParams();
  const requestId = params.get('request');
  const request = useConsentRequest(requestId);
  const decision = useConsentDecision(requestId ?? '');
  const [scopes, setScopes] = useState<McpScope[]>([]);

  useEffect(() => {
    if (request.data) setScopes([...request.data.requestedScopes]);
  }, [request.data]);

  const decide = (approve: boolean) => {
    decision.mutate({ approve, scopes: approve ? scopes : [] }, {
      onSuccess: (res) => { window.location.assign(res.redirectTo); },
    });
  };

  const loadError = request.error ? extractOperatorError(request.error) : null;
  const decideError = decision.error ? extractOperatorError(decision.error) : null;
  const hours = Math.round(MCP_OAUTH_TOKEN_TTL_SECONDS / 3600);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10 dark:bg-gray-900">
      <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-800" data-testid="oauth-consent">
        <div className="mb-4 flex items-center gap-3">
          <Bot size={24} className="text-gray-700 dark:text-gray-300" />
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Connect an AI agent</h1>
        </div>

        {!requestId && <p className="text-sm text-gray-600 dark:text-gray-300">This link has no authorization request.</p>}
        {request.isLoading && <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"><Loader2 size={14} className="animate-spin" /> Loading…</div>}
        {loadError && <ErrorPanel error={loadError} />}

        {request.data && (
          <>
            <p className="text-sm text-gray-700 dark:text-gray-200">
              <strong data-testid="oauth-consent-client">{request.data.clientName}</strong> wants to use the platform
              as you. Approving sends access to{' '}
              <strong className="font-mono" data-testid="oauth-consent-redirect">{request.data.redirectHost}</strong>.
            </p>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              The name is chosen by the client itself. Only approve if you started this connection and recognise
              where it is sent.
            </p>

            <fieldset className="mt-4">
              <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">Allow it to</legend>
              <div className="mt-2 space-y-2">
                {request.data.requestedScopes.map((s) => (
                  <label key={s} className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={scopes.includes(s)}
                      onChange={() => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))}
                      data-testid={`oauth-consent-scope-${s}`}
                    />
                    <span><strong className="font-medium">{s}</strong> — {SCOPE_TEXT[s]}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <p className="mt-4 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <ShieldCheck size={14} /> Access lasts {hours} hours, never exceeds your role, and is logged. You can
              revoke it any time under User Settings → API tokens &amp; AI agents.
            </p>

            {decideError && <div className="mt-4"><ErrorPanel error={decideError} /></div>}

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => decide(false)}
                disabled={decision.isPending}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                data-testid="oauth-consent-deny"
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => decide(true)}
                disabled={decision.isPending || scopes.length === 0}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                data-testid="oauth-consent-approve"
              >
                {decision.isPending && <Loader2 size={14} className="animate-spin" />} Approve
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
