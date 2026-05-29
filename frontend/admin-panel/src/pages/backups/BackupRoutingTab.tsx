/**
 * `<BackupRoutingTab>` — the tab (c) of every backup-class page.
 *
 * Phase 3 (2026-05-22) consolidates three previously-scattered
 * surfaces into one tab per class:
 *
 *   1. Targets   — which Remote Storage Target the class binds to.
 *                  Operator picks via the shim apply pipeline (drain →
 *                  reconcile → verify). Identical to the legacy
 *                  BackupRcloneShimSettings flow, scoped to this class.
 *
 *   2. Schedules — every `backup_schedules.subsystem` row relevant to
 *                  the class (system → system_pitr, tenant → tenant_bundle,
 *                  mail → mail). Each row inline-edits cron + enabled +
 *                  retention via the existing ScheduleCard component.
 *
 *   3. Retention — placeholder for Phase 5 retention-policy sliders.
 *                  Retention currently lives on the ScheduleCard
 *                  (retentionDays / retentionCount fields); a future
 *                  refactor may surface it as its own section. For
 *                  now we surface a per-class summary read from the
 *                  schedule rows.
 */

import { useState } from 'react';
import { Cloud, Loader2, Power, PowerOff, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { BackupShimClass } from '@insula/api-contracts';
import {
  useShimAssignments,
  usePutShimAssignment,
} from '@/hooks/use-backup-rclone-shim';
import { useBackupConfigs } from '@/hooks/use-backup-config';
import ScheduleCard from '@/components/backups/ScheduleCard';
import WalArchiveTab from '@/components/system-backup/WalArchiveTab';
import PreSwitchConfirmModal from '@/components/backups/PreSwitchConfirmModal';

interface Props {
  readonly shimClass: BackupShimClass;
  readonly scheduleSubsystems: ReadonlyArray<string>;
}

// Subsystem labels for the schedules section. Lifted from the legacy
// per-page hard-codings so each ScheduleCard renders with a meaningful
// title + description.
const SCHEDULE_META: Record<string, { title: string; description: string }> = {
  mail: {
    title: 'Mail snapshot schedule',
    description: 'Restic backup of /var/lib/stalwart/data — runs as a CronJob in the mail namespace.',
  },
  system_pitr: {
    title: 'Postgres PITR base backups',
    description: 'Daily base backup of the platform postgres. WAL archiving runs continuously when enabled.',
  },
  tenant_bundle: {
    title: 'Tenant bundle schedule',
    description: 'Nightly Plesk-style bundles: files + mailboxes + config per tenant.',
  },
  longhorn_recurring: {
    title: 'Longhorn recurring snapshots',
    description: 'Block-snapshot every PVC with the recurring-job label.',
  },
};

export default function BackupRoutingTab({ shimClass, scheduleSubsystems }: Props) {
  const assignmentsQuery = useShimAssignments();
  const configsQuery = useBackupConfigs();
  const put = usePutShimAssignment();

  const assignments = assignmentsQuery.data?.data?.assignments ?? [];
  const row = assignments.find((a) => a.className === shimClass);
  const bound = !!row?.targetId;

  // Phase 5 (2026-05-24): pre-switch confirm modal state. Set when
  // the operator picks a new target OR clicks unbind. When set,
  // render PreSwitchConfirmModal which loads the preview + waits for
  // operator Confirm. `targetId: null` is the unbind case — modal
  // copy adapts. Modal closes by clearing this state.
  const [pendingSwitch, setPendingSwitch] = useState<
    | null
    | { targetId: string | null; targetLabel: string }
  >(null);

  const allConfigs = configsQuery.data?.data ?? [];
  // `c.enabled` is typed `number` (legacy 0/1) but a future API
  // normalisation could flip it to `boolean`; truthy-check works for
  // both.
  const enabledConfigs = allConfigs.filter((c) => !!c.enabled);

  return (
    <div className="space-y-6">
      {/* ── Targets section ────────────────────────────────────────── */}
      <section
        className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
        data-testid="routing-tab-targets"
      >
        <header className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Cloud size={16} className="text-gray-500" />
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Target binding
            </h2>
          </div>
          <Link
            to="/backups/targets"
            className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-300"
          >
            Manage targets →
          </Link>
        </header>

        {assignmentsQuery.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 size={14} className="animate-spin" /> Loading binding…
          </div>
        ) : bound ? (
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Target" value={row?.targetName ?? '—'} mono />
              <Field
                label="Storage type"
                value={(row?.targetStorageType ?? '—').toString().toUpperCase()}
                pill
              />
              <Field label="Drain timeout" value={`${row?.drainTimeoutSeconds ?? 0}s`} mono />
            </div>

            <TargetSwitcher
              shimClass={shimClass}
              currentTargetId={row?.targetId ?? null}
              enabledConfigs={enabledConfigs}
              onPick={(targetId) => {
                // Phase 5: open the pre-switch confirm modal instead of
                // firing the PUT immediately. Operator sees what will
                // be paused (schedules + WAL) and confirms before the
                // switch happens.
                const tgt = enabledConfigs.find((c) => c.id === targetId);
                setPendingSwitch({
                  targetId,
                  targetLabel: tgt ? `${tgt.name} (${tgt.storageType.toUpperCase()})` : targetId,
                });
              }}
              onUnbind={() => {
                // Phase 5 (2026-05-24): route unbind through the same
                // pre-switch modal as switch — operator sees the full
                // list of schedules + WAL that pause as part of the
                // unbind. Modal copy adapts to the null-target case.
                setPendingSwitch({
                  targetId: null,
                  targetLabel: '(unbind — no target)',
                });
              }}
              isPending={put.isPending}
            />
          </div>
        ) : (
          <div className="rounded border border-dashed border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <p>
                  <span className="font-semibold">No target bound.</span>{' '}
                  Snapshots of this class still run, but nothing is uploaded
                  off-cluster — cluster loss is unrecoverable until a target is bound.
                </p>
                <TargetSwitcher
                  shimClass={shimClass}
                  currentTargetId={null}
                  enabledConfigs={enabledConfigs}
                  onPick={(targetId) => {
                    const tgt = enabledConfigs.find((c) => c.id === targetId);
                    setPendingSwitch({
                      targetId,
                      targetLabel: tgt ? `${tgt.name} (${tgt.storageType.toUpperCase()})` : targetId,
                    });
                  }}
                  isPending={put.isPending}
                />
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Schedules section ──────────────────────────────────────── */}
      {scheduleSubsystems.length > 0 && (
        <section
          className="space-y-3"
          data-testid="routing-tab-schedules"
          aria-label="Schedules"
        >
          <header className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Schedules</h2>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              ({scheduleSubsystems.length})
            </span>
          </header>
          {scheduleSubsystems.map((subsystem) => {
            const meta = SCHEDULE_META[subsystem] ?? {
              title: subsystem,
              description: `Schedule for ${subsystem}.`,
            };
            // ScheduleCard's prop union narrows subsystem to its 4
            // known values; cast preserves the runtime contract.
            return (
              <ScheduleCard
                key={subsystem}
                subsystem={subsystem as Parameters<typeof ScheduleCard>[0]['subsystem']}
                title={meta.title}
                description={meta.description}
              />
            );
          })}
        </section>
      )}

      {/* ── WAL Streaming (system class only) ──────────────────────
          Phase 4 (2026-05-24): WAL Archive configuration moved from
          the Backups tab. It's a target+cadence decision (which S3
          gets the WAL stream, how often a base backup runs) so it
          belongs alongside Targets + Schedules. Only the `system`
          class hosts a CNPG cluster, so we render it conditionally. */}
      {shimClass === 'system' && (
        <section
          className="space-y-3"
          data-testid="routing-tab-wal-streaming"
          aria-label="WAL Streaming"
          id="wal-streaming"
        >
          <header className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              WAL Streaming
            </h2>
          </header>
          <WalArchiveTab />
        </section>
      )}

      {/* ── Retention info box ─────────────────────────────────────── */}
      <section
        className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-200"
        data-testid="routing-tab-retention"
      >
        <p className="font-semibold">Retention policy</p>
        <p className="mt-1">
          Retention for snapshots in this class is controlled per-schedule
          (Days / Count fields on each Schedule card above). A dedicated
          per-class retention panel is planned — for now, edit the values
          inline.
        </p>
      </section>

      {/* Phase 5 (2026-05-24): pre-switch confirm modal — opens when the
          operator picks a new target in TargetSwitcher; on confirm calls
          the atomic switch-with-pause endpoint. */}
      {pendingSwitch && (
        <PreSwitchConfirmModal
          className={shimClass}
          newTargetId={pendingSwitch.targetId}
          newTargetLabel={pendingSwitch.targetLabel}
          onClose={() => setPendingSwitch(null)}
        />
      )}
    </div>
  );
}

// ── small helpers ──────────────────────────────────────────────────

function Field({
  label,
  value,
  mono,
  pill,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly pill?: boolean;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </div>
      {pill ? (
        <span className="mt-0.5 inline-block rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-300">
          {value}
        </span>
      ) : (
        <div
          className={
            mono
              ? 'font-mono text-sm text-gray-900 dark:text-gray-100'
              : 'text-sm text-gray-900 dark:text-gray-100'
          }
        >
          {value}
        </div>
      )}
    </div>
  );
}

interface TargetSwitcherProps {
  readonly shimClass: BackupShimClass;
  readonly currentTargetId: string | null;
  readonly enabledConfigs: ReadonlyArray<{ id: string; name: string; storageType: string }>;
  readonly onPick: (targetId: string) => void;
  readonly onUnbind?: () => void;
  readonly isPending: boolean;
}

function TargetSwitcher({
  currentTargetId,
  enabledConfigs,
  onPick,
  onUnbind,
  isPending,
}: TargetSwitcherProps) {
  if (enabledConfigs.length === 0) {
    return (
      <p className="text-xs text-gray-500 dark:text-gray-400">
        No enabled Remote Storage Targets. Create one in{' '}
        <Link to="/backups/targets" className="font-medium text-brand-600 hover:underline dark:text-brand-300">
          Remote Storage Targets
        </Link>{' '}
        first.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        value={currentTargetId ?? ''}
        onChange={(e) => {
          const id = e.target.value;
          if (id && id !== currentTargetId) onPick(id);
        }}
        disabled={isPending}
        data-testid="routing-tab-target-switch"
      >
        <option value="">— Pick a target —</option>
        {enabledConfigs.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.storageType.toUpperCase()})
          </option>
        ))}
      </select>
      {currentTargetId && onUnbind && (
        <button
          type="button"
          onClick={onUnbind}
          disabled={isPending}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <PowerOff size={12} /> Unbind
        </button>
      )}
      {!currentTargetId && (
        <span className="inline-flex items-center gap-1 text-xs text-gray-500">
          <Power size={12} /> Click target to bind
        </span>
      )}
      {isPending && (
        <span className="inline-flex items-center gap-1 text-xs text-gray-500">
          <Loader2 size={12} className="animate-spin" /> Applying…
        </span>
      )}
    </div>
  );
}
