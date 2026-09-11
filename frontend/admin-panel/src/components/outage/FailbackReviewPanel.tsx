import { useState } from 'react';
import { Undo2, ArrowRight, Check, Loader2 } from 'lucide-react';
import {
  useFailbackReview,
  useAcknowledgeFailback,
  type FailbackReviewItem,
} from '@/hooks/use-failback-review';
import FailbackRepinDialog from './FailbackRepinDialog';

/**
 * "This node is back — these tenants are still somewhere else."
 *
 * The 2026-09-11 drill covered the outage thoroughly and the RETURN not at
 * all. When a node came back, the placement changes made while it was down
 * simply became permanent: HA-tier tenants stayed unpinned, local-tier
 * tenants stayed on whichever node the operator moved them to, and nothing
 * anywhere said so. The returned node looked perfectly healthy while sitting
 * empty, and an operator who had pinned a tenant deliberately had that intent
 * erased without a word.
 *
 * This is a review rather than an automatic failback. Moving storage back is
 * real data movement with no urgency behind it, and for an HA-tier tenant the
 * unpinned state is usually the better one — so the platform states what
 * changed, says which way it leans, and leaves the call to the operator. The
 * same stance as mail failover, which is never switched on automatically.
 */
export default function FailbackReviewPanel() {
  const { data, isLoading } = useFailbackReview();
  const ack = useAcknowledgeFailback();
  const [wizardFor, setWizardFor] = useState<FailbackReviewItem | null>(null);
  const [ackFor, setAckFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const review = data?.data;
  // Nothing displaced is the normal case — render nothing rather than an
  // empty-state card the operator has to read past on every visit.
  if (isLoading || !review || review.items.length === 0) {
    // A read failure must not look like "nothing to review".
    if (review?.readError) {
      return (
        <div
          data-testid="failback-review-panel"
          className="rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700 dark:border-slate-600 dark:bg-slate-800/50 dark:text-slate-300"
        >
          Placement review unavailable — {review.readError}. Tenants displaced during a
          past outage may not be listed.
        </div>
      );
    }
    return null;
  }

  const submitAck = (tenantId: string) => {
    ack.mutate(
      { tenantId, reason: reason.trim() },
      { onSuccess: () => { setAckFor(null); setReason(''); } },
    );
  };

  return (
    <div
      data-testid="failback-review-panel"
      className="rounded-lg border border-sky-300 bg-sky-50 dark:border-sky-700 dark:bg-sky-900/25"
    >
      <div className="flex items-start gap-2 border-b border-sky-200 px-4 py-3 dark:border-sky-800">
        <Undo2 size={16} className="mt-0.5 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden="true" />
        <div className="text-sm text-sky-900 dark:text-sky-100">
          <strong>
            {review.returnedNodes.length === 1
              ? `${review.returnedNodes[0]} is back online.`
              : `${review.returnedNodes.join(', ')} are back online.`}
          </strong>{' '}
          {review.items.length} tenant{review.items.length === 1 ? ' is' : 's are'} still
          placed elsewhere after the outage. Nothing moves back on its own — review each one.
        </div>
      </div>

      <ul className="divide-y divide-sky-200 dark:divide-sky-800">
        {review.items.map((item) => (
          <li key={item.tenantId} data-testid={`failback-item-${item.tenantId}`} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-slate-900 dark:text-slate-100">{item.tenantName}</span>
              <span className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400">
                {item.movedFromNode}
                <ArrowRight size={12} aria-hidden="true" />
                {item.currentNode ?? 'unpinned'}
              </span>
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                {item.storageTier} tier
              </span>
              <span className="rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                moved {item.movedBy === 'auto' ? 'automatically' : 'by an operator'}
              </span>
              <span
                className={
                  item.recommendation === 'keep_current_placement'
                    ? 'rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200'
                    : 'rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/50 dark:text-amber-200'
                }
              >
                {item.recommendation === 'keep_current_placement' ? 'Keep as is' : 'Consider re-pinning'}
              </span>
            </div>

            <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{item.detail}</p>

            {ackFor === item.tenantId ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  autoFocus
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is the current placement fine?"
                  className="min-w-[16rem] flex-1 rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                />
                <button
                  type="button"
                  disabled={reason.trim().length < 3 || ack.isPending}
                  onClick={() => submitAck(item.tenantId)}
                  data-testid={`failback-ack-confirm-${item.tenantId}`}
                  className="inline-flex items-center gap-1 rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-sky-500"
                >
                  {ack.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  Confirm
                </button>
                <button
                  type="button"
                  onClick={() => { setAckFor(null); setReason(''); }}
                  className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setWizardFor(item)}
                  data-testid={`failback-repin-${item.tenantId}`}
                  className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  Change placement…
                </button>
                <button
                  type="button"
                  onClick={() => setAckFor(item.tenantId)}
                  data-testid={`failback-ack-${item.tenantId}`}
                  className="rounded px-2 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100 dark:text-sky-300 dark:hover:bg-sky-800/50"
                >
                  Accept current placement
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {wizardFor && (
        <FailbackRepinDialog item={wizardFor} onClose={() => setWizardFor(null)} />
      )}
    </div>
  );
}
