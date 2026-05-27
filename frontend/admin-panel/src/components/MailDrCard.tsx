import { useState, useEffect } from 'react';
import {
  ShieldAlert,
  AlertTriangle,
  Loader2,
  Check,
  ArrowRight,
  ChevronDown,
  Info,
  Database,
  Wrench,
} from 'lucide-react';
import StalwartReprovisionModal from '@/components/StalwartReprovisionModal';
import {
  useMailPlacement,
  useUpdateMailPlacement,
  useMailFailover,
  useMailFailback,
  PLACEMENT_KEY,
} from '@/hooks/use-mail-placement';
import { useStartMailMigration } from '@/hooks/use-mail-migration';
import { useMailRecoveryStatus, useStartMailRecover } from '@/hooks/use-mail-recovery';
import { useMailStandbyReports } from '@/hooks/use-mail-standby-reports';
import { useQueryClient } from '@tanstack/react-query';
import MailMigrationProgressModal from '@/components/MailMigrationProgressModal';
import type { NodeCandidate, StandbyReport } from '@k8s-hosting/api-contracts';

type DrState = 'healthy' | 'degraded' | 'failing-over' | 'failed-over' | 'failing-back';

const DR_STATE_BADGE: Record<DrState, { label: string; cls: string }> = {
  healthy: { label: 'Healthy', cls: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  degraded: { label: 'Degraded', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' },
  'failing-over': { label: 'Failing over…', cls: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' },
  'failed-over': { label: 'Failed over', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
  'failing-back': { label: 'Failing back…', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
};

function bytesToGiB(b: number) { return (b / 1024 ** 3).toFixed(1); }

export default function MailDrCard() {
  const query = useMailPlacement();
  const update = useUpdateMailPlacement();
  const failover = useMailFailover();
  const failback = useMailFailback();
  const migrate = useStartMailMigration();
  const qc = useQueryClient();

  const [draft, setDraft] = useState<{
    primaryNode: string | null;
    secondaryNode: string | null;
    tertiaryNode: string | null;
    autoFailoverEnabled: boolean;
    failoverThresholdSeconds: number;
  } | null>(null);

  const [migrationRunId, setMigrationRunId] = useState<string | null>(null);
  // Consolidated "Move mail to…" target — replaces the legacy Manual
  // Failover + Fail-back + Live Migrate trio. The action dispatched
  // is inferred from which node the operator picked: see handleMove.
  const [moveTarget, setMoveTarget] = useState<string>('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showReprovision, setShowReprovision] = useState(false);

  // Init draft from server data
  useEffect(() => {
    if (query.data?.data && !draft) {
      const d = query.data.data;
      setDraft({
        primaryNode: d.primaryNode,
        secondaryNode: d.secondaryNode,
        tertiaryNode: d.tertiaryNode,
        autoFailoverEnabled: d.autoFailoverEnabled,
        failoverThresholdSeconds: d.failoverThresholdSeconds,
      });
    }
  }, [query.data, draft]);

  if (query.isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading placement policy…
        </div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-5">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-red-600" />
          <div className="text-sm text-red-700 dark:text-red-300">
            Could not read mail placement policy.{' '}
            {query.error instanceof Error ? query.error.message : 'See server logs.'}
          </div>
        </div>
      </div>
    );
  }

  const current = query.data.data;
  const candidates = current.candidateNodes;
  const drState = current.drState as DrState;
  const badge = DR_STATE_BADGE[drState] ?? DR_STATE_BADGE.healthy;

  const d = draft ?? {
    primaryNode: current.primaryNode,
    secondaryNode: current.secondaryNode,
    tertiaryNode: current.tertiaryNode,
    autoFailoverEnabled: current.autoFailoverEnabled,
    failoverThresholdSeconds: current.failoverThresholdSeconds,
  };

  const hasChange =
    d.primaryNode !== current.primaryNode ||
    d.secondaryNode !== current.secondaryNode ||
    d.tertiaryNode !== current.tertiaryNode ||
    d.autoFailoverEnabled !== current.autoFailoverEnabled ||
    d.failoverThresholdSeconds !== current.failoverThresholdSeconds;

  const selectedNodes = [d.primaryNode, d.secondaryNode, d.tertiaryNode].filter(Boolean) as string[];
  const hasDuplicates = new Set(selectedNodes).size < selectedNodes.length;

  async function handleSave() {
    if (hasDuplicates) return;
    try {
      await update.mutateAsync({
        primaryNode: d.primaryNode,
        secondaryNode: d.secondaryNode,
        tertiaryNode: d.tertiaryNode,
        autoFailoverEnabled: d.autoFailoverEnabled,
        failoverThresholdSeconds: d.failoverThresholdSeconds,
      });
      setDraft(null);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 5_000);
    } catch {
      // Failed mutation: drop the draft so the form re-syncs to
      // server state on the next render. Without this the operator
      // is left looking at their stale local selection while the
      // banner says "save failed", with no clear path to retry from
      // the actual server state.
      setDraft(null);
    }
  }

  // Single "Move mail to…" dispatcher. The legacy split between
  // Manual Failover / Fail-back / Live Migrate corresponded 1:1 to a
  // target-vs-current-state predicate, with all three ultimately
  // calling the same migration orchestrator server-side. We collapse
  // the trio into one control here and route to the appropriate hook
  // based on the picked target:
  //
  //   - target == primary AND active != primary → useMailFailback
  //   - target == secondary || tertiary         → useMailFailover
  //   - any other candidate                     → useStartMailMigration
  //
  // Selection of activeNode itself is impossible (option disabled).
  async function handleMove() {
    if (!moveTarget || moveTarget === current.activeNode) return;
    try {
      let result;
      if (
        current.activeNode
        && current.primaryNode
        && current.activeNode !== current.primaryNode
        && moveTarget === current.primaryNode
      ) {
        result = await failback.mutateAsync({ confirm: true });
      } else if (
        moveTarget === current.secondaryNode
        || moveTarget === current.tertiaryNode
      ) {
        result = await failover.mutateAsync({ targetNode: moveTarget, confirm: true });
      } else {
        result = await migrate.mutateAsync({ targetNode: moveTarget, confirm: true });
      }
      setMigrationRunId(result.data.runId);
      setMoveTarget('');
    } catch {
      // surfaced via the relevant hook's isError below
    }
  }

  const movePending = failover.isPending || failback.isPending || migrate.isPending;
  const moveError = failover.error ?? failback.error ?? migrate.error ?? null;
  const moveHasError = failover.isError || failback.isError || migrate.isError;

  // Per-target action label so the operator knows what they're about
  // to trigger before they click. Matches handleMove's dispatch logic.
  function actionLabelForTarget(target: string): string {
    if (!target) return 'Move mail';
    if (
      current.activeNode
      && current.primaryNode
      && current.activeNode !== current.primaryNode
      && target === current.primaryNode
    ) return 'Fail back to primary';
    if (target === current.secondaryNode) return 'Fail over to secondary';
    if (target === current.tertiaryNode) return 'Fail over to tertiary';
    return 'Live-migrate to selected node';
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldAlert size={20} className="text-gray-700 dark:text-gray-300" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100" data-testid="mail-dr-heading">
            Mail Server Placement &amp; DR
          </h2>
        </div>
        <span
          data-testid="mail-dr-state-badge"
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${badge.cls}`}
        >
          {drState === 'failing-over' || drState === 'failing-back'
            ? <Loader2 size={11} className="animate-spin" />
            : null}
          {badge.label}
        </span>
      </div>

      {/* Phase 3 streamline (2026-05-15): the "Currently running on" tile
          was removed from this card — it read from system_settings.
          activeNode which can drift from the pod's real node. The health
          banner above shows the verified pod node (probed live from k8s).
          We only render the last-failover timestamp here as it's not
          available from the health endpoint. */}
      {current.lastFailoverAt && (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-4 py-2 text-xs text-gray-500 dark:text-gray-400">
          Last failover: {new Date(current.lastFailoverAt).toLocaleString()}
        </div>
      )}
      {/* Keep activeNode as a data attribute for the harness without
          rendering it visibly — harness Phase G4 reads it via the
          test-id to compare against `kubectl get pod`. */}
      {current.activeNode && (
        <span data-testid="mail-dr-active-node" className="sr-only">{current.activeNode}</span>
      )}

      {/* Node assignments */}
      <div className="space-y-3">
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Node assignment
        </div>

        <NodeDropdown
          label="Primary"
          description="Default node for Stalwart. DR will try to keep mail here."
          value={d.primaryNode}
          candidates={candidates}
          disabledValues={[d.secondaryNode, d.tertiaryNode]}
          onChange={(v) => setDraft({ ...d, primaryNode: v })}
          testId="mail-dr-primary-node"
        />
        <NodeDropdown
          label="Secondary"
          description="First failover target when primary is unavailable."
          value={d.secondaryNode}
          candidates={candidates}
          disabledValues={[d.primaryNode, d.tertiaryNode]}
          onChange={(v) => setDraft({ ...d, secondaryNode: v })}
          testId="mail-dr-secondary-node"
        />
        <NodeDropdown
          label="Tertiary"
          description="Second failover target (optional)."
          value={d.tertiaryNode}
          candidates={candidates}
          disabledValues={[d.primaryNode, d.secondaryNode]}
          onChange={(v) => setDraft({ ...d, tertiaryNode: v })}
          testId="mail-dr-tertiary-node"
        />
      </div>

      {hasDuplicates && (
        <p className="text-xs text-red-700 dark:text-red-300">
          Primary, secondary and tertiary must be distinct nodes.
        </p>
      )}

      {/* Auto-failover */}
      <div className="space-y-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Auto-failover</div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Automatically migrate to secondary/tertiary when primary is unreachable.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={d.autoFailoverEnabled}
            onClick={() => setDraft({ ...d, autoFailoverEnabled: !d.autoFailoverEnabled })}
            data-testid="mail-dr-auto-failover-toggle"
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 ${
              d.autoFailoverEnabled ? 'bg-brand-500' : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                d.autoFailoverEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {d.autoFailoverEnabled && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Failover threshold: <strong>{d.failoverThresholdSeconds}s</strong>
            </label>
            <input
              type="range"
              min={60}
              max={3600}
              step={30}
              value={d.failoverThresholdSeconds}
              onChange={(e) => setDraft({ ...d, failoverThresholdSeconds: Number(e.target.value) })}
              data-testid="mail-dr-threshold-slider"
              className="w-full accent-brand-500"
            />
            <div className="flex justify-between text-xs text-gray-400 dark:text-gray-600">
              <span>60s</span><span>1h</span>
            </div>
          </div>
        )}
      </div>

      {/* Save placement */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={!hasChange || hasDuplicates || update.isPending}
          data-testid="mail-dr-save"
          className="inline-flex items-center gap-2 rounded-lg border border-brand-500 bg-brand-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {update.isPending ? 'Saving…' : 'Save'}
        </button>
        {!hasChange && <p className="text-xs text-gray-500 dark:text-gray-400">No changes to save.</p>}
      </div>

      {saveSuccess && (
        <div role="status" className="flex items-start gap-2.5 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-3 py-2.5 text-sm text-green-800 dark:text-green-200">
          <Check size={14} className="mt-0.5 shrink-0" />
          <span>Placement policy saved.</span>
        </div>
      )}

      {update.isError && (
        <ErrorBanner error={update.error} />
      )}

      <div className="border-t border-gray-200 dark:border-gray-700 pt-4 space-y-3">
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Manual operations
        </div>

        {/* Move mail to… — consolidated dispatcher.
            Replaces the legacy Manual Failover + Fail-back + Live
            Migrate trio (2026-05-26) — each was a thin wrapper around
            the same migration orchestrator, the only difference being
            which target nodes were offered. The unified dropdown
            sources all candidates; the button label updates as the
            operator picks a target so they know which DR action is
            implied before clicking. */}
        <div className="space-y-2">
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Move mail to…
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Single dispatcher: picks the right DR action (fail-over,
            fail-back, or live-migrate) based on which node you choose.
            Standby-labelled targets use the FAST PATH (pre-staged
            data, ≤ 5 min stale); other targets rsync from the active
            node mid-cutover.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Target node
              </label>
              <select
                value={moveTarget}
                onChange={(e) => setMoveTarget(e.target.value)}
                data-testid="mail-dr-move-target"
                className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              >
                <option value="">— select node —</option>
                {candidates.map((c) => {
                  const isCurrent = c.hostname === current.activeNode;
                  const roleParts: string[] = [];
                  if (c.hostname === current.primaryNode) roleParts.push('primary');
                  if (c.hostname === current.secondaryNode) roleParts.push('secondary');
                  if (c.hostname === current.tertiaryNode) roleParts.push('tertiary');
                  const role = roleParts.length > 0 ? ` [${roleParts.join('/')}]` : '';
                  return (
                    <option
                      key={c.hostname}
                      value={c.hostname}
                      disabled={isCurrent}
                    >
                      {c.hostname}{role} — {bytesToGiB(c.freeDiskBytes)} GiB free
                      {isCurrent ? ' (current)' : ''}
                    </option>
                  );
                })}
              </select>
            </div>
            <button
              type="button"
              onClick={handleMove}
              disabled={!moveTarget || moveTarget === current.activeNode || movePending}
              data-testid="mail-dr-move-button"
              className="inline-flex items-center gap-2 rounded-lg border border-amber-500 bg-amber-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {movePending ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
              {movePending ? 'Starting…' : actionLabelForTarget(moveTarget)}
            </button>
          </div>
          {/* Auto-failover behaviour reminder — only relevant when the
              active node isn't the primary (i.e. a fail-over already
              happened); explains why the operator must manually pick
              the primary as the next target. */}
          {current.activeNode && current.primaryNode && current.activeNode !== current.primaryNode && (
            <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
              <Info size={12} className="shrink-0" />
              Currently failed-over. Pick <code className="font-mono">{current.primaryNode}</code>{' '}
              to fail back — auto-failover policy never triggers fail-back on its own.
            </div>
          )}
          {moveHasError && <ErrorBanner error={moveError} />}
        </div>

        {/* Mail Recovery — when system is in broken state (PVC bound on
            wrong node, Pod stuck Pending/CrashLoop). Section auto-shows
            only when getMailRecoveryStatus reports state='broken'. */}
        <MailRecoverSection />

        {/* Re-provision Stalwart — recovery tool for missing/drifted
            x:Domain, AcmeProvider, certManagement, or required
            NetworkListeners. Self-healing reconciler runs every 30 min
            anyway; this button surfaces it on demand with a
            "what changed" report. */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Re-provision Stalwart
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Ensure the platform domain, ACME provider, cert
              management, and required listeners (submission/imap/
              http-acme) exist in Stalwart. Idempotent — safe on a
              healthy cluster (no-op).
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowReprovision(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20"
            data-testid="mail-dr-reprovision-button"
          >
            <Wrench size={12} /> Re-provision…
          </button>
        </div>
      </div>

      {/* Standby data freshness (A5 — rsync replication) */}
      <StandbyDataSection />

      {/* Candidate nodes info */}
      {candidates.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1.5">
            <ChevronDown size={12} className="group-open:rotate-180 transition-transform" />
            {candidates.length} server node{candidates.length !== 1 ? 's' : ''} available
          </summary>
          <div className="mt-2 space-y-1.5">
            {candidates.map((c) => <CandidateRow key={c.hostname} candidate={c} active={c.hostname === current.activeNode} />)}
          </div>
        </details>
      )}

      {migrationRunId && (
        <MailMigrationProgressModal
          runId={migrationRunId}
          onClose={() => {
            setMigrationRunId(null);
            void qc.invalidateQueries({ queryKey: PLACEMENT_KEY });
          }}
        />
      )}

      {showReprovision && (
        <StalwartReprovisionModal onClose={() => setShowReprovision(false)} />
      )}
    </div>
  );
}

interface NodeDropdownProps {
  readonly label: string;
  readonly description: string;
  readonly value: string | null;
  readonly candidates: NodeCandidate[];
  readonly disabledValues: (string | null)[];
  readonly onChange: (v: string | null) => void;
  readonly testId: string;
}
function NodeDropdown({ label, description, value, candidates, disabledValues, onChange, testId }: NodeDropdownProps) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-20 shrink-0">
        <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 pt-2">{label}</div>
      </div>
      <div className="flex-1">
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          data-testid={testId}
          className="w-full max-w-xs rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        >
          <option value="">Any node</option>
          {candidates.map((c) => (
            <option
              key={c.hostname}
              value={c.hostname}
              disabled={disabledValues.includes(c.hostname)}
            >
              {c.hostname} — {c.role} — {c.ready ? 'Ready' : 'NotReady'} — {bytesToGiB(c.freeDiskBytes)} GiB free
            </option>
          ))}
        </select>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{description}</p>
      </div>
    </div>
  );
}

function CandidateRow({ candidate, active }: { readonly candidate: NodeCandidate; readonly active: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2 text-xs">
      <div className={`w-2 h-2 rounded-full shrink-0 ${candidate.ready ? 'bg-green-500' : 'bg-red-500'}`} />
      <code className="font-mono font-medium text-gray-900 dark:text-gray-100 flex-1">
        {candidate.hostname}
        {active && <span className="ml-1.5 text-brand-600 dark:text-brand-400">(active)</span>}
      </code>
      <span className="rounded bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:text-gray-300">
        {candidate.role}
      </span>
      <span className="text-gray-500 dark:text-gray-400">
        {bytesToGiB(candidate.freeDiskBytes)} GiB disk
      </span>
      <span className="text-gray-500 dark:text-gray-400">
        {bytesToGiB(candidate.freeMemoryBytes)} GiB RAM
      </span>
    </div>
  );
}

// ─── Standby data freshness panel ──────────────────────────────────
//
// Reads the per-node reports posted by mail-stack-standby-replicate
// (A5 rsync DaemonSet) — one row per standby-labelled node with the
// last-known size, file count, rsync duration, and age. Traffic-light
// by age vs the DaemonSet's 5-min cadence:
//   <10 min = green (fresh, FAST PATH would use it)
//   <30 min = amber (stale but usable; investigate)
//   else    = red (broken or never reported)
//
// Renders nothing when no reports exist yet (e.g. cluster never had
// HA configured, or DaemonSet just spun up — the first report lands
// within 5 min). Avoids a "no data" tile that confuses operators who
// haven't enabled mail HA yet.

function StandbyDataSection() {
  const { data, isLoading, isError } = useMailStandbyReports();
  const reports = data?.data.reports ?? [];

  if (isLoading || isError) return null;
  if (reports.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-gray-200 dark:border-gray-700 pt-4">
      <div className="flex items-center gap-2">
        <Database size={13} className="text-gray-500 dark:text-gray-400" />
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Standby data freshness
        </div>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Pre-staged mail data on standby-labelled nodes. FAST PATH on failover
        uses this instead of pulling from the active node.
      </p>
      <div className="space-y-1.5">
        {reports.map((r) => <StandbyRow key={r.node} report={r} />)}
      </div>
    </div>
  );
}

function StandbyRow({ report }: { readonly report: StandbyReport }) {
  const min = Math.floor(report.ageSeconds / 60);
  const sec = report.ageSeconds % 60;
  const ageStr = min === 0 ? `${sec}s` : `${min}m ${sec}s`;

  // 5-min DaemonSet cadence → green band covers the normal case
  // (~2x cadence to account for one missed iteration).
  const dotCls =
    report.ageSeconds < 600
      ? 'bg-green-500'
      : report.ageSeconds < 1800
      ? 'bg-amber-500'
      : 'bg-red-500';

  const sizeMiB = (report.sizeBytes / 1024 / 1024).toFixed(1);

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-3 py-2 text-xs"
      data-testid={`mail-standby-row-${report.node}`}
    >
      <div className={`w-2 h-2 rounded-full shrink-0 ${dotCls}`} />
      <code className="font-mono font-medium text-gray-900 dark:text-gray-100 flex-1 truncate">
        {report.node}
      </code>
      <span className="text-gray-500 dark:text-gray-400">{sizeMiB} MiB</span>
      <span className="text-gray-500 dark:text-gray-400">{report.fileCount} files</span>
      <span className="text-gray-500 dark:text-gray-400">{report.durationSeconds}s rsync</span>
      <span
        className={
          report.ageSeconds < 600
            ? 'text-green-700 dark:text-green-300 font-medium'
            : report.ageSeconds < 1800
            ? 'text-amber-700 dark:text-amber-300 font-medium'
            : 'text-red-700 dark:text-red-300 font-medium'
        }
      >
        {ageStr} ago
      </span>
    </div>
  );
}

function ErrorBanner({ error }: { readonly error: unknown }) {
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300 mt-2">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <span>{error instanceof Error ? error.message : 'Operation failed — see server logs.'}</span>
    </div>
  );
}

/**
 * Mail Recovery section — only renders when the backend detection
 * (`/admin/mail/recovery-status`) reports state='broken'. Operator
 * picks a target node + types it to confirm, then triggers the
 * destructive recover flow. Reuses MailMigrationProgressModal for
 * progress (recovery IS a specialised migration).
 */
function MailRecoverSection() {
  const status = useMailRecoveryStatus();
  const placement = useMailPlacement();
  const recover = useStartMailRecover();
  const [showModal, setShowModal] = useState(false);
  const [progressRunId, setProgressRunId] = useState<string | null>(null);

  const data = status.data?.data.status;
  const candidates = placement.data?.data.candidateNodes ?? [];

  // Only render when state is 'broken'. Healthy state = no section,
  // operators don't need to think about recovery. Unknown state =
  // probe failed; section also hidden so we don't drive false alarms.
  if (!data || data.state !== 'broken') return null;

  return (
    <>
      <div className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-4 space-y-3">
        <div className="flex items-start gap-2">
          <AlertTriangle size={18} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-red-900 dark:text-red-200">
              Mail-stack is in a BROKEN state
            </div>
            <p className="mt-1 text-xs text-red-800 dark:text-red-300">
              {data.reason ?? 'Stalwart pod is not Ready.'}
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-red-700 dark:text-red-400">PVC bound on:</dt>
              <dd className="font-mono text-red-900 dark:text-red-200">{data.pvcNode ?? '(none)'}</dd>
              <dt className="text-red-700 dark:text-red-400">System expects active:</dt>
              <dd className="font-mono text-red-900 dark:text-red-200">{data.expectedActiveNode ?? '(unset)'}</dd>
              <dt className="text-red-700 dark:text-red-400">Pod phase:</dt>
              <dd className="font-mono text-red-900 dark:text-red-200">{data.podPhase ?? '(no pod)'}</dd>
            </dl>
          </div>
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-red-300 dark:border-red-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/40"
            data-testid="mail-dr-recover-button"
          >
            <Wrench size={12} /> Recover Mail…
          </button>
        </div>
      </div>

      {showModal && (
        <RecoverModal
          // Default target: prefer the suggested (mailPrimaryNode) IF it
          // isn't the broken node. Otherwise pick the first non-broken
          // candidate. Operator can override.
          defaultTarget={
            (data.suggestedTargetNode && data.suggestedTargetNode !== data.pvcNode)
              ? data.suggestedTargetNode
              : (candidates.find((c) => c.hostname !== data.pvcNode)?.hostname
                 ?? data.suggestedTargetNode
                 ?? candidates[0]?.hostname
                 ?? '')
          }
          brokenNode={data.pvcNode}
          candidates={candidates}
          onClose={() => setShowModal(false)}
          onStarted={(runId) => { setShowModal(false); setProgressRunId(runId); }}
          recover={recover}
        />
      )}
      {progressRunId && (
        <MailMigrationProgressModal runId={progressRunId} onClose={() => setProgressRunId(null)} />
      )}
    </>
  );
}

function RecoverModal({ defaultTarget, brokenNode, candidates, onClose, onStarted, recover }: {
  readonly defaultTarget: string;
  /** Node where the PVC is currently bound (the broken one). UI marks it visibly. */
  readonly brokenNode: string | null;
  readonly candidates: ReadonlyArray<NodeCandidate>;
  readonly onClose: () => void;
  readonly onStarted: (runId: string) => void;
  readonly recover: ReturnType<typeof useStartMailRecover>;
}) {
  const [target, setTarget] = useState(defaultTarget);
  const [typed, setTyped] = useState('');

  const handleRun = async () => {
    try {
      const r = await recover.mutateAsync({ targetNode: target, confirmTargetNode: typed });
      onStarted(r.data.runId);
    } catch {
      // surfaced via recover.isError
    }
  };

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid="mail-recover-modal"
    >
      <div
        className="w-full max-w-xl rounded-xl bg-white dark:bg-gray-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-6 py-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <AlertTriangle size={18} className="text-red-500" />
            Recover mail to a working node
          </h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-800 dark:text-red-200">
            <strong>This is destructive.</strong> Recovery deletes the
            current (broken) PVC and re-creates it on the chosen target.
            Data not already in the rsync standby for that target OR in
            the offsite restic repo will be PERMANENTLY LOST.
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Target node</label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500"
              data-testid="mail-recover-target-select"
            >
              {candidates.map((c) => {
                const isBroken = c.hostname === brokenNode;
                const isUnready = !c.ready;
                const suffix = isBroken
                  ? ' — CURRENTLY BROKEN (will re-trigger same failure)'
                  : isUnready
                    ? ' — NotReady'
                    : '';
                return (
                  <option key={c.hostname} value={c.hostname}>
                    {c.hostname} ({c.role}{suffix})
                  </option>
                );
              })}
            </select>
            {target === brokenNode && (
              <p className="mt-1 text-xs text-red-700 dark:text-red-400 font-medium">
                You're picking the currently-broken node as the recovery target.
                Unless you've already fixed the underlying issue (network, disk,
                node label), this will re-trigger the same failure.
              </p>
            )}
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Mail-standby-labelled targets restore in seconds via FAST PATH
              from the local rsync data. Other targets fall back to restic-restore
              from the offsite backup (slower; needs backup-rclone-shim reachability
              from the target node).
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
              Type <code className="font-mono px-1 rounded bg-gray-100 dark:bg-gray-700">{target}</code> to confirm
            </label>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500"
              data-testid="mail-recover-confirm-input"
              autoFocus
            />
          </div>

          {recover.isError && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
              Recovery failed: {(recover.error as Error).message}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRun}
              disabled={typed !== target || !target || recover.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="mail-recover-run"
            >
              {recover.isPending ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
              {recover.isPending ? 'Starting…' : 'Recover Mail'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
