import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import type { TenantHealthEntry } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

/**
 * Guided recovery for a degraded tenant.
 *
 * Three steps — diagnose, choose, confirm — because the 2026-09-11 drill
 * showed the hard part is not executing a recovery but knowing WHICH one
 * applies. The recovery primitives all existed; nothing connected "this
 * tenant is down" to "press this".
 *
 * Only re-pin executes here. It moves no data and is reversible. Restoring
 * from a backup bundle is destructive and has its own established flow, so
 * this links to it rather than hiding a data-loss-capable operation behind a
 * modal button.
 */
interface Props {
  readonly entry: TenantHealthEntry;
  readonly onClose: () => void;
}

type Step = 'diagnose' | 'confirm' | 'done';

export default function TenantRecoveryWizard({ entry, onClose }: Props) {
  const [step, setStep] = useState<Step>('diagnose');
  const [targetNode, setTargetNode] = useState<string>('');
  const [reason, setReason] = useState('');
  const [typedName, setTypedName] = useState('');
  const queryClient = useQueryClient();
  const { data: nodesData } = useClusterNodes();

  const canRepin = entry.findings.some((f) => f.kind === 'workloads_pinned_to_down_node');
  const needsRestore = entry.findings.some((f) => f.kind === 'volume_last_replica_on_down_node');
  const mailOnly = entry.mailAffected && !entry.hostingAffected;

  // Only offer nodes that can actually take the workload. A pin to a NotReady
  // node turns "degraded" into "permanently unschedulable".
  const candidates = (nodesData?.data ?? []).filter((n) => {
    const ready = n.statusConditions?.find((c) => c.type === 'Ready')?.status === 'True';
    return ready && n.name !== entry.pinnedNode;
  });

  const repin = useMutation({
    mutationFn: () => apiFetch(`/api/v1/admin/tenants/${entry.tenantId}/recover/repin`, {
      method: 'POST',
      body: JSON.stringify({ targetNode, confirm: true, reason }),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cluster', 'outage-impact'] });
      void queryClient.invalidateQueries({ queryKey: ['tenants'] });
      setStep('done');
    },
  });

  const confirmed = typedName.trim() === entry.tenantName.trim() && reason.trim().length >= 3;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Recover ${entry.tenantName}`}
      data-testid="tenant-recovery-wizard"
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-xl dark:bg-gray-900">
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Recover {entry.tenantName}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {step === 'diagnose' && (
            <>
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  What is wrong
                </h3>
                <ul className="space-y-1.5">
                  {entry.findings.map((f) => (
                    <li key={f.kind} className="text-sm text-gray-700 dark:text-gray-300">
                      • {f.detail}
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  What you can do
                </h3>

                {canRepin && (
                  <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      Move the tenant to a healthy node
                    </p>
                    <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
                      {needsRestore
                        ? 'Its workloads will schedule again, but volumes whose only replica was on the offline node will still be unavailable — moving the pin does not move data.'
                        : 'Its workloads will schedule on the new node. No data is moved, and you can pin it back afterwards.'}
                    </p>
                    <label className="mt-2 block text-xs text-gray-600 dark:text-gray-400">
                      Target node
                      <select
                        value={targetNode}
                        onChange={(e) => setTargetNode(e.target.value)}
                        data-testid="recovery-target-node"
                        className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                      >
                        <option value="">Automatic — let the scheduler choose</option>
                        {candidates.map((n) => (
                          <option key={n.name} value={n.name}>{n.name}</option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => setStep('confirm')}
                      data-testid="recovery-choose-repin"
                      className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                    >
                      Continue <ArrowRight size={14} />
                    </button>
                  </div>
                )}

                {needsRestore && (
                  <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-900/20">
                    <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      Restore data from the latest backup
                    </p>
                    <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">
                      Volumes with no surviving replica cannot be recovered by moving the tenant —
                      the data itself has to come back from a bundle. That flow is destructive and
                      is driven from the backups page.
                    </p>
                    <Link
                      to="/backups/tenants"
                      className="mt-2 inline-block text-xs font-medium text-amber-900 underline dark:text-amber-200"
                    >
                      Go to tenant backups →
                    </Link>
                  </div>
                )}

                {mailOnly && (
                  <div className="mt-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      Fail mail over
                    </p>
                    <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
                      This tenant&rsquo;s hosting is fine — only mail is affected, and mail is
                      shared by every tenant. Failing the mail stack over fixes it for all of them
                      at once.
                    </p>
                    <Link
                      to="/email/operations"
                      className="mt-2 inline-block text-xs font-medium text-blue-700 underline dark:text-blue-400"
                    >
                      Go to mail operations →
                    </Link>
                  </div>
                )}

                {!canRepin && !needsRestore && !mailOnly && (
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                    Nothing here needs an operator decision — the platform resolves these on its own.
                  </p>
                )}
              </section>
            </>
          )}

          {step === 'confirm' && (
            <>
              <p className="text-sm text-gray-700 dark:text-gray-300">
                {targetNode
                  ? <>Move <strong>{entry.tenantName}</strong> from <code>{entry.pinnedNode}</code> to <code>{targetNode}</code>.</>
                  : <>Clear <strong>{entry.tenantName}</strong>&rsquo;s pin on <code>{entry.pinnedNode}</code> and let the scheduler place it.</>}
              </p>
              <label className="block text-xs text-gray-600 dark:text-gray-400">
                Reason (recorded in the audit log)
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  data-testid="recovery-reason"
                  className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                  placeholder="e.g. node-c lost, moving tenant to restore service"
                />
              </label>
              <label className="block text-xs text-gray-600 dark:text-gray-400">
                Type the tenant name <strong>{entry.tenantName}</strong> to confirm
                <input
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  data-testid="recovery-confirm-name"
                  className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                />
              </label>

              {repin.isError && <ErrorPanel error={extractOperatorError(repin.error)} testId="recovery-error" />}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setStep('diagnose')}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={!confirmed || repin.isPending}
                  onClick={() => repin.mutate()}
                  data-testid="recovery-execute"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {repin.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                  {repin.isPending ? 'Moving…' : 'Move tenant'}
                </button>
              </div>
            </>
          )}

          {step === 'done' && (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm text-green-800 dark:text-green-300">
                <CheckCircle2 size={16} aria-hidden="true" />
                <span>
                  <strong>{entry.tenantName}</strong> was moved.
                  {' '}Its pods will reschedule over the next minute or two.
                </span>
              </p>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                The tenant stays listed as degraded until its pods report Ready again.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-gray-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
