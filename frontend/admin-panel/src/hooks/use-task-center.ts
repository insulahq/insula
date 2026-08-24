// Task Tracker hooks — chip + popover read state.
//
// Phase 1 ships with polling. The SSE endpoint (`/me/tasks/stream`) is
// implemented on the backend but Phase 1 frontend uses TanStack Query
// adaptive polling: 3 s when any task is running, 30 s idle. SSE wiring
// is Phase 5 polish — polling delivers the user-visible behaviour
// (chip lights up, count is right, click opens modal) at < 30 s
// resolution which is acceptable for the chip's purpose.

import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import type {
  ClearTasksResponse,
  MeTasksSnapshotResponse,
  TaskRow,
} from '@insula/api-contracts';

export const TASK_CENTER_QUERY_KEY = ['task-center', 'me'] as const;

const POLL_RUNNING_MS = 3_000;
const POLL_IDLE_MS = 30_000;

/**
 * Read the chip's working set: in-flight + recent terminal (≤ 5 min)
 * tasks for the current user. Adaptive cadence — 3 s while anything
 * is running, 30 s when idle.
 */
export function useTaskCenter() {
  return useQuery({
    queryKey: TASK_CENTER_QUERY_KEY,
    queryFn: () => apiFetch<MeTasksSnapshotResponse>('/api/v1/me/tasks'),
    staleTime: 1_000,
    refetchInterval: (query) => {
      const tasks = query.state.data?.data?.tasks ?? [];
      const anyRunning = tasks.some(
        (t: TaskRow) => t.status === 'queued' || t.status === 'running',
      );
      return anyRunning ? POLL_RUNNING_MS : POLL_IDLE_MS;
    },
    // Always refetch on window focus — operators come back to the tab
    // and want a fresh count immediately.
    refetchOnWindowFocus: 'always',
  });
}

export function useClearTasks() {
  const qc = useQueryClient();
  return useMutation({
    // Tagged so the global MutationCache subscriber (App.tsx) skips it
    // — otherwise clearing tasks would trigger a chip refetch that
    // immediately re-fetches the just-cleared list.
    mutationKey: ['task-center', 'clear'],
    mutationFn: (ids?: readonly string[]) =>
      apiFetch<ClearTasksResponse>('/api/v1/me/tasks/clear', {
        method: 'POST',
        body: JSON.stringify(ids ? { ids: [...ids] } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TASK_CENTER_QUERY_KEY });
    },
  });
}

/**
 * Returns a function that mutations triggering long-running ops can
 * call to force-refetch the chip immediately. Without this, a new task
 * row only surfaces on the next 3 s polling tick — perceptible lag for
 * a click-to-spinner UX.
 *
 * Usage in a trigger mutation:
 *
 *   const refreshTasks = useRefreshTaskCenter();
 *   const startBackup = useMutation({
 *     mutationFn: () => apiFetch('/.../start', { method: 'POST' }),
 *     onSuccess: () => refreshTasks(),
 *   });
 */
export function useRefreshTaskCenter() {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: TASK_CENTER_QUERY_KEY });
  }, [qc]);
}

// ─── Completion → query refresh (2026-08-24) ────────────────────────────────
//
// Operator complaint: manual backup runs for system, tenant and mail
// completed in the task center but the pages kept showing the OLD list
// until a manual reload. The task poller already knows the moment a task
// reaches a terminal state — bridge that into TanStack Query by
// invalidating the query families a task kind affects. Invalidation is
// cheap: only MOUNTED queries refetch.

/** kind prefix → query-key prefixes to invalidate when such a task ends. */
const COMPLETION_REFRESH_MAP: ReadonlyArray<{
  match: (kind: string) => boolean;
  keys: ReadonlyArray<ReadonlyArray<string>>;
}> = [
  {
    // backup.run / backup.bundle / backup.speedtest / backup.shim.*
    match: (k) => k.startsWith('backup.'),
    keys: [
      ['system-backup'],
      ['backups'],
      ['backup-configs'],
      ['cnpg-backup-health'],
      ['backup-rclone-shim'],
      ['admin', 'tenant-bundles'],
      ['mail', 'backups'],
      ['mail', 'snapshot'],
    ],
  },
  {
    // mail.snapshot.trigger / mail.archive / mail.migration / …
    match: (k) => k.startsWith('mail.'),
    keys: [['mail']],
  },
  {
    // storage.snapshot / storage.restore / storage.grow / …
    match: (k) => k.startsWith('storage.'),
    keys: [
      ['admin-tenant-snapshots'],
      ['snapshots'],
      ['storage-operations'],
      ['tenants'],
    ],
  },
  {
    match: (k) => k.startsWith('postgres.'),
    keys: [['cnpg-backup-health'], ['system-backup']],
  },
  {
    match: (k) => k.startsWith('restore.'),
    keys: [
      ['backups'],
      ['admin', 'tenant-bundles'],
      ['admin-tenant-snapshots'],
      ['snapshots'],
      ['mail', 'backups'],
    ],
  },
  {
    match: (k) => k.startsWith('tenant.'),
    keys: [['tenants']],
  },
];

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Watches the task-center working set and invalidates the affected query
 * families the moment a task reaches a terminal state. Mount ONCE in the
 * admin shell (TaskCenterChip does) — every open page then refreshes
 * automatically when its background work finishes.
 */
export function useTaskCompletionRefresher(): void {
  const qc = useQueryClient();
  const { data } = useTaskCenter();
  const running = useRef<Map<string, string>>(new Map());
  // Terminal ids we already handled (fired or baselined) — a fast task
  // can complete inside one poll interval and be FIRST seen terminal,
  // so "was tracked as running" alone misses it.
  const processed = useRef<Set<string>>(new Set());
  const baselined = useRef(false);

  useEffect(() => {
    if (!data) return;
    const rows: TaskRow[] = data.data?.tasks ?? [];
    const finishedKinds: string[] = [];
    const presentIds = new Set<string>();
    for (const t of rows) {
      presentIds.add(t.id);
      if (t.status === 'queued' || t.status === 'running') {
        running.current.set(t.id, t.kind);
        continue;
      }
      if (!TERMINAL_STATUSES.has(t.status)) continue;
      running.current.delete(t.id);
      if (processed.current.has(t.id)) continue;
      processed.current.add(t.id);
      // Terminal rows in the very first snapshot predate this mount —
      // seed them silently instead of refreshing on page load.
      if (baselined.current) finishedKinds.push(t.kind);
    }
    // A tracked task can vanish from the snapshot without us seeing its
    // terminal row (cleared between polls, or aged out of the recent
    // window). Treat disappearance as completion — we stored the kind.
    for (const [id, kind] of running.current) {
      if (presentIds.has(id)) continue;
      running.current.delete(id);
      if (!processed.current.has(id)) {
        processed.current.add(id);
        if (baselined.current) finishedKinds.push(kind);
      }
    }
    // Bound memory: forget processed ids that left the snapshot
    // (cleared terminal tasks never reappear under the same id).
    for (const id of processed.current) {
      if (!presentIds.has(id)) processed.current.delete(id);
    }
    baselined.current = true;
    for (const kind of finishedKinds) {
      for (const entry of COMPLETION_REFRESH_MAP) {
        if (!entry.match(kind)) continue;
        for (const key of entry.keys) {
          void qc.invalidateQueries({ queryKey: key as unknown as readonly unknown[] });
        }
      }
    }
  }, [data, qc]);
}
