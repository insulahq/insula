import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react';
import type { ApplyDmarcPolicyResponse, DmarcDomainSummary, DmarcPolicyValue } from '@insula/api-contracts';
import { apiFetch } from '@/lib/api-client';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';

const ORDER: readonly DmarcPolicyValue[] = ['none', 'quarantine', 'reject'];

const OPTIONS: ReadonlyArray<{ readonly value: DmarcPolicyValue; readonly label: string; readonly title: string }> = [
  { value: 'none', label: 'NONE', title: 'p=none — receivers only report mail that fails DMARC; nothing is filtered.' },
  { value: 'quarantine', label: 'QUARANTINE', title: 'p=quarantine — receivers send mail that fails DMARC to spam.' },
  { value: 'reject', label: 'REJECT', title: 'p=reject — receivers refuse mail that fails DMARC outright.' },
];

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
 * The published DMARC policy as a NONE / QUARANTINE / REJECT switch, always
 * shown. It used to offer only "apply the recommended step" or "step back", so
 * a domain at p=none whose reports did not back a tightening yet showed no
 * control at all. Loosening publishes after a confirmation; a tightening the
 * reports do not back shows their reason first and is sent as acknowledged —
 * the server refuses it otherwise.
 */
export default function DmarcPolicyActions({ summary, endpoint, invalidateKey }: DmarcPolicyActionsProps) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<DmarcPolicyValue | null>(null);
  const domain = summary.policyDomain;
  const published = summary.managedPolicy;
  const rec = summary.recommendation;
  const nextStep = published ? ORDER[ORDER.indexOf(published) + 1] ?? null : null;
  const recommended = rec.ready && rec.recommendedPolicy !== null && rec.recommendedPolicy === nextStep
    ? rec.recommendedPolicy : null;
  const notBacked = (p: DmarcPolicyValue): boolean =>
    published !== null && ORDER.indexOf(p) > ORDER.indexOf(published) && p !== recommended;
  /** Why the reports do not back `p` — the recommendation's own reason only when it is about `p`. */
  const notBackedReason = (p: DmarcPolicyValue): string => {
    if (recommended) return `They back ${recommended.toUpperCase()} first; ${p.toUpperCase()} skips a step.`;
    if (rec.ready && rec.recommendedPolicy !== null && rec.recommendedPolicy === published) {
      return `p=${published} is published but not yet in the reports; wait for them to confirm it before going further.`;
    }
    return rec.reason;
  };

  const apply = useMutation({
    mutationFn: (policy: DmarcPolicyValue) => apiFetch<{ data: ApplyDmarcPolicyResponse }>(endpoint, {
      method: 'POST',
      body: JSON.stringify(notBacked(policy)
        ? { domain, policy, acknowledgeNotRecommended: true }
        : { domain, policy }),
    }),
    onSuccess: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: [...invalidateKey] });
    },
  });

  const blocked = summary.managedRecordCount > 1 ? (
    <p className="text-xs text-amber-700 dark:text-amber-400" data-testid={`dmarc-duplicate-${domain}`}>
      This domain has {summary.managedRecordCount} <code className="font-mono">_dmarc</code> records. Receivers
      ignore a policy published twice — <strong>Re-create mail records</strong> on the Settings &amp; DNS tab keeps
      one, at the stricter policy.
    </p>
  ) : published === null ? (
    <p className="text-xs text-gray-500 dark:text-gray-400" data-testid={`dmarc-unmanaged-${domain}`}>
      The platform has no <code className="font-mono">_dmarc</code> record for this domain. If its DNS is hosted
      elsewhere, change the policy at that DNS provider; if it is hosted here, <strong>Re-create mail records</strong>{' '}
      on the Settings &amp; DNS tab restores the record.
    </p>
  ) : null;

  const lagging = published !== null && summary.currentPolicy !== null && summary.currentPolicy !== published;
  const result = apply.data?.data;

  return (
    <div className="space-y-2" data-testid={`dmarc-actions-${domain}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="radiogroup"
          aria-label={`DMARC policy for ${domain}`}
          className="inline-flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-600"
          data-testid={`dmarc-policy-switch-${domain}`}
        >
          {OPTIONS.map((o) => {
            const selected = published === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={blocked !== null || apply.isPending}
                title={o.value === recommended ? `${o.title} Recommended: the reports back this step.` : o.title}
                onClick={() => { if (!selected) { apply.reset(); setConfirming(o.value); } }}
                className={`inline-flex items-center gap-1 border-r border-gray-300 px-3 py-1.5 text-xs font-semibold last:border-r-0 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 ${
                  selected
                    ? 'bg-brand-500 text-white'
                    : 'bg-white text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700/50'
                }`}
                data-testid={`dmarc-policy-option-${domain}-${o.value}`}
              >
                {o.value === recommended && <ShieldCheck size={12} className="text-emerald-600 dark:text-emerald-400" />}
                {o.label}
              </button>
            );
          })}
        </div>
        {recommended && (
          <span className="text-xs text-emerald-700 dark:text-emerald-400" data-testid={`dmarc-recommended-${domain}`}>
            The reports back moving to {recommended.toUpperCase()}.
          </span>
        )}
      </div>

      {blocked}

      {lagging && (
        <p className="text-xs text-gray-600 dark:text-gray-400" data-testid={`dmarc-lagging-${domain}`}>
          p={published} is published; the reports still show p={summary.currentPolicy} — they catch up within a day.
        </p>
      )}

      {confirming && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          <p>
            Publish <strong>p={confirming}</strong> for {domain}? {EFFECT[confirming]}
          </p>
          {notBacked(confirming) && (
            <p className="mt-2 flex items-start gap-1.5 text-xs" data-testid={`dmarc-not-backed-${domain}`}>
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>The reports do not back this yet. {notBackedReason(confirming)}</span>
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => apply.mutate(confirming)}
              disabled={apply.isPending}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid={`dmarc-confirm-${domain}`}
            >
              {apply.isPending && <Loader2 size={12} className="animate-spin" />}
              Publish p={confirming}{notBacked(confirming) ? ' anyway' : ''}
            </button>
            <button
              type="button"
              onClick={() => { setConfirming(null); apply.reset(); }}
              disabled={apply.isPending}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {apply.error && <ErrorPanel error={extractOperatorError(apply.error)} compact testId={`dmarc-apply-error-${domain}`} />}
      {result && !result.published && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid={`dmarc-publish-manually-${domain}`}>
          This domain&apos;s DNS is hosted elsewhere — publish it there:{' '}
          <code className="break-all font-mono">{result.recordName} TXT &quot;{result.recordValue}&quot;</code>
        </p>
      )}
      {result && result.published && (
        <p className="text-xs text-emerald-700 dark:text-emerald-400" data-testid={`dmarc-applied-${domain}`}>
          p={result.policy} is published.
        </p>
      )}
    </div>
  );
}
