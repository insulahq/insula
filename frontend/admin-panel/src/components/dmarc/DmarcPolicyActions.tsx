import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldCheck, Undo2 } from 'lucide-react';
import type { ApplyDmarcPolicyResponse, DmarcDomainSummary, DmarcPolicyValue } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

const ORDER: readonly DmarcPolicyValue[] = ['none', 'quarantine', 'reject'];

const EFFECT: Record<DmarcPolicyValue, string> = {
  none: 'Receivers only report mail that fails DMARC; nothing is filtered.',
  quarantine: 'Receivers send mail that fails DMARC to spam.',
  reject: 'Receivers refuse mail that fails DMARC outright.',
};

interface DmarcPolicyActionsProps {
  readonly summary: DmarcDomainSummary;
  /** POST endpoint of this panel's apply action. */
  readonly endpoint: string;
  /** Query to refresh after a change. */
  readonly invalidateKey: readonly unknown[];
}

/**
 * Acting on the DMARC recommendation: apply the recommended tightening, or
 * step back one level. The server re-checks the recommendation, so this only
 * offers what it will accept; stepping back is always possible, because it is
 * the way out when legitimate mail starts landing in spam.
 */
export default function DmarcPolicyActions({ summary, endpoint, invalidateKey }: DmarcPolicyActionsProps) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<DmarcPolicyValue | null>(null);
  const apply = useMutation({
    mutationFn: (policy: DmarcPolicyValue) => apiFetch<{ data: ApplyDmarcPolicyResponse }>(endpoint, {
      method: 'POST',
      body: JSON.stringify({ domain: summary.policyDomain, policy }),
    }),
    onSuccess: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: [...invalidateKey] });
    },
  });

  const published = summary.managedPolicy;
  if (published === null) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400" data-testid={`dmarc-unmanaged-${summary.policyDomain}`}>
        The <code className="font-mono">_dmarc</code> record of this domain is not managed by the platform — change its
        policy at the domain&apos;s DNS provider.
      </p>
    );
  }

  const rec = summary.recommendation;
  const nextStep = ORDER[ORDER.indexOf(published) + 1] ?? null;
  const tighten = rec.ready && rec.recommendedPolicy !== null && rec.recommendedPolicy === nextStep
    ? rec.recommendedPolicy : null;
  const stepBack = ORDER[ORDER.indexOf(published) - 1] ?? null;
  const lagging = summary.currentPolicy !== null && summary.currentPolicy !== published;
  const result = apply.data?.data;

  return (
    <div className="space-y-2" data-testid={`dmarc-actions-${summary.policyDomain}`}>
      {lagging && (
        <p className="text-xs text-gray-600 dark:text-gray-400" data-testid={`dmarc-lagging-${summary.policyDomain}`}>
          p={published} is published; the reports still show p={summary.currentPolicy} — they catch up within a day.
        </p>
      )}

      {confirming ? (
        <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-900 dark:text-amber-200">
          <p>
            Publish <strong>p={confirming}</strong> for {summary.policyDomain}? {EFFECT[confirming]}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => apply.mutate(confirming)}
              disabled={apply.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid={`dmarc-confirm-${summary.policyDomain}`}
            >
              {apply.isPending && <Loader2 size={12} className="animate-spin" />} Publish p={confirming}
            </button>
            <button
              type="button"
              onClick={() => { setConfirming(null); apply.reset(); }}
              disabled={apply.isPending}
              className="rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {tighten && (
            <button
              type="button"
              onClick={() => setConfirming(tighten)}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-600"
              data-testid={`dmarc-apply-${summary.policyDomain}`}
            >
              <ShieldCheck size={13} /> Apply p={tighten}
            </button>
          )}
          {stepBack && (
            <button
              type="button"
              onClick={() => setConfirming(stepBack)}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50"
              data-testid={`dmarc-step-back-${summary.policyDomain}`}
            >
              <Undo2 size={13} /> Step back to p={stepBack}
            </button>
          )}
        </div>
      )}

      {apply.error && <ErrorPanel error={extractOperatorError(apply.error)} compact testId={`dmarc-apply-error-${summary.policyDomain}`} />}
      {result && !result.published && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid={`dmarc-publish-manually-${summary.policyDomain}`}>
          This domain&apos;s DNS is hosted elsewhere — publish it there:{' '}
          <code className="break-all font-mono">{result.recordName} TXT &quot;{result.recordValue}&quot;</code>
        </p>
      )}
      {result && result.published && (
        <p className="text-xs text-emerald-700 dark:text-emerald-400" data-testid={`dmarc-applied-${summary.policyDomain}`}>
          p={result.policy} is published.
        </p>
      )}
    </div>
  );
}
