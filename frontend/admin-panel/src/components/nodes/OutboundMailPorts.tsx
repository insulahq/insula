import type { OutboundMailPort } from '@insula/api-contracts';

/**
 * A node's outbound mail ports as pills — node health and mail health.
 *
 *   green  open
 *   red    blocked, and the node needs it (465/587 anywhere, 25 on a mail node)
 *   grey   blocked but not needed here (25 on a node that never hosts the mail
 *          server), unknown (no target resolved), or the result is stale
 *
 * The hover title says what each target answered, which is what the operator
 * forwards to the hosting provider.
 */

export interface OutboundMailPortsProps {
  readonly ports: ReadonlyArray<OutboundMailPort>;
  /** The node's probe has not reported for three intervals: shown dimmed, not judged. */
  readonly stale?: boolean;
  readonly testId?: string;
}

const PILL = 'inline-block rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums';

function pillClass(p: OutboundMailPort, stale: boolean): string {
  if (stale || p.status === 'unknown') return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  if (p.status === 'open') return 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300';
  return p.required
    ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
    : 'bg-gray-100 text-gray-600 line-through decoration-gray-400 dark:bg-gray-800 dark:text-gray-400';
}

export function outboundPortTitle(p: OutboundMailPort, stale = false): string {
  const head = p.status === 'open'
    ? `Port ${p.port} open — ${p.target ?? 'a target'} accepted${p.latencyMs !== null ? ` in ${p.latencyMs} ms` : ''}`
    : p.status === 'blocked'
      ? `Port ${p.port} blocked${p.required ? '' : ' (not needed on this node — only a mail node delivers on it)'}`
      : `Port ${p.port} not checked — no target resolved`;
  const detail = p.detail ? `\n${p.detail}` : '';
  return `${head}${detail}${stale ? '\nThis result is stale: the node\'s probe has not reported recently.' : ''}`;
}

export default function OutboundMailPorts({ ports, stale = false, testId }: OutboundMailPortsProps) {
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${stale ? 'opacity-60' : ''}`} data-testid={testId}>
      {ports.map((p) => (
        <span
          key={p.port}
          className={`${PILL} ${pillClass(p, stale)}`}
          title={outboundPortTitle(p, stale)}
          data-testid={testId ? `${testId}-${p.port}` : undefined}
          data-status={p.status}
          data-required={p.required ? 'true' : 'false'}
        >
          {p.port}{p.status === 'blocked' ? ' blocked' : p.status === 'unknown' ? ' ?' : ''}
        </span>
      ))}
      {stale && <span className="text-[10px] text-gray-500 dark:text-gray-400">stale</span>}
    </span>
  );
}
