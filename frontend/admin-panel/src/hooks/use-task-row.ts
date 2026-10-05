// One task-center row, followed live, for a progress modal that renders it.
//
// Reads the chip's own snapshot (polled every 3 s while anything runs), so a
// modal costs no extra request. The snapshot only carries running tasks and
// ones that finished in the last 5 minutes — so the row is REMEMBERED once
// seen: a modal left open on a finished recovery keeps its result after the
// row ages out of the feed. The chip's own copy of the row (`taskStatus` /
// `taskDetails`, passed when it re-opens a modal) covers the first render.

import { useRef } from 'react';
import type { TaskRow, TaskStatus } from '@insula/api-contracts';
import { useTaskCenter } from '@/hooks/use-task-center';

export interface TaskRowFallback {
  readonly taskStatus?: TaskStatus;
  readonly taskDetails?: Record<string, unknown> | null;
}

export interface FollowedTask {
  readonly task: TaskRow | undefined;
  readonly status: TaskStatus;
  readonly details: Record<string, unknown> | null;
  readonly running: boolean;
  /**
   * The server's clock at the last poll (epoch ms), for comparing against the
   * row's server-written timestamps without trusting the browser's clock.
   */
  readonly serverNow: number | null;
}

export function useTaskRow(taskId: string, fallback: TaskRowFallback = {}): FollowedTask {
  const { data } = useTaskCenter();
  const live = data?.data?.tasks?.find((t) => t.id === taskId);
  const remembered = useRef<TaskRow | undefined>(undefined);
  if (live) remembered.current = live;
  const task = live ?? remembered.current;
  const status: TaskStatus = task?.status ?? fallback.taskStatus ?? 'running';
  const serverNow = data?.data?.serverTime ? Date.parse(data.data.serverTime) : NaN;
  return {
    task,
    status,
    details: task?.details ?? fallback.taskDetails ?? null,
    running: status === 'running' || status === 'queued',
    serverNow: Number.isNaN(serverNow) ? null : serverNow,
  };
}
