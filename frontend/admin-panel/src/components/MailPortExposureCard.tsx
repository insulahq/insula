import { useState } from 'react';
import { Network, AlertTriangle, Loader2, Check, Info } from 'lucide-react';
import { useMailPortExposure, useUpdateMailPortExposure } from '@/hooks/use-mail-port-exposure';
import MailTaskProgressModal from '@/components/MailTaskProgressModal';
import type { MailPortExposureMode } from '@k8s-hosting/api-contracts';

// Mode catalogue. The descriptions are the ONLY place an operator
// reads how each mode actually exposes traffic — keep them concrete
// (which nodes, which mechanism, where the cert/TLS sits).
const MODE_OPTIONS: ReadonlyArray<{
  readonly mode: MailPortExposureMode;
  readonly title: string;
  readonly description: string;
  readonly switchWarning: string;
}> = [
  {
    mode: 'activeNodeOnly',
    title: 'Active node only',
    description:
      "hostPort binding on the Stalwart pod's node. Simple setup; mail traffic " +
      'enters only via the active mail node. No haproxy in the data path. Minimal ' +
      'attack surface; best for single-VPS or debugging.',
    switchWarning:
      'Switching to active node only disables the haproxy DaemonSet first, then ' +
      'adds hostPort bindings to Stalwart. Expect ~30s interruption.',
  },
  {
    mode: 'assignedMailNodes',
    title: 'All assigned mail nodes',
    description:
      'haproxy DaemonSet runs on every node in the {primary, secondary, tertiary} ' +
      'mail placement set. Switch is refused unless the active mail node is in ' +
      'that set (configure placement first). Operator-controlled exposure — useful ' +
      'when you want DNS rotation to match a specific set of nodes (e.g. nodes ' +
      'with reverse-DNS already set).',
    switchWarning:
      'Switching to assigned mail nodes will label {primary, secondary, tertiary}, ' +
      'roll Stalwart to drop hostPorts, then create the haproxy DaemonSet. ' +
      'Expect ~30s interruption.',
  },
  {
    mode: 'allServerNodes',
    title: 'All server nodes (haproxy + PROXY Protocol v2)',
    description:
      'haproxy DaemonSet runs on every server-role node AND the active node if ' +
      "it's a worker (so mail survives a server-tier outage as long as the active " +
      'node is up). DNS round-robins all data-plane IPs; any node accepts ' +
      "connections and forwards to Stalwart's ClusterIP with PROXY Protocol v2.",
    switchWarning:
      'Switching to all server nodes will roll Stalwart to drop hostPorts, label ' +
      'every server-role node (+ active if worker), then create the haproxy ' +
      'DaemonSet. Expect ~30s interruption.',
  },
];

