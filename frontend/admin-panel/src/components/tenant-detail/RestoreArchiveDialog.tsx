import { useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import type { RestoreArchivedTenantRequest, TenantArchiveInfo } from '@insula/api-contracts';
import ErrorPanel from '@/components/ErrorPanel';
import { extractOperatorError } from '@/lib/extract-operator-error';
import { formatVolumeBytes } from '@/lib/format-bytes';

const GIB = 1024 ** 3;
const AUTO = '__auto__';

const longDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

/** The least size, in GiB to two decimals, that holds `bytes` of files. */
export function leastGiFor(bytes: number): number {
  return bytes > 0 ? Math.ceil((bytes / GIB) * 100) / 100 : 0.01;
}

/**
 * What a restore from archive asks before it starts: the node the tenant comes
 * back on and the size of its new volume — with what the backend checks shown
 * beforehand, from the same read (`GET …/archive`): which nodes cannot take it
 * and why, the least size the archive's files need, where the archive is
 * stored, and a subscription that has ended. The tenant comes back SUSPENDED;
 * it is reactivated after, on purpose.
 */
export default function RestoreArchiveDialog({
  tenantName,
  info,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  readonly tenantName: string;
  readonly info: TenantArchiveInfo;
  readonly busy: boolean;
  /** The restore the API refused, if it did. */
  readonly error: unknown;
  readonly onConfirm: (body: RestoreArchivedTenantRequest) => void;
  readonly onClose: () => void;
}) {
  const placement = info.placement;
  const pinned = placement?.pinnedNode ?? null;
  const pinUsable = pinned !== null && !placement?.pinProblem;
  const [node, setNode] = useState<string>(pinUsable ? (pinned as string) : AUTO);
  const [size, setSize] = useState(String(info.storageGi));

  const n = Number(size);
  const leastGi = leastGiFor(info.filesBytes);
  const sizeValid = Number.isFinite(n) && n >= leastGi && n <= 1000;
  const tight = sizeValid && info.filesBytes > 0.9 * n * GIB;
  // Any other size is the tenant's storage size from then on (its override and quota).
  const resized = sizeValid && n !== info.storageGi;
  const ended = info.subscriptionExpiresAt !== null && new Date(info.subscriptionExpiresAt).getTime() < Date.now();
  const whole = info.bundle?.whole ?? false;

  const nodes = placement?.nodes ?? (pinned ? [{ name: pinned, problem: null }] : []);
  const autoLabel = placement?.storageTier === 'ha'
    ? 'Auto — let the cluster place it (HA storage)'
    : 'Auto — the node with the most free storage';

  const submit = (): void => {
    const body: RestoreArchivedTenantRequest = {
      nodeName: node === AUTO ? null : node,
      ...(n !== info.storageGi ? { newGi: Math.round(n * 100) / 100 } : {}),
    };
    onConfirm(body);
  };

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="restore-archive-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl dark:bg-gray-800" data-testid="restore-archive-dialog">
        <div className="border-b border-gray-100 px-5 py-3 dark:border-gray-700">
          <h2 id="restore-archive-title" className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            <Play size={18} aria-hidden="true" /> Restore {tenantName} from its archive?
          </h2>
        </div>
        <div className="space-y-4 p-5 text-sm text-gray-700 dark:text-gray-300">
          <p data-testid="restore-what-comes-back">
            {whole
              ? 'Its files and databases, applications, DNS zones, mail domains and mailboxes with their mail come back. '
              : 'This archive is from before archives held everything: only the files come back. Applications have to be redeployed and mailboxes set up again once it is active. '}
            <strong className="font-semibold text-gray-900 dark:text-gray-100">It comes back suspended:</strong>{' '}
            its sites show the suspended page, its mail is shut and its applications are stopped until you reactivate
            it.{whole ? ' Mailboxes need new passwords: the mail server never kept a copy the archive could hold.' : ''}
          </p>

          {ended && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300" data-testid="restore-subscription-ended">
              Its subscription ended on {longDate(info.subscriptionExpiresAt as string)}. Set a new date under Limits → Subscription
              before reactivating it — reactivation is refused until then.
            </p>
          )}

          {info.target && !info.target.bound && (
            <p className="rounded-lg bg-sky-50 p-3 text-xs text-sky-800 dark:bg-sky-900/20 dark:text-sky-300" data-testid="restore-other-target">
              The archive is stored on <span className="font-medium">{info.target.name}</span>, which tenant backups no longer
              use. It is read through a temporary, read-only connection to that target.
            </p>
          )}

          <label className="block">
            <span className="block text-xs font-medium text-gray-700 dark:text-gray-300">Restore on node</span>
            <select
              value={node}
              onChange={(e) => setNode(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              data-testid="restore-node-select"
            >
              <option value={AUTO}>{autoLabel}</option>
              {nodes.map((c) => (
                <option key={c.name} value={c.name} disabled={c.problem !== null}>
                  {c.name}{c.name === pinned ? ' (its node)' : ''}{c.problem ? ` — ${c.problem}` : ''}
                </option>
              ))}
            </select>
            {placement?.pinProblem && pinned && (
              <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400" data-testid="restore-pin-problem">
                Its node {pinned} {placement.pinProblem}. Choose another node, or Auto.
              </span>
            )}
            {!placement && (
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                The cluster's nodes could not be read; the restore checks the node it is given.
              </span>
            )}
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-gray-700 dark:text-gray-300">Volume size (GiB)</span>
            <input
              type="number"
              min={leastGi}
              max={1000}
              step={0.01}
              value={size}
              onChange={(e) => setSize(e.target.value)}
              className="mt-1 w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              data-testid="restore-size-input"
            />
            <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400" data-testid="restore-size-hint">
              {info.filesBytes > 0 ? `The archive's files take ${formatVolumeBytes(info.filesBytes)}. ` : ''}
              The tenant's storage is {info.storageGi} GiB.
            </span>
            {!sizeValid && (
              <span className="mt-1 block text-xs text-red-600 dark:text-red-400" data-testid="restore-size-invalid">
                Between {leastGi} and 1000 GiB{info.filesBytes > 0 ? ': the files need at least that much' : ''}.
              </span>
            )}
            {resized && (
              <span className="mt-1 block text-xs text-gray-600 dark:text-gray-300" data-testid="restore-size-changes">
                The tenant's storage becomes {n} GiB.
              </span>
            )}
            {tight && (
              <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400" data-testid="restore-size-tight">
                Little room left: the files fill over 90% of this size.
              </span>
            )}
          </label>

          {error !== null && error !== undefined && (
            <ErrorPanel error={extractOperatorError(error)} severity="error" testId="restore-archive-error" />
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !sizeValid}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            data-testid="restore-archive-confirm"
          >
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            Restore, suspended
          </button>
        </div>
      </div>
    </div>
  );
}
