/**
 * The recovery's restore cart, item by item — polled while it runs, so the
 * operator sees which item is applying and, on a failure, which one stopped
 * and with what error.
 */

import { Loader2 } from 'lucide-react';
import type { RestoreItemStatus, RestoreItemType, RestoreJobStatus } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { isTerminalCartStatus, useLiveRestoreCart } from '@/hooks/use-dr-recover';

const ITEM_TYPE_LABEL: Record<RestoreItemType, string> = {
  'files-paths': 'Files',
  'mailboxes-by-address': 'Mailboxes',
  'deployments-by-id': 'Deployments',
  'databases-by-id': 'Databases',
  'domains-by-id': 'Domains',
  'config-tables': 'Config',
};

const ITEM_STATUS_BADGE: Record<RestoreItemStatus, string> = {
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  applying: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  done: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  skipped: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
};

export const CART_STATUS_BADGE: Record<RestoreJobStatus, string> = {
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  executing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  done: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

export default function RestoreItemsTable({ cartId }: { readonly cartId: string }) {
  const live = useLiveRestoreCart(cartId);
  const cart = live.data?.data ?? null;
  const polling = cart != null && !isTerminalCartStatus(cart.status);

  return (
    <section className="rounded-lg border border-gray-200 dark:border-gray-700" data-testid="dr-recover-items">
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Restore items</h3>
        <div className="flex items-center gap-2">
          {cart && (
            <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${CART_STATUS_BADGE[cart.status]}`}>
              {cart.status}
            </span>
          )}
          {polling && <Loader2 size={14} className="animate-spin text-gray-400 dark:text-gray-500" aria-hidden />}
        </div>
      </div>

      {live.error && (
        <div className="p-3">
          <ErrorPanel error={extractOperatorError(live.error)} severity="error" compact testId="dr-recover-items-error" />
        </div>
      )}
      {!live.error && !cart && (
        <p className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">Loading the restore…</p>
      )}
      {cart && cart.items.length === 0 && (
        <p className="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">No items queued yet.</p>
      )}
      {cart && cart.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="dr-recover-progress-table">
            <thead className="text-left text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-1.5">#</th>
                <th className="px-3 py-1.5">Type</th>
                <th className="px-3 py-1.5">Status</th>
                <th className="px-3 py-1.5">Progress</th>
              </tr>
            </thead>
            <tbody>
              {[...cart.items].sort((a, b) => a.seq - b.seq).map((item) => (
                <tr key={item.id} className="border-t border-gray-200/60 dark:border-gray-700/40" data-testid={`dr-recover-item-${item.seq}`}>
                  <td className="px-3 py-1.5 tabular-nums text-gray-500 dark:text-gray-400">{item.seq}</td>
                  <td className="px-3 py-1.5 text-gray-900 dark:text-gray-100">{ITEM_TYPE_LABEL[item.type]}</td>
                  <td className="px-3 py-1.5">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${ITEM_STATUS_BADGE[item.status]}`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-gray-600 dark:text-gray-400">
                    {item.progressMessage ?? item.lastError ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
