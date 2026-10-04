import { Plus, Minus, Ban, Pause } from 'lucide-react';
import type { HeldRecord, IngressServer, StaleRecord } from '@insula/api-contracts';
import NodeName from '@/components/nodes/NodeName';

/** Why an address is stale, in the operator's words. */
export const STALE_REASON_LABEL: Record<StaleRecord['reason'], string> = {
  'server-removed': 'server removed',
  'ingress-disabled': 'ingress disabled',
  private: 'server is private',
  'no-longer-ingress': 'no longer an ingress address',
  'platform-created': 'created by the platform, no longer an ingress address',
};

/** Why an address that is not expected is kept anyway. */
export const HELD_REASON_LABEL: Record<HeldRecord['reason'], string> = {
  'server-not-ready': 'kept — the server is not ready right now and may come back',
  'manual-record': 'kept — a hand-made DNS record publishes it',
};

export const SERVER_STATUS_LABEL: Record<IngressServer['status'], string> = {
  ingress: 'serves ingress',
  'ingress-disabled': 'ingress disabled',
  private: 'private',
  'not-ready': 'not ready',
  'no-public-ip': 'no public address',
  removed: 'removed',
  'not-in-override': 'not in the operator override',
};

export function ServerNames({ servers }: { readonly servers: readonly string[] }) {
  if (servers.length === 0) return null;
  return (
    <span className="text-gray-500 dark:text-gray-400">
      {' '}(
      {servers.map((s, i) => (
        <span key={s}>{i > 0 && ', '}<NodeName name={s} /></span>
      ))}
      )
    </span>
  );
}

const KIND_STYLE = {
  add: { Icon: Plus, cls: 'text-green-700 dark:text-green-400' },
  remove: { Icon: Minus, cls: 'text-red-700 dark:text-red-400' },
  held: { Icon: Pause, cls: 'text-amber-700 dark:text-amber-400' },
  foreign: { Icon: Ban, cls: 'text-gray-500 dark:text-gray-400' },
} as const;

/** One address change: `+ A 203.0.113.2 (sv2)`, `− A 203.0.113.9 (sv-old) · server removed`. */
export function DriftRecordLine({ kind, type, content, servers = [], reason, heldReason, testId }: {
  readonly kind: keyof typeof KIND_STYLE;
  readonly type: string;
  readonly content: string;
  readonly servers?: readonly string[];
  readonly reason?: StaleRecord['reason'];
  readonly heldReason?: HeldRecord['reason'];
  readonly testId?: string;
}) {
  const { Icon, cls } = KIND_STYLE[kind];
  return (
    <li className="flex items-start gap-1.5 font-mono text-xs" data-testid={testId}>
      <Icon size={12} className={`mt-0.5 shrink-0 ${cls}`} aria-hidden />
      <span className={cls}>
        {type} {content}
      </span>
      <span className="font-sans">
        <ServerNames servers={servers} />
        {reason && <span className="text-gray-500 dark:text-gray-400"> · {STALE_REASON_LABEL[reason]}</span>}
        {heldReason && <span className="text-gray-500 dark:text-gray-400"> · {HELD_REASON_LABEL[heldReason]}</span>}
        {kind === 'foreign' && <span className="text-gray-500 dark:text-gray-400"> · not a platform address — left alone</span>}
      </span>
    </li>
  );
}
