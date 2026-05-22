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

import { Cloud, Loader2, Power, PowerOff, AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { BackupShimClass } from '@k8s-hosting/api-contracts';
import {
  useShimAssignments,
  usePutShimAssignment,
} from '@/hooks/use-backup-rclone-shim';
import { useBackupConfigs } from '@/hooks/use-backup-config';
import ScheduleCard from '@/components/backups/ScheduleCard';

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
              onPick={(targetId) => put.mutate({ className: shimClass, input: { targetId, force: false } })}
              onUnbind={() => {
                if (
                  window.confirm(
                    `Unbind ${shimClass.toUpperCase()}? In-flight backups will be drained (up to ${row?.drainTimeoutSeconds ?? 0}s) before the shim reconciles.`,
                  )
                ) {
                  put.mutate({ className: shimClass, input: { targetId: null, force: false } });
                }
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
                  onPick={(targetId) => put.mutate({ className: shimClass, input: { targetId, force: false } })}
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
