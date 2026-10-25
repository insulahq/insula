/**
 * "Get bootstrap command" for a pre-enrolled node (Security → Network Trust
 * → Pending Peers). Renders the ONE line the operator runs ON THE NEW NODE as
 * root: it fetches scripts/join-node.sh, checks it against the hash of the
 * platform's own copy, and runs it — the script verifies and installs the
 * cluster's own `insula` release, then runs `insula bootstrap --join-as …`.
 *
 * Opening it POSTs: for a worker the platform mints a short-lived join
 * token (shown with its expiry). A server join needs the cluster's server
 * token, which the platform never serves — step 1 reads it on an existing
 * server instead.
 *
 * The join goes through one existing server (`--server`). The platform picks a
 * Ready one whose API port answers; the operator can pick any other Ready one —
 * every server holds the same token, so any of them works.
 */

import { useEffect, useState } from 'react';
import { AlertCircle, Copy, Info, KeyRound, Loader2, X } from 'lucide-react';
import type {
  BootstrapCommandResponse,
  BootstrapStep,
  JoinServerCandidate,
  OperatorError,
} from '@insula/api-contracts';
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
  // ip undefined = the platform's pick. `n` makes a repeated pick (say, a retry
  // after a refused one) fetch again.
  const [pick, setPick] = useState<{ ip?: string; n: number }>({ n: 0 });
  const [loading, setLoading] = useState(true);

  // Escape closes, like every other admin modal (found by driving it in a real browser).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchBootstrapCommand(cppName, pick.ip)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(extractOperatorError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cppName, pick]);

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
          {data && (
            <JoinSteps
              data={data}
              cppName={cppName}
              loading={loading}
              onPickServer={(ip) => setPick((p) => ({ ip, n: p.n + 1 }))}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface JoinStepsProps {
  readonly data: BootstrapCommandResponse;
  readonly cppName: string;
  readonly loading: boolean;
  readonly onPickServer: (ip: string) => void;
}

function JoinSteps({ data, cppName, loading, onPickServer }: JoinStepsProps) {
  const onServer = data.steps.filter((s) => s.runOn === 'existing-server');
  const onNode = data.steps.filter((s) => s.runOn === 'new-node');
  const numberOf = (s: BootstrapStep): number => data.steps.indexOf(s) + 1;
  const firstOnNode = onNode[0];
  const nodeHeading =
    onServer.length > 0 && firstOnNode ? `Step ${numberOf(firstOnNode)} — on the new node` : 'On the new node';

  return (
    <div className="space-y-4">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100" data-testid="bootstrap-command-heading">
        Run the join on the new node <Code>{data.nodeIp}</Code> as root (<Code>sudo -i</Code>).
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

      <JoinTargetPicker data={data} loading={loading} onPick={onPickServer} />

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

      <div aria-busy={loading} className={`space-y-4 ${loading ? 'opacity-60' : ''}`}>
        {onServer.map((s) => (
          <section key={s.id}>
            <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              Step {numberOf(s)} — on any existing server
            </h3>
            <p className="mb-2 text-xs text-gray-600 dark:text-gray-400">{s.title}</p>
            <CodeBlock text={s.command} testId={`bootstrap-step-${s.id}`} />
            {s.note && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{s.note}</p>}
          </section>
        ))}

        <section>
          <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {nodeHeading} ({data.nodeIp})
          </h3>
          <CodeBlock text={data.script} testId="bootstrap-script" />
          {onNode.map(
            (s) =>
              s.note && (
                <p key={s.id} className="mt-1 text-xs text-gray-500 dark:text-gray-400" data-testid={`bootstrap-note-${s.id}`}>
                  {s.note}
                </p>
              ),
          )}
          {data.joinScript && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              <a
                href={data.joinScript.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-blue-700 dark:text-blue-400 underline hover:text-blue-900 dark:hover:text-blue-300"
                data-testid="join-script-link"
              >
                Read join-node.sh
              </a>{' '}
              — the exact file the line runs (SHA-256 <Code>{data.joinScript.sha256.slice(0, 12)}…</Code>).
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/** Which server the steps join through, when the cluster has more than one.
 *  A server that is not Ready cannot be picked; one whose API port did not
 *  answer just now is marked so. Picking one re-renders the steps for it. */
function JoinTargetPicker({
  data,
  loading,
  onPick,
}: {
  data: BootstrapCommandResponse;
  loading: boolean;
  onPick: (ip: string) => void;
}) {
  const servers = data.servers ?? [];
  if (servers.length < 2) return null;
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3">
      <label htmlFor="join-target-select" className="block text-xs font-medium text-gray-800 dark:text-gray-200">
        Join through
      </label>
      <div className="mt-1 flex items-center gap-2">
        <select
          id="join-target-select"
          data-testid="join-target-select"
          value={data.serverIp}
          disabled={loading}
          aria-describedby="join-target-help"
          onChange={(e) => onPick(e.target.value)}
          className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 font-mono text-xs text-gray-900 dark:text-gray-100 disabled:opacity-60"
        >
          {servers.map((s) => (
            <option key={s.ip} value={s.ip} disabled={!s.ready}>
              {s.name} ({s.ip}){serverState(s)}
            </option>
          ))}
        </select>
        {loading && (
          <span role="status" className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
            <Loader2 size={12} className="animate-spin" />
            Updating…
          </span>
        )}
      </div>
      <p id="join-target-help" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Any Ready server works — they all hold the same server token. The default is one whose API port answered
        just now.
      </p>
    </div>
  );
}

function serverState(s: JoinServerCandidate): string {
  if (!s.ready) return ' — not Ready';
  if (s.answering === false) return ' — not answering';
  if (s.cordoned) return ' — cordoned';
  return '';
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
        The platform never shows that token: step 1 reads it on any existing server (every server holds the same
        one), and the join step asks for it (hidden input, kept out of shell history) and checks it before
        installing anything.
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
