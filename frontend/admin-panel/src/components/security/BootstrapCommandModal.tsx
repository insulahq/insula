/**
 * "Get bootstrap command" for a pre-enrolled node (Security → Network Trust
 * → Pending Peers). Renders the join steps the operator runs ON THE NEW
 * NODE as root: download + verify + install the cluster's own `insula`
 * release, then `insula bootstrap --join-as …`. One paste-safe block, plus
 * each step on its own.
 *
 * Opening it POSTs: for a worker the platform mints a short-lived join
 * token (shown with its expiry). A server join needs the cluster's server
 * token, which the platform never serves — step 1 reads it on an existing
 * server instead.
 */

import { useEffect, useState } from 'react';
import { AlertCircle, Copy, Info, KeyRound, Loader2, X } from 'lucide-react';
import type { BootstrapCommandResponse, BootstrapStep, OperatorError } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { fetchBootstrapCommand } from '@/hooks/use-cluster-network';
import { extractOperatorError } from '@/lib/extract-operator-error';

interface BootstrapCommandModalProps {
  readonly cppName: string;
  readonly onClose: () => void;
}

export default function BootstrapCommandModal({ cppName, onClose }: BootstrapCommandModalProps) {
  const [data, setData] = useState<BootstrapCommandResponse | null>(null);
  const [error, setError] = useState<OperatorError | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBootstrapCommand(cppName)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(extractOperatorError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [cppName]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-4 py-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Join command — {cppName}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto p-4">
          {!data && !error && (
            <div className="flex items-center gap-2 py-6 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" />
              Preparing the join steps…
            </div>
          )}
          {error && <ErrorPanel error={error} testId="bootstrap-command-error" />}
          {data && <JoinSteps data={data} cppName={cppName} />}
        </div>
      </div>
    </div>
  );
}

function JoinSteps({ data, cppName }: { data: BootstrapCommandResponse; cppName: string }) {
  const onServer = data.steps.filter((s) => s.runOn === 'existing-server');
  const onNode = data.steps.filter((s) => s.runOn === 'new-node');
  const numberOf = (s: BootstrapStep): number => data.steps.indexOf(s) + 1;
  const firstOnNode = onNode[0];
  const nodeRange =
    onServer.length > 0 && firstOnNode ? `Steps ${numberOf(firstOnNode)}–${data.steps.length}` : 'All steps';

  return (
    <div className="space-y-4">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100" data-testid="bootstrap-command-heading">
        Run these on the new node <Code>{data.nodeIp}</Code> as root (<Code>sudo -i</Code>).
      </p>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        The pre-enrolment <Code>{cppName}</Code> must exist while the node joins — it is what lets{' '}
        <Code>{data.nodeIp}</Code> through the cluster firewall. Keep it until the node appears under Nodes.
      </p>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Fact label="Role" value={data.role === 'server' ? 'Server (control plane)' : 'Worker'} />
        <Fact label="Joins via" value={data.serverIp} mono />
        <Fact label="Release" value={data.platformVersion} mono />
        <Fact label="Network" value={data.dualStack ? 'Dual-stack (IPv4 + IPv6)' : 'IPv4'} />
      </dl>

      <TokenPanel data={data} />

      {data.warning && (
        <div
          className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/20 p-3 text-xs text-amber-800 dark:text-amber-300"
          data-testid="bootstrap-command-warning"
        >
          <AlertCircle size={14} className="mr-1 inline" />
          {data.warning}
        </div>
      )}

      {data.notes.length > 0 && (
        <ul
          className="list-disc space-y-1 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/20 py-3 pl-8 pr-3 text-xs text-amber-800 dark:text-amber-300"
          data-testid="bootstrap-command-notes"
        >
          {data.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {onServer.map((s) => (
        <section key={s.id}>
          <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            Step {numberOf(s)} — on an existing server ({data.serverIp})
          </h3>
          <p className="mb-2 text-xs text-gray-600 dark:text-gray-400">{s.title}</p>
          <CodeBlock text={s.command} testId={`bootstrap-step-${s.id}`} />
          {s.note && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{s.note}</p>}
        </section>
      ))}

      <section>
        <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          {nodeRange} — on the new node ({data.nodeIp}), pasted as one block
        </h3>
        <CodeBlock text={data.script} copyLabel="Copy all" testId="bootstrap-script" />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          The block stops at the first failure: if the signature check does not print{' '}
          <Code>Verified OK</Code>, nothing is installed or run.
        </p>
      </section>

      <details className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3">
        <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300">
          Copy the new-node steps one at a time
        </summary>
        <ol className="mt-3 space-y-3">
          {onNode.map((s) => (
            <li key={s.id}>
              <p className="mb-1 text-xs font-medium text-gray-800 dark:text-gray-200">
                Step {numberOf(s)} — {s.title}
              </p>
              <CodeBlock text={s.command} testId={`bootstrap-step-${s.id}`} />
              {s.note && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{s.note}</p>}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function TokenPanel({ data }: { data: BootstrapCommandResponse }) {
  const { joinToken } = data;
  if (joinToken.kind === 'bootstrap' && joinToken.expiresAt) {
    return (
      <div
        className="flex items-start gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-900/20 p-3 text-xs text-emerald-800 dark:text-emerald-300"
        data-testid="join-token-expiry"
      >
        <KeyRound size={14} className="mt-0.5 shrink-0" />
        <span>
          A join token was minted for this worker (id <Code>{joinToken.tokenId ?? '—'}</Code>). It is valid until{' '}
          <strong>{new Date(joinToken.expiresAt).toLocaleString()}</strong> ({relativeTime(joinToken.expiresAt)}),
          works for joining workers only, and is revoked as soon as the pre-enrolment is removed.
        </span>
      </div>
    );
  }
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-900/20 p-3 text-xs text-blue-800 dark:text-blue-300"
      data-testid="join-token-server"
    >
      <Info size={14} className="mt-0.5 shrink-0" />
      <span>
        {data.role === 'server'
          ? 'A server join needs the cluster’s server token — short-lived tokens can only join workers. '
          : 'No short-lived token could be minted (see the note below), so this worker joins with the cluster’s server token. '}
        The platform never shows that token: step 1 reads it on an existing server, and the join step asks for it
        (hidden input, kept out of shell history).
      </span>
    </div>
  );
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (Number.isNaN(minutes)) return 'expiry unknown';
  if (minutes <= 0) return 'already expired — reopen to mint a new one';
  if (minutes < 90) return `in ${minutes} min`;
  return `in about ${Math.round(minutes / 60)} h`;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-2 py-1.5">
      <dt className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className={`text-xs text-gray-900 dark:text-gray-100 ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-gray-100 dark:bg-gray-700 px-1 font-mono text-gray-800 dark:text-gray-200">{children}</code>;
}

function CodeBlock({ text, copyLabel = 'Copy', testId }: { text: string; copyLabel?: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const handleCopy = (): void => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setCopyFailed(false);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setCopyFailed(true));
  };
  return (
    <div className="relative rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 pt-9">
      <pre
        className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-gray-800 dark:text-gray-200"
        data-testid={testId}
      >
        {text}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-[11px] text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
      >
        <Copy size={12} />
        {copied ? 'Copied' : copyFailed ? 'Copy failed — select the text' : copyLabel}
      </button>
    </div>
  );
}
