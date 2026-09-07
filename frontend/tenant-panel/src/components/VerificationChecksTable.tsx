import { CheckCircle2, AlertCircle } from 'lucide-react';
import type { VerificationCheck } from '@insula/api-contracts';

const CHECK_LABELS: Record<string, string> = {
  ns_delegation: 'Nameserver delegation',
  cname_to_ingress: 'Resolves to platform',
  axfr_sync: 'AXFR zone transfer',
};

/**
 * EXPECTED vs ACTUAL for every check — including the ones that PASSED.
 *
 * A pass used to render as the words "DNS verification passed" and nothing
 * else, which is how a check that asserted nothing went unnoticed on
 * production: with no platform nameservers configured the comparison was
 * vacuously true, and the UI had no way to show that the expected side was
 * empty. Displaying both columns makes an empty expectation self-evident.
 */
export function VerificationChecksTable({ checks }: { checks: readonly VerificationCheck[] }) {
  const withData = checks.filter((c) => c.expected !== undefined || c.actual !== undefined);
  if (withData.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700" data-testid="verify-checks-table">
      <table className="w-full text-left text-xs">
        <thead className="bg-gray-50 dark:bg-gray-700/50">
          <tr className="text-gray-600 dark:text-gray-300">
            <th scope="col" className="px-3 py-2 font-medium">Check</th>
            <th scope="col" className="px-3 py-2 font-medium">Expected</th>
            <th scope="col" className="px-3 py-2 font-medium">Actual</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {withData.map((c) => (
            <tr key={c.type} className="align-top text-gray-700 dark:text-gray-300" data-testid={`verify-check-${c.type}`}>
              <td className="px-3 py-2 whitespace-nowrap">
                <span className="flex items-center gap-1.5">
                  {c.status === 'pass'
                    ? <CheckCircle2 size={13} className="shrink-0 text-green-500 dark:text-green-400" aria-label="pass" />
                    : <AlertCircle size={13} className="shrink-0 text-red-500 dark:text-red-400" aria-label="fail" />}
                  {CHECK_LABELS[c.type] ?? c.type}
                </span>
              </td>
              <td className="px-3 py-2 font-mono break-all" data-testid={`verify-expected-${c.type}`}>
                {c.expected && c.expected.length > 0
                  ? c.expected.join(', ')
                  : <span className="font-sans italic text-amber-600 dark:text-amber-400">not configured</span>}
              </td>
              <td className="px-3 py-2 font-mono break-all" data-testid={`verify-actual-${c.type}`}>
                {c.actual && c.actual.length > 0
                  ? c.actual.join(', ')
                  : <span className="font-sans italic text-gray-500 dark:text-gray-400">none found</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
