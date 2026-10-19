import type { WorkerUsage } from '@/hooks/use-worker-usage';

/**
 * Render "free / total" CPU + RAM + Disk for the worker selector
 * dropdown. Returns an empty string when usage data is unavailable so
 * the option still shows the bare node name. Examples:
 *   " — 3.2/6 CPUs · 6.5/8 GB RAM · 60/80 GB disk available"
 *   ""   (usage not yet loaded)
 */
export function formatAvailability(usage: WorkerUsage | undefined): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.cpuMillicoresAllocatable != null && usage.cpuMillicoresUsed != null) {
    const total = usage.cpuMillicoresAllocatable / 1000;
    const free = Math.max(0, (usage.cpuMillicoresAllocatable - usage.cpuMillicoresUsed) / 1000);
    parts.push(`${free.toFixed(2)}/${total.toFixed(0)} CPUs`);
  }
  if (usage.memoryBytesAllocatable != null && usage.memoryBytesUsed != null) {
    const total = usage.memoryBytesAllocatable / 1024 ** 3;
    const free = Math.max(0, (usage.memoryBytesAllocatable - usage.memoryBytesUsed) / 1024 ** 3);
    parts.push(`${free.toFixed(1)}/${total.toFixed(0)} GB RAM`);
  }
  if (usage.diskBytesTotal != null && usage.diskBytesFree != null) {
    const total = usage.diskBytesTotal / 1024 ** 3;
    const free = usage.diskBytesFree / 1024 ** 3;
    parts.push(`${free.toFixed(0)}/${total.toFixed(0)} GB disk`);
  }
  return parts.length > 0 ? ` — ${parts.join(' · ')} available` : '';
}
