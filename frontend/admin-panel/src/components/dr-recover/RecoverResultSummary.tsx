/**
 * What a finished recovery did — the bundle and restore it used, whether the
 * tenant had to be re-created, what the post-restore reconcile re-established,
 * and the manual steps it could not close on its own.
 */

import { ArrowRight, ShieldAlert } from 'lucide-react';
import type { DrRecoverResponse } from '@insula/api-contracts';

const RECONCILE_BADGE: Record<'ok' | 'bad' | 'muted', string> = {
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  bad: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  muted: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
};

function badge(kind: 'ok' | 'bad' | 'muted'): string {
  return `inline-block rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${RECONCILE_BADGE[kind]}`;
}

const COMPONENT_LABEL: Record<string, string> = { config: 'Config', files: 'Files', mailboxes: 'Mailboxes' };

export default function RecoverResultSummary({ result }: { readonly result: DrRecoverResponse }) {
  return (
    <section className="space-y-3" data-testid="dr-recover-result">
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Restored</dt>
          <dd className="text-gray-900 dark:text-gray-100">{result.components.map((c) => COMPONENT_LABEL[c] ?? c).join(' → ') || '—'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Re-provisioned</dt>
          <dd className="text-gray-900 dark:text-gray-100">{result.provisioned ? 'yes' : 'no'}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Bundle</dt>
          <dd className="break-all font-mono text-xs text-gray-900 dark:text-gray-100">{result.bundleId}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Restore</dt>
          <dd className="break-all font-mono text-xs text-gray-900 dark:text-gray-100" data-testid="dr-recover-cart-id">{result.cartId}</dd>
        </div>
      </dl>

      {result.recreated && (
        <div
          className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
          data-testid="dr-recover-recreated"
        >
          <ShieldAlert size={16} className="mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-semibold">Tenant re-created from the bundle</p>
            <p className="mt-0.5">
              The tenant row was absent — it was re-created (original tenant ID + namespace preserved) before the
              restore. Review the remaining manual steps below.
            </p>
          </div>
        </div>
      )}

      {result.reconcile && (
        <div
          className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40"
          data-testid="dr-recover-reconcile"
        >
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Services re-established</h4>
          <ul className="mt-1.5 space-y-1 text-sm text-gray-700 dark:text-gray-300">
            <li className="flex items-center gap-2">
              <span className={badge(result.reconcile.ingress === 'reconciled' ? 'ok' : result.reconcile.ingress === 'failed' ? 'bad' : 'muted')}>
                {result.reconcile.ingress}
              </span>
              Ingress routes rebuilt
            </li>
            <li className="flex items-center gap-2">
              <span className={badge(result.reconcile.mail.failed > 0 ? 'bad' : 'ok')}>
                {result.reconcile.mail.dkimRegenerated}/{result.reconcile.mail.domainsTotal}
              </span>
              Mail domains DKIM-resigned{result.reconcile.mail.failed > 0 ? ` — ${result.reconcile.mail.failed} failed` : ''}
            </li>
            <li className="flex items-center gap-2">
              <span className={badge(result.reconcile.workloads.failed > 0 ? 'bad' : 'ok')}>
                {result.reconcile.workloads.redeployed}/{result.reconcile.workloads.total}
              </span>
              Workloads redeployed{result.reconcile.workloads.failed > 0 ? ` — ${result.reconcile.workloads.failed} failed` : ''}
            </li>
          </ul>
        </div>
      )}

      {result.residualGaps.length > 0 && (
        <div data-testid="dr-recover-residual-gaps">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100">
            <ArrowRight size={14} /> Remaining manual steps
          </h4>
          <ul className="mt-1.5 list-disc space-y-1 pl-6 text-sm text-gray-700 dark:text-gray-300">
            {result.residualGaps.map((gap, i) => (
              <li key={i}>{gap}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
