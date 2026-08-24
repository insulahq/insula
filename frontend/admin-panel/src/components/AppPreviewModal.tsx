/**
 * App preview modal — sandboxed iframe onto a deployment's ClusterIP
 * Service via the backend preview proxy. Works with NO ingress route:
 * the modal mints a short-lived proxy URL and the iframe loads it
 * same-origin (the panel's nginx forwards /api/v1 to platform-api).
 *
 * The iframe is sandboxed WITHOUT allow-same-origin, and every proxied
 * response additionally carries `Content-Security-Policy: sandbox` from
 * the server — tenant/app JavaScript can never touch the panel's
 * cookies or localStorage.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, ExternalLink, RefreshCw, X, Loader2, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import type { CreatePreviewSessionResponse, PreviewSession, PreviewTarget } from '@insula/api-contracts';

export interface AppPreviewModalProps {
  tenantId: string;
  deploymentId: string;
  deploymentName: string;
  onClose: () => void;
}

export default function AppPreviewModal({ tenantId, deploymentId, deploymentName, onClose }: AppPreviewModalProps) {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [frameKey, setFrameKey] = useState(0);
  // Guards against out-of-order mint responses: switching targets fires a
  // new POST while the previous may still be in flight — only the LATEST
  // call's response may win, or the iframe silently shows the wrong port.
  const mintSeq = useRef(0);

  const mint = useCallback(async (target?: PreviewTarget) => {
    const seq = ++mintSeq.current;
    setLoading(true);
    setError(null);
    try {
      const resp = await apiFetch<CreatePreviewSessionResponse>(
        `/api/v1/tenants/${tenantId}/deployments/${deploymentId}/preview-session`,
        {
          method: 'POST',
          body: JSON.stringify(target ? { serviceName: target.serviceName, port: target.port } : {}),
        },
      );
      if (seq !== mintSeq.current) return; // superseded by a newer mint
      setSession(resp.data);
      setFrameKey((k) => k + 1);
    } catch (err) {
      if (seq !== mintSeq.current) return;
      setError(err instanceof Error ? err.message : 'Failed to open the preview');
    } finally {
      if (seq === mintSeq.current) setLoading(false);
    }
  }, [tenantId, deploymentId]);

  useEffect(() => { void mint(); }, [mint]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="app-preview-modal">
      <div className="flex h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-gray-900">
        <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
          <Eye size={18} className="text-gray-600 dark:text-gray-300" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
              Preview — {deploymentName}
            </div>
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              Direct view of the running app — no route needed. Link expires after ~15 minutes.
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {session && session.targets.length > 1 && (
              <select
                value={`${session.target.serviceName}:${session.target.port}`}
                onChange={(e) => {
                  const t = session.targets.find((x) => `${x.serviceName}:${x.port}` === e.target.value);
                  if (t) void mint(t);
                }}
                className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                data-testid="app-preview-target-picker"
              >
                {session.targets.map((t) => (
                  <option key={`${t.serviceName}:${t.port}`} value={`${t.serviceName}:${t.port}`}>
                    {(t.memberName ? `${t.memberName} · ` : '') + (t.portName ?? '') + (t.portName ? ' ' : '') + `:${t.port}`}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={() => void mint(session?.target)}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700/50"
              data-testid="app-preview-refresh"
            >
              <RefreshCw size={13} /> Refresh
            </button>
            {session && (
              <a
                href={session.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700/50"
                title="Open in a new tab (still sandboxed — app sessions/cookies won't persist)"
                data-testid="app-preview-open-tab"
              >
                <ExternalLink size={13} /> Tab
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700/50"
              data-testid="app-preview-close"
              aria-label="Close preview"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="relative flex-1 bg-gray-50 dark:bg-gray-950">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 size={24} className="animate-spin text-gray-400" />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div className="flex max-w-md items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <div data-testid="app-preview-error">{error}</div>
              </div>
            </div>
          )}
          {session && !error && (
            <iframe
              key={frameKey}
              src={session.url}
              title={`Preview of ${deploymentName}`}
              className="h-full w-full border-0"
              sandbox="allow-scripts allow-forms"
              data-testid="app-preview-iframe"
            />
          )}
        </div>

        <div className="border-t border-gray-200 px-4 py-1.5 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
          Sandboxed preview: app logins/cookies are disabled, and apps that assume they run at the
          domain root may render without styles. Assign a route for full fidelity.
        </div>
      </div>
    </div>
  );
}
