// Top-bar Task Tracker chip — replaces ActiveTasksIndicator.
//
// Shows a count of in-flight tasks; turns green when a task succeeds
// (briefly) and red when one fails. Click → popover listing running +
// recently-completed tasks. Each row is clickable: opens the task's
// registered modal, or navigates to the task's `target.href` route.
// "Clear completed" wipes terminal rows from the chip.
//
// Phase 1 uses polling (see use-task-center.ts). SSE wiring is
// Phase 5 polish.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Loader2, CheckCircle2, AlertTriangle, Activity, X, Trash2, ChevronRight, Clock,
} from 'lucide-react';
import clsx from 'clsx';
import type { TaskRow } from '@k8s-hosting/api-contracts';
import { useTaskCenter, useClearTasks } from '@/hooks/use-task-center';
import { TaskModalHost } from '@/tasks/modal-registry';

const RECENT_TERMINAL_WINDOW_MS = 5 * 60 * 1000;

interface SelectedModal {
  readonly modal: string;
  readonly props: Record<string, unknown>;
}

export default function TaskCenterChip() {
  const { data, isLoading } = useTaskCenter();
  const clearTasks = useClearTasks();
  const [open, setOpen] = useState(false);
  const [selectedModal, setSelectedModal] = useState<SelectedModal | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const tasks = data?.data?.tasks ?? [];
  const running = useMemo(
    () => tasks.filter((t) => t.status === 'running' || t.status === 'queued'),
    [tasks],
  );
  const recentTerminal = useMemo(() => {
    const cutoff = Date.now() - RECENT_TERMINAL_WINDOW_MS;
    return tasks.filter((t) => {
      if (t.status === 'running' || t.status === 'queued') return false;
      if (!t.finishedAt) return false;
      const ts = new Date(t.finishedAt).getTime();
      return ts >= cutoff && !t.clearedAt;
    });
  }, [tasks]);

  const runningCount = running.length;
  const failedCount = recentTerminal.filter((t) => t.status === 'failed').length;
  const succeededCount = recentTerminal.filter((t) => t.status === 'succeeded').length;

  // Always-visible chip (Phase 3 UX): even when nothing is in flight,
  // the chip is rendered as a neutral icon-only pill. This anchors the
  // tracker in the header so operators always know where to look, and
  // makes the tone-change on a new task land in a stable spot. The
  // first-load loading flicker is hidden until the snapshot resolves.
  if (isLoading) return null;

  // Chip tone: red wins over amber wins over green wins over blue,
  // gray for idle.
  const tone =
    failedCount > 0 ? 'red'
    : runningCount > 0 ? 'blue'
    : succeededCount > 0 ? 'green'
    : 'gray';

  const chipClass = clsx(
    'relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors',
    tone === 'red' && 'bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-900/50',
    tone === 'blue' && 'bg-brand-50 text-brand-700 hover:bg-brand-100 dark:bg-brand-900/30 dark:text-brand-300 dark:hover:bg-brand-900/50',
    tone === 'green' && 'bg-green-50 text-green-700 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50',
    tone === 'gray' && 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600',
  );

  const ChipIcon =
    failedCount > 0 ? AlertTriangle
    : runningCount > 0 ? Loader2
    : succeededCount > 0 ? CheckCircle2
    : Activity;

  // Idle chip is icon-only to keep the header tidy. When something is
  // in flight or recently terminal, surface the count so a glance is
  // enough.
  const chipLabel = runningCount > 0
    ? `${runningCount} running`
    : failedCount > 0
      ? `${failedCount} failed`
      : succeededCount > 0
        ? `${succeededCount} done`
        : 'Tasks';

  const onSelect = (task: TaskRow) => {
    if (task.target.type === 'modal') {
      // Inject `taskId` into modalProps so progress modals that key
      // off the task row itself (MailTaskProgressModal etc.) can
      // resolve it without each backend writer duplicating the
      // task's own id into modalProps. Per-target modalProps still
      // win on key collision — useful for modals that want a
      // different taskId surface name.
      setSelectedModal({
        modal: task.target.modal,
        props: { taskId: task.id, ...(task.target.modalProps ?? {}) },
      });
      setOpen(false);
      return;
    }
    if (task.target.type === 'route') {
      navigate(task.target.href);
      setOpen(false);
    }
  };

  const closeModal = () => setSelectedModal(null);

  return (
    <>
      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((p) => !p)}
          className={chipClass}
          data-testid="task-center-chip"
          aria-label={`Task center — ${chipLabel}`}
          aria-expanded={open}
        >
          <ChipIcon
            size={14}
            className={runningCount > 0 ? 'animate-spin' : undefined}
          />
          <span>{chipLabel}</span>
        </button>

        {open && (
          <div
            className="absolute right-0 z-50 mt-2 w-96 rounded-xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800"
            data-testid="task-center-popover"
          >
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Tasks
              </h3>
              <div className="flex items-center gap-2">
                {recentTerminal.length > 0 && (
                  <button
                    type="button"
                    onClick={() => clearTasks.mutate(undefined)}
                    disabled={clearTasks.isPending}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-700"
                    data-testid="task-center-clear-completed"
                    title="Clear completed tasks from this list"
                  >
                    <Trash2 size={12} /> Clear completed
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                  aria-label="Close"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            <div className="max-h-96 overflow-y-auto">
              {tasks.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-gray-500 dark:text-gray-400">
                  No tasks running.
                </div>
              ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-700" data-testid="task-center-list">
                  {[...running, ...recentTerminal].map((task) => (
                    <TaskRowItem key={task.id} task={task} onSelect={onSelect} />
                  ))}
                </ul>
              )}
            </div>

            <div className="border-t border-gray-100 px-4 py-2 text-[10px] text-gray-400 dark:border-gray-700 dark:text-gray-500">
              Updates every {runningCount > 0 ? '3' : '30'} seconds. Completed tasks auto-expire after 5 minutes.
            </div>
          </div>
        )}
      </div>

      {selectedModal && (
        <TaskModalHost
          modal={selectedModal.modal}
          props={selectedModal.props}
          onClose={closeModal}
        />
      )}
    </>
  );
}

