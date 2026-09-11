import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import type { FailbackReviewItem } from '@/hooks/use-failback-review';

interface Props {
  readonly item: FailbackReviewItem;
  readonly onClose: () => void;
}

/**
 * Move a tenant's placement back after its node has returned.
 *
 * Deliberately NOT the outage recovery wizard. That wizard's whole frame is
 * "your node is dead, here is how to get this tenant serving again" — it
 * diagnoses findings, excludes the down node, and pushes toward urgency. A
 * failback is the opposite situation: the cluster is healthy, nothing is
 * broken, and the operator is making an unhurried placement decision. Reusing
 * the wizard here would have told them a node was down when none was.
 *
 * Same endpoint, same confirmation discipline (typed name + reason), because
 * this still moves volume data.
 */
export default function FailbackRepinDialog({ item, onClose }: Props) {
  const [targetNode, setTargetNode] = useState<string>(item.movedFromNode);
  const [reason, setReason] = useState('');
  const [typedName, setTypedName] = useState('');
  const queryClient = useQueryClient();
  const { data: nodesData } = useClusterNodes();

  const candidates = (nodesData?.data ?? []).filter(
    (n) => n.statusConditions?.find((c) => c.type === 'Ready')?.status === 'True',
  );

  const repin = useMutation({
    mutationFn: () => apiFetch(`/api/v1/admin/tenants/${item.tenantId}/recover/repin`, {
      method: 'POST',
      body: JSON.stringify({ targetNode, confirm: true, reason }),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cluster', 'failback-review'] });
      void queryClient.invalidateQueries({ queryKey: ['cluster', 'outage-impact'] });
      void queryClient.invalidateQueries({ queryKey: ['tenants'] });
      onClose();
    },
  });

  const confirmed = typedName.trim() === item.tenantName.trim() && reason.trim().length >= 3;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Change placement for ${item.tenantName}`}
      data-testid="failback-repin-dialog"
    >
      <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl dark:bg-slate-900">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          Change placement — {item.tenantName}
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Currently {item.currentNode ? `pinned to ${item.currentNode}` : 'unpinned'}. This moves the
          tenant&rsquo;s volume data, so it will take time proportional to the volume size and the
          tenant may be briefly unavailable.
        </p>

        <label className="mt-4 block text-sm font-medium text-slate-700 dark:text-slate-200">
          Target node
          <select
            value={targetNode}
            onChange={(e) => setTargetNode(e.target.value)}
            data-testid="failback-target-node"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">Unpinned — let the scheduler place it</option>
            {candidates.map((n) => (
              <option key={n.name} value={n.name}>
                {n.name}
                {n.name === item.movedFromNode ? ' (original node, now back online)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="mt-3 block text-sm font-medium text-slate-700 dark:text-slate-200">
          Reason
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this placement being changed?"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
        </label>

        <label className="mt-3 block text-sm font-medium text-slate-700 dark:text-slate-200">
          Type <span className="font-mono">{item.tenantName}</span> to confirm
          <input
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            data-testid="failback-confirm-name"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
        </label>

        {repin.isError && (
          <div className="mt-3">
            <ErrorPanel error={extractOperatorError(repin.error)} testId="failback-repin-error" />
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!confirmed || repin.isPending}
            onClick={() => repin.mutate()}
            data-testid="failback-repin-submit"
            className="inline-flex items-center gap-1.5 rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-sky-500"
          >
            {repin.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            Move placement
          </button>
        </div>
      </div>
    </div>
  );
}
