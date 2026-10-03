import { AlertTriangle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import type { DrRecoveryBundle, DrRecoveryInfo } from '@insula/api-contracts';
import NodeName from '@/components/nodes/NodeName';
import { formatBytes } from '@/lib/format-snapshot-size';

const utc = (iso: string): string => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

function age(iso: string, now = Date.now()): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-900 dark:text-gray-100">{children}</dd>
    </div>
  );
}

/**
 * The tenant being recovered — plan, tier, node, namespace, resources — so
 * the operator sees WHAT comes back before running it. A deleted tenant's
 * facts are read from the chosen bundle's manifest.
 */
export function TenantFacts({ info, loading }: { readonly info: DrRecoveryInfo | null; readonly loading: boolean }) {
  if (loading && !info) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 size={14} className="animate-spin" /> Reading the tenant…
      </div>
    );
  }
  if (!info) return null;
  const dash = <span className="text-gray-400 dark:text-gray-500">—</span>;
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40" data-testid="dr-recover-facts">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Fact label="Tenant">
          <span className="font-medium">{info.name}</span>
          {info.deleted
            ? <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300">deleted{info.deletedAt ? ` ${info.deletedAt.slice(0, 10)}` : ''}</span>
            : info.status && <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-[11px] text-gray-700 dark:bg-gray-700 dark:text-gray-300">{info.status}</span>}
        </Fact>
        <Fact label="Plan">{info.planName ?? dash}</Fact>
        <Fact label="Storage tier">{info.storageTier ?? dash}</Fact>
        <Fact label="Primary node">{info.primaryNode ? <NodeName name={info.primaryNode} /> : dash}</Fact>
        <Fact label="Namespace">
          {info.namespace
            ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="font-mono text-xs">{info.namespace}</span>
                {info.namespacePresent === true && info.namespaceTerminating && <span className="inline-flex items-center gap-0.5 text-xs text-amber-700 dark:text-amber-400"><Loader2 size={12} className="animate-spin" /> being deleted</span>}
                {info.namespacePresent === true && !info.namespaceTerminating && <span className="inline-flex items-center gap-0.5 text-xs text-green-700 dark:text-green-400"><CheckCircle2 size={12} /> exists</span>}
                {info.namespacePresent === false && <span className="inline-flex items-center gap-0.5 text-xs text-amber-700 dark:text-amber-400"><XCircle size={12} /> missing</span>}
              </span>
            )
            : dash}
        </Fact>
        {info.resources && (
          <Fact label="Resources">
            {info.resources.cpuLimit} CPU · {info.resources.memoryLimit} GB RAM · {info.resources.storageLimit} GB disk
          </Fact>
        )}
        <Fact label="Bundles">{info.bundles.filter((b) => b.status === 'completed').length} restorable</Fact>
      </dl>
      {info.deleted && info.source === 'bundle' && info.infoFromBundleId && (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          As recorded in the bundle you chose — it is re-created with its original id and namespace.
        </p>
      )}
      {info.infoError && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-testid="dr-recover-facts-error">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {info.infoError}
        </p>
      )}
    </div>
  );
}

const componentLabel = (c: string): string => (c === 'mailboxes' ? 'mail' : c);

/**
 * The tenant's bundles to choose from — when each was taken, by what, what it
 * holds, how big, and how long it is kept. No ids to type. A partial bundle is
 * shown (it is part of the history) but cannot be restored from.
 */
export function BundleChooser({ bundles, value, onChange, disabled }: {
  readonly bundles: readonly DrRecoveryBundle[];
  /** '' = the newest completed one. */
  readonly value: string;
  readonly onChange: (bundleId: string) => void;
  readonly disabled?: boolean;
}) {
  const newest = bundles.find((b) => b.status === 'completed')?.id ?? '';
  const selected = value || newest;
  if (bundles.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">This tenant has no bundle to recover from.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700" data-testid="dr-recover-bundles">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-900/50 dark:text-gray-400">
          <tr>
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2">Taken</th>
            <th className="px-3 py-2">By</th>
            <th className="px-3 py-2">Contents</th>
            <th className="px-3 py-2 text-right">Size</th>
            <th className="px-3 py-2">Kept until</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {bundles.map((b) => {
            const usable = b.status === 'completed';
            const isSelected = usable && b.id === selected;
            return (
              <tr
                key={b.id}
                className={isSelected ? 'bg-brand-50 dark:bg-brand-900/20' : usable ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/40' : 'opacity-60'}
                onClick={() => { if (usable && !disabled) onChange(b.id === newest ? '' : b.id); }}
                data-testid={`dr-bundle-${b.id}`}
              >
                <td className="px-3 py-2">
                  <input
                    type="radio"
                    name="dr-recover-bundle"
                    checked={isSelected}
                    disabled={!usable || disabled}
                    onChange={() => onChange(b.id === newest ? '' : b.id)}
                    aria-label={`Bundle taken ${utc(b.createdAt)}`}
                  />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-gray-900 dark:text-gray-100">
                  {utc(b.createdAt)}
                  <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{age(b.createdAt)}</span>
                  {b.id === newest && <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 text-[11px] text-green-800 dark:bg-green-900/40 dark:text-green-300">newest</span>}
                  {!usable && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{b.status} — cannot restore</span>}
                </td>
                <td className="px-3 py-2 text-gray-700 dark:text-gray-300">{b.trigger}{b.label ? ` · ${b.label}` : ''}</td>
                <td className="px-3 py-2 text-gray-700 dark:text-gray-300">
                  {b.components.length > 0
                    ? b.components.map((c) => `${componentLabel(c.component)} ${formatBytes(c.sizeBytes)}`).join(' · ')
                    : <span className="text-gray-400 dark:text-gray-500">—</span>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-gray-900 dark:text-gray-100">{formatBytes(b.sizeBytes)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-gray-700 dark:text-gray-300">{b.expiresAt ? b.expiresAt.slice(0, 10) : 'no expiry'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