/**
 * 1Hz clock tick so running-task rows update their elapsed counter
 * without waiting for the next snapshot poll. Returns a number that
 * changes every second; components depending on it re-render.
 */
function useNowSecond(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Format a duration in seconds → "12s" / "3m 42s" / "1h 5m" / "2d 3h". */
function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Format an ISO timestamp as "Jan 24, 13:42" — local time, compact. */
function formatStartedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

function TaskRowItem({ task, onSelect }: { task: TaskRow; onSelect: (t: TaskRow) => void }) {
  const tone =
    task.status === 'failed' ? 'red'
    : task.status === 'succeeded' ? 'green'
    : task.status === 'running' || task.status === 'queued' ? 'blue'
    : 'gray';

  const Icon =
    task.status === 'failed' ? AlertTriangle
    : task.status === 'succeeded' ? CheckCircle2
    : task.status === 'running' || task.status === 'queued' ? Loader2
    : Activity;

  const label = task.label;
  const subline = task.errorMessage
    ? task.errorMessage
    : task.progressText
      ? task.progressText
      : task.kind;

  // Time info: running tasks show "started <ts> · running for <elapsed>"
  // with a 1Hz live counter; terminal tasks show "ran <duration> ·
  // finished <ts>". Operator requested 2026-05-23.
  const isRunning = task.status === 'running' || task.status === 'queued';
  const nowSec = useNowSecond();
  const timeInfo = useMemo(() => {
    const startedSec = Math.floor(new Date(task.startedAt).getTime() / 1000);
    if (!Number.isFinite(startedSec)) return null;
    if (isRunning) {
      const elapsed = Math.max(0, nowSec - startedSec);
      return {
        icon: <Clock size={10} className="-mt-0.5 mr-1 inline" />,
        text: <>started {formatStartedAt(task.startedAt)} · running for <span className="font-mono">{formatElapsed(elapsed)}</span></>,
      };
    }
    if (task.finishedAt) {
      const finishedSec = Math.floor(new Date(task.finishedAt).getTime() / 1000);
      if (!Number.isFinite(finishedSec)) return null;
      const total = Math.max(0, finishedSec - startedSec);
      return {
        icon: <Clock size={10} className="-mt-0.5 mr-1 inline" />,
        text: <>ran <span className="font-mono">{formatElapsed(total)}</span> · finished {formatStartedAt(task.finishedAt)}</>,
      };
    }
    return null;
  }, [task.startedAt, task.finishedAt, isRunning, nowSec]);

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(task)}
        className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/40"
        data-testid={`task-center-row-${task.id}`}
      >
        <Icon
          size={14}
          className={clsx(
            'mt-0.5 shrink-0',
            tone === 'red' && 'text-red-600 dark:text-red-400',
            tone === 'green' && 'text-green-600 dark:text-green-400',
            tone === 'blue' && 'text-brand-600 dark:text-brand-400 animate-spin',
            tone === 'gray' && 'text-gray-400',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-gray-900 dark:text-gray-100">
            {label}
          </div>
          <div className="truncate text-[11px] text-gray-500 dark:text-gray-400">
            {subline}
          </div>
          {timeInfo && (
            <div className="truncate text-[10px] text-gray-500 dark:text-gray-400" data-testid={`task-row-time-${task.id}`}>
              {timeInfo.icon}
              {timeInfo.text}
            </div>
          )}
          {task.progressPct != null && (task.status === 'running' || task.status === 'queued') && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className={clsx(
                  'h-full transition-all',
                  tone === 'red' && 'bg-red-500',
                  tone !== 'red' && 'bg-brand-500',
                )}
                style={{ width: `${task.progressPct}%` }}
              />
            </div>
          )}
        </div>
        <ChevronRight size={12} className="mt-1 shrink-0 text-gray-300 dark:text-gray-600" />
      </button>
    </li>
  );
}