export default function MailPortExposureCard() {
  const query = useMailPortExposure();
  const update = useUpdateMailPortExposure();
  const [draft, setDraft] = useState<MailPortExposureMode | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  if (query.isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading port exposure…
        </div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-5">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" />
          <div className="text-sm text-red-700 dark:text-red-300">
            Could not read mail port exposure config.{' '}
            {query.error instanceof Error ? query.error.message : 'See server logs.'}
          </div>
        </div>
      </div>
    );
  }

  const current = query.data.data;
  const selected = draft ?? current.mode;
  const hasChange = selected !== current.mode;
  const selectedOption = MODE_OPTIONS.find((o) => o.mode === selected)!;

  async function applyChange() {
    try {
      const resp = await update.mutateAsync({ mode: selected });
      setDraft(null);
      setConfirmOpen(false);
      if (resp.data.taskId) {
        setActiveTaskId(resp.data.taskId);
      } else {
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 6_000);
      }
    } catch {
      // Surfaced via update.isError below. Keep draft so operator can
      // retry; close the confirm so they're not stuck behind a modal.
      setConfirmOpen(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-4">
      <div className="flex items-center gap-3">
        <Network size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100" data-testid="mail-port-exposure-heading">
          Mail Port Exposure
        </h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Controls how SMTP/IMAP/Sieve ports (25, 465, 587, 993, 143, 4190) are exposed
        externally. Three modes; each maps to a different data plane.
      </p>

      <div className="space-y-2">
        {MODE_OPTIONS.map((opt) => (
          <label
            key={opt.mode}
            className={`flex items-start gap-3 rounded-lg border px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 ${
              selected === opt.mode
                ? 'border-brand-400 dark:border-brand-600 bg-brand-50/40 dark:bg-brand-900/10'
                : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900'
            }`}
          >
            <input
              type="radio"
              name="mail-port-exposure-mode"
              value={opt.mode}
              checked={selected === opt.mode}
              onChange={() => setDraft(opt.mode)}
              data-testid={`mail-port-exposure-${opt.mode}`}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {opt.title}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {opt.description}
              </div>
            </div>
          </label>
        ))}
      </div>

      {current.daemonSetStatus !== null && (() => {
        const ready = current.daemonSetStatus.ready;
        const desired = current.daemonSetStatus.desired;
        let dotColor: string;
        let detail: string;
        if (desired === 0) {
          dotColor = 'bg-red-500';
          detail = 'no nodes match the haproxy nodeSelector (mail-haproxy label missing on all nodes)';
        } else if (ready === desired) {
          dotColor = 'bg-green-500';
          detail = 'all pods ready';
        } else if (ready === 0) {
          dotColor = 'bg-red-500';
          detail = 'no pods ready — check pod events';
        } else {
          dotColor = 'bg-amber-500';
          detail = 'rolling out';
        }
        return (
          <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-4 py-3 text-sm">
            <span className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              haproxy DaemonSet
            </span>
            <div className="mt-1 flex items-center gap-2">
              <span className={`inline-block w-2 h-2 rounded-full ${dotColor}`} />
              <span
                data-testid="mail-port-exposure-ds-status"
                className="font-mono text-gray-900 dark:text-gray-100"
              >
                {ready}/{desired} pods ready
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-400">— {detail}</span>
            </div>
          </div>
        );
      })()}

      {hasChange && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>{selectedOption.switchWarning}</span>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={!hasChange || update.isPending}
          data-testid="mail-port-exposure-save"
          className="inline-flex items-center gap-2 rounded-lg border border-brand-500 bg-brand-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {update.isPending ? 'Applying…' : 'Apply'}
        </button>
        {!hasChange && (
          <p className="text-xs text-gray-500 dark:text-gray-400">No changes to apply.</p>
        )}
      </div>

      {saveSuccess && (
        <div
          role="status"
          data-testid="mail-port-exposure-success"
          className="flex items-start gap-2.5 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-3 py-2.5 text-sm text-green-800 dark:text-green-200"
        >
          <Check size={14} className="mt-0.5 shrink-0" />
          <span>Port exposure mode updated. Stalwart will restart to apply the change.</span>
        </div>
      )}

      {update.isError && (
        <div
          role="alert"
          data-testid="mail-port-exposure-error"
          className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {update.error instanceof Error ? update.error.message : 'Update failed — see server logs.'}
          </span>
        </div>
      )}

      {activeTaskId && (
        <MailTaskProgressModal
          taskId={activeTaskId}
          onClose={() => setActiveTaskId(null)}
        />
      )}

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mail-port-exposure-confirm-title"
        >
          <div className="relative w-full max-w-md bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
            <h3
              id="mail-port-exposure-confirm-title"
              className="text-lg font-semibold text-gray-900 dark:text-gray-100"
            >
              Switch to {selectedOption.title}?
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {selectedOption.switchWarning}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setConfirmOpen(false); setDraft(null); }}
                disabled={update.isPending}
                className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applyChange}
                disabled={update.isPending}
                data-testid="mail-port-exposure-confirm"
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-700 disabled:opacity-50"
              >
                {update.isPending && <Loader2 size={14} className="animate-spin" />}
                {update.isPending ? 'Applying…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
