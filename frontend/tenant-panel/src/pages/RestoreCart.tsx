/**
 * Tenant-side restore cart page.
 *
 * Pesto-MVP version (2026-05-28). Lets a tenant browse one bundle's
 * contents and select what to restore (files, mailboxes, individual
 * config-table rows / deployments / domains). Items go into a
 * "cart" — sequential executor walks them and surfaces per-item
 * status. Failures pause at the failed item.
 *
 * Wired to /api/v1/tenants/:tenantId/restore-carts/* — these endpoints
 * apply the tenant restore policy server-side (denied tables/columns
 * are blocked even if forged into the request).
 *
 * Future: lift into packages/ui-restore-cart workspace and share with
 * the admin panel (commit b57176fb's `assertOwnership` + the policy
 * module on the backend already enforce the boundary; the UI side
 * just needs the apiBase prop). For now this is a tenant-specific
 * simplified version that prioritizes shipping.
 */

import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowLeft, FileText, Mail, Folder, AlertCircle, CheckCircle2, Loader2, Play, RotateCcw } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';

type ItemType = 'files-paths' | 'mailboxes-by-address' | 'deployments-by-id' | 'domains-by-id' | 'config-tables';

interface CartItem {
  readonly id: string;
  readonly bundleId: string;
  readonly type: ItemType;
  readonly selector: unknown;
  readonly label: string | null;
  readonly seq: number;
  readonly status: 'pending' | 'applying' | 'done' | 'failed' | 'skipped';
  readonly lastError: string | null;
}

interface CartDetail {
  readonly id: string;
  readonly tenantId: string;
  readonly status: 'draft' | 'executing' | 'paused' | 'done' | 'failed';
  readonly items: ReadonlyArray<CartItem>;
  readonly lastError: string | null;
}

function tenantBase(tenantId: string): string {
  return `/api/v1/tenants/${tenantId}`;
}

