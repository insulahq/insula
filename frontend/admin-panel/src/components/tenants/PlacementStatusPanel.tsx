import { useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, MoveRight, Pin } from 'lucide-react';
import type { TenantPlacement, TenantStorageFailover } from '@insula/api-contracts';
import { useTenantPlacement } from '@/hooks/use-tenant-placement';
import { useMigrateTenantToWorker } from '@/hooks/use-tenant-migration';
import { useNodeLabel } from '@/hooks/use-node-labels';
import NodeName from '@/components/nodes/NodeName';
import NodeList from '@/components/nodes/NodeList';
import NodeText from '@/components/nodes/NodeText';
import MigrateResultNote from './MigrateResultNote';

function utc(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function Nodes({ names }: { readonly names: readonly string[] }) {
  return names.length > 0 ? <NodeList names={names} /> : <>—</>;
}

type PendingAction = { readonly kind: 'move-back' | 'make-primary'; readonly node: string } | null;

/**
 * Where the tenant actually is, inside the Placement card: the node(s) it runs
 * on and keeps its data on, against its primary node — and, when those
 * differ, a red banner with the two ways out:
 *
 *   Move back to <primary>      a running tenant is stopped, its volume
 *                               released by the node it ran on, and started
 *                               on the primary node; Longhorn then copies the
 *                               data back (about a minute down, and the copy
 *                               takes as long as the volume is big).
 *   Make <current> the primary  accepts where it is: re-pins to the current
 *                               node, so the next restart stays there.
 *
 * Both go through the existing migrate-to-worker action. Neither runs without
 * a second click that says what it will do.
 */
export default function PlacementStatusPanel({ tenantId }: { readonly tenantId: string }) {
  const { data, isLoading } = useTenantPlacement(tenantId);
  const migrate = useMigrateTenantToWorker(tenantId);
  const [pending, setPending] = useState<PendingAction>(null);

  if (isLoading) {
    return (
      <div className="mt-4 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <Loader2 size={12} className="animate-spin" /> Checking where this tenant runs…
      </div>
    );
  }

  const placement = data?.data.placement ?? null;
  const failovers = data?.data.failovers ?? [];

  const run = async () => {
    if (!pending) return;
    try {
      await migrate.mutateAsync(pending.node);
      setPending(null);
    } catch {
      // surfaced via migrate.error below
    }
  };

  return (
    <div className="mt-5 border-t border-gray-100 pt-4 dark:border-gray-700" data-testid="placement-status">
      <PlacementSummary placement={placement} />

      {placement?.status === 'misplaced' && (
        <MisplacedBanner
          placement={placement}
          pending={pending}
          busy={migrate.isPending}
          onChoose={setPending}
          onConfirm={run}
          onCancel={() => setPending(null)}
        />
      )}

      {migrate.error && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400" data-testid="placement-action-error">
          {(migrate.error as { message?: string }).message ?? 'The placement change failed.'}
        </p>
      )}
      {migrate.isSuccess && migrate.data && <MigrateResultNote result={migrate.data.data} />}

      {failovers.length > 0 && <FailoverList failovers={failovers} />}
    </div>
  );
}

function PlacementSummary({ placement }: { readonly placement: TenantPlacement | null }) {
  if (!placement || placement.status === 'unknown') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
        <HelpCircle size={14} aria-hidden="true" />
        Actual placement not observed yet{placement ? ` (last check ${utc(placement.checkedAt)})` : ''}.
      </p>
    );
  }
  const misplaced = placement.status === 'misplaced';
  const tone = misplaced ? 'text-red-600 dark:text-red-400' : 'text-gray-800 dark:text-gray-200';
  return (
    <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3" data-testid="placement-summary">
      <div>
        <dt className="font-medium text-gray-500 dark:text-gray-400">Running on</dt>
        <dd className={`mt-0.5 flex items-center gap-1 font-mono ${tone}`}>
          {!misplaced && placement.status === 'placed' && <CheckCircle2 size={12} className="text-green-600 dark:text-green-400" aria-hidden="true" />}
          <Nodes names={placement.workloadNodes.length > 0 ? placement.workloadNodes : placement.attachedNodes} />
        </dd>
      </div>
      <div>
        <dt className="font-medium text-gray-500 dark:text-gray-400">Data on</dt>
        <dd className={`mt-0.5 font-mono ${tone}`}><Nodes names={placement.dataNodes} /></dd>
      </div>
      <div>
        <dt className="font-medium text-gray-500 dark:text-gray-400">Primary node</dt>
        <dd className="mt-0.5 font-mono text-gray-800 dark:text-gray-200">
          {placement.primaryNode ? <NodeName name={placement.primaryNode} /> : <span className="italic font-sans text-gray-500 dark:text-gray-400">none (auto)</span>}
        </dd>
      </div>
    </dl>
  );
}

