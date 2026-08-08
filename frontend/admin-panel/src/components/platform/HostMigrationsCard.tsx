import { AlertTriangle, CheckCircle, ChevronDown, ChevronRight, Loader2, ExternalLink, Server } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useHostMigrationStatus } from '@/hooks/use-host-migrations';
import type { HostMigrationNodeStatus, HostMigrationItem } from '@insula/api-contracts';

/**
 * Per-node host-migration state.
 *
 * A host-migration that fails blocks every later one — the runner halts on
 * purpose (ADR-045 W10c, scoped by ADR-056), because a later script may assume
 * an earlier one applied. The failure mode this card exists for is that the
 * block was previously INVISIBLE: the DEV cluster sat at 11 pending behind a
 * single failure for five weeks, and the only way to find out was to SSH to a
 * node and run `insula host-config`.
 *
 * Read-only by construction. The backend cannot touch a node's filesystem, and
 * the converge that applies migrations already runs hourly and picks up a fixed
 * condition on its own — so "retry" is automatic, and what an operator actually
 * needs here is the cause, how long it has been failing, and the two commands
 * that resolve it.
 */
const CARD = 'rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800';

const STATE_STYLE: Record<string, string> = {
  'run-failed': 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  blocked: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'would-run': 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  skipped: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  invalid: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

function StateBadge({ state }: { readonly state: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATE_STYLE[state] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}>
      {state}
    </span>
  );
}

function ItemRow({ item }: { readonly item: HostMigrationItem }) {
  return (
    <li className="py-1.5 text-xs">
      <div className="flex items-start gap-2">
        <StateBadge state={item.state} />
        <code className="font-mono text-gray-700 dark:text-gray-300 break-all">{item.key}</code>
      </div>
      {item.error && (
        <p className="mt-0.5 pl-1 text-red-600 dark:text-red-400 break-words">{item.error}</p>
      )}
      {/* ADR-056: how long it has been failing is what turns "a failure" into
          "this node has been stuck since July". */}
      {item.state === 'run-failed' && item.attempt != null && item.attempt > 1 && (
        <p className="mt-0.5 pl-1 text-gray-500 dark:text-gray-400">
          attempt {item.attempt}
          {item.failingSince ? ` · failing since ${item.failingSince}` : ''}
        </p>
      )}
      {item.skipReason && (
        <p className="mt-0.5 pl-1 text-gray-500 dark:text-gray-400">skipped by operator: {item.skipReason}</p>
      )}
    </li>
  );
}

function NodeBlock({ node }: { readonly node: HostMigrationNodeStatus }) {
  // `ok === false` is a WHOLE-RUN refusal (catalog over the script cap): it
  // carries no items, so every count is legitimately zero and only `ok` and
  // `reason` say anything is wrong. `invalid` is a script that will never run.
  const bad = node.failedCount > 0 || node.blockedCount > 0 || node.invalidCount > 0 || node.ok === false;
  const [open, setOpen] = useState(bad); // a broken node opens itself
  const panelId = useId();

  // useState only runs its initialiser on mount, and this list is keyed by node
  // name so the component never remounts across the 5-minute poll. Without this,
  // a node that starts failing between polls stays collapsed — the operator
  // would have to hunt for it, which is what the auto-open exists to prevent.
  // One-directional on purpose: a node the operator collapsed after fixing it
  // should not be forced back open.
  useEffect(() => {
    if (bad) setOpen(true);
  }, [bad]);

  const interesting = node.items.filter((i) => i.state !== 'applied' && i.state !== 'already-applied');

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 pt-2 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid={`host-migrations-node-${node.node}`}
        className="flex w-full items-center gap-2 text-left"
      >
        {open ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
        <Server size={14} className="text-gray-500 dark:text-gray-400" />
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{node.node}</span>
        {bad ? (
          <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
            {[
              node.failedCount > 0 ? `${node.failedCount} failed` : null,
              node.blockedCount > 0 ? `${node.blockedCount} blocked` : null,
              node.invalidCount > 0 ? `${node.invalidCount} invalid` : null,
              // No counts at all means the run itself was refused.
              node.failedCount + node.blockedCount + node.invalidCount === 0 ? 'run refused' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        ) : (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {node.note ?? `${node.appliedCount} applied${node.pendingCount ? ` · ${node.pendingCount} pending` : ''}`}
          </span>
        )}
      </button>

      {open && (
        <div className="pl-6 pt-1" id={panelId}>
          {node.note && <p className="py-1 text-xs text-gray-500 dark:text-gray-400">{node.note}</p>}
          {node.reason && (
            <p className="py-1 text-xs text-red-600 dark:text-red-400" data-testid="host-migrations-reason">
              This node refused the whole run: {node.reason}
            </p>
          )}
          {interesting.length === 0 && !node.note && !node.reason && (
            <p className="py-1 text-xs text-gray-500 dark:text-gray-400">All shipped migrations are applied.</p>
          )}
          {interesting.length > 0 && (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700">
              {interesting.map((i) => <ItemRow key={i.key} item={i} />)}
            </ul>
          )}
          {node.collectedAt && (
            <p className="pt-1 text-[11px] text-gray-400 dark:text-gray-500">reported {node.collectedAt}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function HostMigrationsCard() {
  const { data, isLoading, isError } = useHostMigrationStatus();
  const res = data?.data;

  return (
    <div className={CARD} data-testid="host-migrations-card">
      <div className="mb-3 flex items-center gap-2">
        {res?.degraded ? (
          <AlertTriangle size={18} className="text-red-600 dark:text-red-400" />
        ) : (
          <CheckCircle size={18} className="text-gray-600 dark:text-gray-400" />
        )}
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Host migrations</h2>
        {res?.degraded && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-900/40 dark:text-red-300">
            needs attention
          </span>
        )}
      </div>

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading node state…
        </p>
      )}

      {isError && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Could not read node state. The converge still runs hourly on each node regardless.
        </p>
      )}

      {res && res.nodes.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No node has reported yet. Nodes publish after their next converge (hourly).
        </p>
      )}

      {res && res.nodes.length > 0 && (
        <div className="space-y-2">{res.nodes.map((n) => <NodeBlock key={n.node} node={n} />)}</div>
      )}

      {/* Why there is no Retry button: the converge that applies migrations runs
          hourly on every node and picks up a fixed condition by itself. What an
          operator needs is the cause and the two commands that resolve it. */}
      {res?.degraded && (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
          <p className="font-medium">A failed migration blocks every later one on that node.</p>
          <p className="mt-1">
            Migrations re-run automatically every hour, so a transient failure clears itself. A failure
            that repeats is deterministic — fix the cause on the node, then:
          </p>
          <pre className="mt-1.5 overflow-x-auto rounded bg-amber-100/70 p-2 font-mono dark:bg-amber-900/40">insula host-config apply</pre>
          <p className="mt-1.5">
            If it can never apply to that host, record a skip so the rest of the chain proceeds — never
            touch the <code className="font-mono">.done</code> marker, which would report it as applied.
          </p>
          <a
            href={res.runbookUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="host-migrations-runbook-link"
            className="mt-2 inline-flex items-center gap-1 font-medium underline"
          >
            Troubleshooting runbook <ExternalLink size={11} />
          </a>
        </div>
      )}
    </div>
  );
}