export default function TenantRestoreCart() {
  const { bundleId } = useParams<{ bundleId: string }>();
  const tenantId = useAuth((s) => s.user?.tenantId) ?? '';
  const qc = useQueryClient();
  const [cartId, setCartId] = useState<string | null>(null);

  // Browse: config-tables list (allowed tables only, server filters).
  const tablesQ = useQuery({
    queryKey: ['tenant-bundle-browse', 'config-tables', bundleId],
    queryFn: () => apiFetch<{ data: { tables: Array<{ name: string; rowCount: number }> } }>(
      `${tenantBase(tenantId)}/bundles/${bundleId}/browse/config-tables`,
    ),
    enabled: Boolean(tenantId && bundleId),
  });

  const mailboxesQ = useQuery({
    queryKey: ['tenant-bundle-browse', 'mailboxes', bundleId],
    queryFn: () => apiFetch<{ data: { addresses: string[] } }>(
      `${tenantBase(tenantId)}/bundles/${bundleId}/browse/mailboxes`,
    ),
    enabled: Boolean(tenantId && bundleId),
  });

  const createCart = useMutation({
    mutationFn: async () => {
      const r = await apiFetch<{ data: { id: string } }>(
        `${tenantBase(tenantId)}/restore-carts`,
        {
          method: 'POST',
          body: JSON.stringify({ tenantId, description: `Tenant-initiated restore from ${bundleId}` }),
        },
      );
      return r.data.id;
    },
    onSuccess: (id) => setCartId(id),
  });

  const cartQ = useQuery({
    queryKey: ['tenant-restore-cart', cartId],
    queryFn: () => apiFetch<{ data: CartDetail }>(`${tenantBase(tenantId)}/restore-carts/${cartId}`),
    enabled: Boolean(tenantId && cartId),
    refetchInterval: (data) => {
      const status = (data as { state?: { data?: { data?: { status?: string } } } })?.state?.data?.data?.status;
      return status === 'executing' ? 2000 : false;
    },
  });

  const addItem = useMutation({
    mutationFn: (payload: { type: ItemType; selector: unknown; label?: string }) =>
      apiFetch(`${tenantBase(tenantId)}/restore-carts/${cartId}/items`, {
        method: 'POST',
        body: JSON.stringify({ ...payload, bundleId }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-restore-cart', cartId] }),
  });

  const execute = useMutation({
    mutationFn: () =>
      apiFetch(`${tenantBase(tenantId)}/restore-carts/${cartId}/execute`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-restore-cart', cartId] }),
  });

  if (!tenantId) {
    return <div className="p-6 text-sm text-red-600">Loading session…</div>;
  }
  if (!bundleId) {
    return <div className="p-6 text-sm text-red-600">No bundle id in URL</div>;
  }

  const cart = cartQ.data?.data;
  const allowedTables = tablesQ.data?.data?.tables ?? [];
  const addresses = mailboxesQ.data?.data?.addresses ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          to="/backups"
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <ArrowLeft size={12} /> Back to backups
        </Link>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400">
          <RotateCcw size={20} />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100" data-testid="restore-heading">
            Restore from bundle
          </h1>
          <p className="font-mono text-xs text-gray-500 dark:text-gray-400">{bundleId}</p>
        </div>
      </div>

      <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
        <AlertCircle className="mr-1 inline h-4 w-4" />
        Restoring will overwrite current data for the selected items.
        Files restores create a pre-restore snapshot first so the
        operation can be rolled back if needed. Some tables (billing,
        platform config) are not restorable from the tenant panel.
      </div>

      {!cartId && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <p className="mb-3 text-sm text-gray-700 dark:text-gray-300">
            Start by creating a restore cart. You can then add items
            to restore (files, mailboxes, database rows). Items are
            executed sequentially in the order added.
          </p>
          <button
            type="button"
            onClick={() => createCart.mutate()}
            disabled={createCart.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            data-testid="create-cart"
          >
            {createCart.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
            Start restore
          </button>
          {createCart.error && (
            <p className="mt-2 text-xs text-red-600">{(createCart.error as Error).message}</p>
          )}
        </div>
      )}

      {cartId && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Left: browse / picker */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <Folder className="h-4 w-4" /> Bundle contents
            </h2>

            <details className="mb-3" open>
              <summary className="cursor-pointer text-xs font-medium text-gray-700 dark:text-gray-300">
                Files ({bundleId})
              </summary>
              <button
                type="button"
                onClick={() =>
                  addItem.mutate({
                    type: 'files-paths',
                    selector: { kind: 'full' },
                    label: 'Restore all files',
                  })
                }
                disabled={cart?.status !== 'draft' || addItem.isPending}
                className="mt-2 inline-flex items-center gap-1 rounded-md border border-blue-300 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-950 disabled:opacity-50"
              >
                <FileText size={12} /> Restore full files snapshot
              </button>
            </details>

            <details className="mb-3">
              <summary className="cursor-pointer text-xs font-medium text-gray-700 dark:text-gray-300">
                Mailboxes ({addresses.length})
              </summary>
              {mailboxesQ.isLoading && <p className="mt-2 text-xs text-gray-500">Loading…</p>}
              <ul className="mt-2 space-y-1 text-xs">
                {addresses.map((addr) => (
                  <li key={addr} className="flex items-center justify-between">
                    <span className="text-gray-700 dark:text-gray-300">{addr}</span>
                    <button
                      type="button"
                      onClick={() =>
                        addItem.mutate({
                          type: 'mailboxes-by-address',
                          selector: {
                            kind: 'addresses',
                            addresses: [addr],
                            mode: 'merge-skip-duplicates',
                          },
                          label: `Restore mailbox ${addr}`,
                        })
                      }
                      disabled={cart?.status !== 'draft' || addItem.isPending}
                      className="rounded-md border border-blue-300 px-1.5 py-0.5 text-xs text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-950 disabled:opacity-50"
                    >
                      <Mail size={10} className="inline" /> add
                    </button>
                  </li>
                ))}
              </ul>
            </details>

            <details>
              <summary className="cursor-pointer text-xs font-medium text-gray-700 dark:text-gray-300">
                Database tables ({allowedTables.length}) — billing &amp; platform config filtered out
              </summary>
              {tablesQ.isLoading && <p className="mt-2 text-xs text-gray-500">Loading…</p>}
              <ul className="mt-2 space-y-1 text-xs">
                {allowedTables.map((t) => (
                  <li key={t.name} className="flex items-center justify-between">
                    <span className="text-gray-700 dark:text-gray-300">
                      <span className="font-mono">{t.name}</span> ({t.rowCount} rows)
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        addItem.mutate({
                          type: 'config-tables',
                          selector: { kind: 'tables', tables: [t.name] },
                          label: `Restore ${t.name}`,
                        })
                      }
                      disabled={cart?.status !== 'draft' || addItem.isPending}
                      className="rounded-md border border-blue-300 px-1.5 py-0.5 text-xs text-blue-700 hover:bg-blue-50 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-950 disabled:opacity-50"
                    >
                      add
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          </div>

          {/* Right: cart */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <Archive className="h-4 w-4" /> Restore cart
              {cart && (
                <span className={`ml-auto rounded-full px-2 py-0.5 text-xs ${cart.status === 'done' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : cart.status === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' : cart.status === 'executing' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}`}>
                  {cart.status}
                </span>
              )}
            </h2>

            {!cart?.items?.length && (
              <p className="text-xs text-gray-500 dark:text-gray-400">Cart is empty — add items from the left.</p>
            )}

            {cart && cart.items.length > 0 && (
              <ul className="space-y-2 text-xs">
                {cart.items.map((item) => (
                  <li key={item.id} className="flex items-start gap-2 rounded-md border border-gray-200 p-2 dark:border-gray-700">
                    <div className="mt-0.5 flex-shrink-0">
                      {item.status === 'done' && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                      {item.status === 'failed' && <AlertCircle className="h-4 w-4 text-red-600" />}
                      {item.status === 'applying' && <Loader2 className="h-4 w-4 animate-spin text-blue-600" />}
                      {item.status === 'pending' && <span className="h-4 w-4 rounded-full border border-gray-400" />}
                    </div>
                    <div className="flex-1">
                      <p className="font-medium text-gray-900 dark:text-gray-100">{item.label ?? item.type}</p>
                      <p className="text-gray-500 dark:text-gray-400">
                        {item.type} · seq {item.seq}
                      </p>
                      {item.lastError && (
                        <p className="mt-1 text-red-600">{item.lastError}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {cart && cart.items.length > 0 && cart.status === 'draft' && (
              <button
                type="button"
                onClick={() => execute.mutate()}
                disabled={execute.isPending}
                className="mt-3 inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                data-testid="execute-cart"
              >
                {execute.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Execute restore
              </button>
            )}

            {cart?.lastError && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200">
                {cart.lastError}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
