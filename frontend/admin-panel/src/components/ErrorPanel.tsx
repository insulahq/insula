import { useState } from 'react';
import { AlertTriangle, AlertOctagon, AlertCircle, ChevronDown, ChevronRight, RotateCw, Copy } from 'lucide-react';
import type { OperatorError } from '@insula/api-contracts';

export type ErrorSeverity = 'info' | 'warn' | 'error';

interface ErrorPanelProps {
  readonly error: OperatorError;
  /** Optional callback for the Retry button. Hidden when omitted. */
  readonly onRetry?: () => void;
  readonly retryPending?: boolean;
  readonly severity?: ErrorSeverity;
  readonly compact?: boolean;
  readonly testId?: string;
}

/**
 * Standard operator error rendering. Drop-in for every place the
 * platform surfaces a backend / k8s / Longhorn / cert-manager error
 * to the operator: storage lifecycle, deployments tab, drain modal,
 * domain SSL state, file manager, tenant provisioning.
 *
 * Renders title + plain-English detail + 1-3 actionable remediation
 * bullets. Optional collapsed "More details" expander that renders the
 * diagnostics as a two-column table. Optional Retry button when `onRetry` is provided
 * AND the error is `retryable=true`.
 */
export default function ErrorPanel({
  error, onRetry, retryPending, severity = 'error', compact = false, testId,
}: ErrorPanelProps) {
  const [showRaw, setShowRaw] = useState(false);

  const palette =
    severity === 'error' ? {
      border: 'border-red-300 dark:border-red-700',
      bg: 'bg-red-50 dark:bg-red-900/30',
      title: 'text-red-900 dark:text-red-200',
      body: 'text-red-800 dark:text-red-300',
      Icon: AlertOctagon,
    } :
    severity === 'warn' ? {
      border: 'border-amber-300 dark:border-amber-700',
      bg: 'bg-amber-50 dark:bg-amber-900/30',
      title: 'text-amber-900 dark:text-amber-200',
      body: 'text-amber-800 dark:text-amber-300',
      Icon: AlertTriangle,
    } : {
      border: 'border-blue-300 dark:border-blue-700',
      bg: 'bg-blue-50 dark:bg-blue-900/30',
      title: 'text-blue-900 dark:text-blue-200',
      body: 'text-blue-800 dark:text-blue-300',
      Icon: AlertCircle,
    };
  const { Icon } = palette;

  const copyAll = () => {
    const text = [
      `[${error.code}] ${error.title}`,
      error.detail,
      'Remediation:',
      ...error.remediation.map((r, i) => `  ${i + 1}. ${r}`),
      error.diagnostics ? `Raw: ${JSON.stringify(error.diagnostics)}` : '',
    ].filter(Boolean).join('\n');
    void navigator.clipboard.writeText(text);
  };

  return (
    <div
      className={`rounded-lg border ${palette.border} ${palette.bg} p-3 ${compact ? 'text-xs' : 'text-sm'}`}
      data-testid={testId ?? `error-panel-${error.code}`}
      role="alert"
    >
      <div className="flex items-start gap-2">
        <Icon size={compact ? 14 : 16} className={`${palette.title} mt-0.5 shrink-0`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className={`font-semibold ${palette.title}`}>{error.title}</div>
              <div className={`mt-0.5 font-mono text-[10px] ${palette.body}`}>{error.code}</div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={copyAll}
                className={`rounded px-1.5 py-0.5 text-[10px] ${palette.body} hover:bg-white/40 dark:hover:bg-white/10`}
                title="Copy error + remediation to clipboard"
              >
                <Copy size={11} />
              </button>
              {onRetry && error.retryable && (
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={retryPending}
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${palette.body} hover:bg-white/40 dark:hover:bg-white/10 disabled:opacity-50`}
                >
                  <RotateCw size={11} className={retryPending ? 'animate-spin' : ''} />
                  Retry
                </button>
              )}
            </div>
          </div>
          <p className={`mt-1.5 ${palette.body}`}>{error.detail}</p>
          {error.remediation.length > 0 && (
            <ol className={`mt-1.5 ml-4 list-decimal space-y-0.5 ${palette.body}`}>
              {error.remediation.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          )}
          {error.diagnostics && Object.keys(error.diagnostics).length > 0 && (
            <button
              type="button"
              onClick={() => setShowRaw((p) => !p)}
              className={`mt-2 inline-flex items-center gap-1 text-[10px] ${palette.body} opacity-70 hover:opacity-100`}
              data-testid="error-panel-details-toggle"
            >
              {showRaw ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {showRaw ? 'Hide details' : 'More details'}
            </button>
          )}
          {showRaw && error.diagnostics && (
            <DiagnosticsTable diagnostics={error.diagnostics} bodyClass={palette.body} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Diagnostics rendered as a labelled table rather than `JSON.stringify`.
 *
 * A tenant hitting a quota was shown the Kubernetes API's raw JSON body —
 * `{"kind":"Status",...,"message":"pods \"x\" is forbidden: exceeded quota..."}` —
 * which is unreadable as prose and unreadable as JSON at 10px. The values that
 * matter (what was asked for, what is in use, what the limit is) are flat
 * key/value pairs, so they belong in two columns.
 *
 * Nested values have no table shape and fall back to a <pre>, so nothing is
 * silently dropped from the expander that operators copy into bug reports.
 */
function DiagnosticsTable({
  diagnostics, bodyClass,
}: {
  readonly diagnostics: Readonly<Record<string, unknown>>;
  readonly bodyClass: string;
}) {
  const entries = Object.entries(diagnostics);
  const flat = entries.filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v));
  const nested = entries.filter(([, v]) => !(v === null || ['string', 'number', 'boolean'].includes(typeof v)));

  return (
    <div className="mt-1.5 max-h-56 overflow-auto rounded bg-black/5 dark:bg-black/30 p-2" data-testid="error-panel-details">
      {flat.length > 0 && (
        <table className="w-full text-left text-[10px]">
          <tbody>
            {flat.map(([key, value]) => (
              <tr key={key} className="align-top">
                <th scope="row" className={`py-0.5 pr-3 font-medium whitespace-nowrap ${bodyClass} opacity-70`}>
                  {key}
                </th>
                <td className={`py-0.5 font-mono break-all ${bodyClass}`}>
                  {value === null ? '—' : String(value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {nested.map(([key, value]) => (
        <div key={key} className="mt-1.5">
          <div className={`text-[10px] font-medium opacity-70 ${bodyClass}`}>{key}</div>
          <pre className="mt-0.5 overflow-auto font-mono text-[10px]">{JSON.stringify(value, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
}