interface MisplacedBannerProps {
  readonly placement: TenantPlacement;
  readonly pending: PendingAction;
  readonly busy: boolean;
  readonly onChoose: (action: PendingAction) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

function MisplacedBanner({ placement, pending, busy, onChoose, onConfirm, onCancel }: MisplacedBannerProps) {
  const primary = placement.primaryNode;
  // "Make it the primary" only makes sense when the tenant is on ONE other node.
  const current = placement.actualNodes.length === 1 && placement.actualNodes[0] !== primary
    ? placement.actualNodes[0]!
    : null;
  const nodeLabel = useNodeLabel();

  return (
    <div
      className="mt-4 rounded-lg border border-red-300 bg-red-50 p-3 dark:border-red-500/40 dark:bg-red-950/40"
      role="alert"
      data-testid="placement-misplaced-banner"
    >
      <p className="flex items-start gap-2 text-sm font-semibold text-red-900 dark:text-red-200">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        Not on its primary node {primary ? nodeLabel(primary) : ''}
      </p>
      <p className="mt-1 text-xs text-red-800 dark:text-red-300">
        <NodeText text={placement.reasons.join(', ')} />{placement.misplacedSince ? ` — since ${utc(placement.misplacedSince)}` : ''}.
        Away from its primary node the tenant may do its disk I/O across the network, and the next
        restart or backup can move its data again.
      </p>

      {!pending && (
        <div className="mt-3 flex flex-wrap gap-2">
          {primary && (
            <button
              type="button"
              onClick={() => onChoose({ kind: 'move-back', node: primary })}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50 dark:bg-red-700 dark:hover:bg-red-600"
              data-testid="placement-move-back"
            >
              <MoveRight size={14} aria-hidden="true" /> Move back to {nodeLabel(primary)}
            </button>
          )}
          {current && (
            <button
              type="button"
              onClick={() => onChoose({ kind: 'make-primary', node: current })}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50 dark:border-red-500/50 dark:bg-gray-800 dark:text-red-200 dark:hover:bg-gray-700"
              data-testid="placement-make-primary"
            >
              <Pin size={14} aria-hidden="true" /> Make {nodeLabel(current)} the primary node
            </button>
          )}
        </div>
      )}

      {pending && (
        <div className="mt-3 rounded-md border border-red-200 bg-white p-3 text-xs text-gray-800 dark:border-red-500/30 dark:bg-gray-900 dark:text-gray-200" data-testid="placement-confirm">
          <p>
            {pending.kind === 'move-back'
              ? `Moves this tenant to ${nodeLabel(pending.node)}. If it is running, it is stopped first, its volume is released by the node it runs on, and it starts again on ${nodeLabel(pending.node)} — usually about a minute of downtime. Longhorn then copies the tenant's data to ${nodeLabel(pending.node)} in the background; the copy takes as long as the volume is large.`
              : `Makes ${nodeLabel(pending.node)} this tenant's primary node, where it already runs. Its workloads restart once to pick up the new pin; no data is copied.`}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700 disabled:opacity-50 dark:bg-red-700 dark:hover:bg-red-600"
              data-testid="placement-confirm-button"
            >
              {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
              {pending.kind === 'move-back' ? `Move to ${nodeLabel(pending.node)}` : `Make ${nodeLabel(pending.node)} primary`}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-lg border border-gray-200 px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FailoverList({ failovers }: { readonly failovers: readonly TenantStorageFailover[] }) {
  return (
    <div className="mt-4" data-testid="placement-failovers">
      <h3 className="text-xs font-medium text-gray-700 dark:text-gray-300">Storage failovers</h3>
      <ul className="mt-1 space-y-1">
        {failovers.map((f) => (
          <li key={f.id} className="text-xs text-gray-600 dark:text-gray-400">
            <span className="font-mono">{utc(f.remountRequestedAt)}</span>
            {' — '}volume {f.pvcName ?? f.volumeName} salvaged and remounted;
            {' '}<span className="font-mono"><Nodes names={f.nodesBefore} /></span>
            {' → '}<span className="font-mono">{f.nodesAfter.length > 0 ? <NodeList names={f.nodesAfter} /> : 'restarting'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
