import type { NodeMemoryEvent } from '@insula/api-contracts';

/**
 * What the row says happened — never more than its `cause` supports. An exit
 * 137 the platform could not confirm used to be labelled "OOM-killed" here
 * while its message said "cause unconfirmed".
 */
export function memoryEventLabel(e: NodeMemoryEvent): string {
  const sys = e.systemWorkload ? ' (SYSTEM)' : '';
  if (e.kind === 'system-oom') return 'Node out of memory';
  if (e.kind === 'container-oom') {
    switch (e.cause) {
      case 'memory-limit': return `OOM at memory limit${sys}`;
      case 'node-oom': return `OOM (node out of memory)${sys}`;
      case 'unconfirmed': return `SIGKILL, cause unconfirmed${sys}`;
      default: return `OOM-killed${sys}`;
    }
  }
  switch (e.cause) {
    case 'node-memory-pressure': return `Evicted: memory pressure${sys}`;
    case 'node-disk-pressure': return `Evicted: disk pressure${sys}`;
    case 'node-pid-pressure': return `Evicted: PID pressure${sys}`;
    case 'pod-storage-limit': return `Evicted: storage limit${sys}`;
    default: return `Evicted${sys}`;
  }
}

/** Unconfirmed kills are grey: they are not evidence of a memory problem. */
export function memoryEventBadgeClass(e: NodeMemoryEvent): string {
  if (e.kind === 'container-oom' && e.cause === 'unconfirmed') {
    return 'inline-block rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
  return e.systemWorkload
    ? 'inline-block rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300'
    : 'inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
}
