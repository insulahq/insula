import { Link } from 'react-router-dom';
import { Mail } from 'lucide-react';
import type { DrainImpact } from '@insula/api-contracts';

type MailRole = NonNullable<DrainImpact['mailRole']>;

interface MailRoleNoticeProps {
  readonly mailRole: MailRole | null | undefined;
  /** The node being cordoned or deleted. */
  readonly nodeName: string;
  /** What is about to happen to the node: a cordon (Edit form) or its deletion (drain / delete dialog). */
  readonly context?: 'cordon' | 'delete';
}

const list = (names: readonly string[]): string => names.join(', ');

/**
 * What cordoning this node does to mail. A drain never moves mail, but a
 * cordoned node cannot take it in a failover — production cordoned
 * mail's only failover target, the mail node then went down, and mail stayed
 * down for the whole outage with nothing on screen having said so.
 */
export default function MailRoleNotice({ mailRole, nodeName, context = 'cordon' }: MailRoleNoticeProps) {
  if (!mailRole) return null;
  const minutes = Math.max(1, Math.round(mailRole.failoverThresholdSeconds / 60));
  const others = mailRole.otherFailoverTargets;
  const stranded = others.length === 0;
  const tone = stranded
    ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200'
    : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-300';

  let title: string;
  let body: string;
  if (context === 'delete') {
    // Draining tenants leaves mail alone; deleting the node does not.
    if (mailRole.role === 'active') {
      title = 'Mail runs on this node';
      body = 'Draining tenants leaves it running. Delete Node is refused until mail is moved to another node.';
    } else {
      title = `Mail failover target (${mailRole.role})`;
      body = stranded
        ? `Draining tenants leaves it a failover target. Once ${nodeName} is deleted, mail has no other node to fail over to — set another failover node first.`
        : `Draining tenants leaves it a failover target. Once ${nodeName} is deleted, mail fails over to ${list(others)} instead.`;
    }
  } else if (mailRole.role === 'active') {
    title = 'Mail runs on this node';
    if (!mailRole.autoFailoverEnabled) {
      body = 'Draining leaves it running here. Automatic failover is off: if this node goes down, mail stays down until it is back or you move it.';
    } else if (stranded) {
      body = 'Draining leaves it running here. If this node goes down, mail has no Ready, uncordoned node to fail over to and stays down until this node is back.';
    } else {
      body = `Draining leaves it running here. If this node goes down, mail fails over to ${list(others)} after ${minutes} min.`;
    }
  } else {
    const where = mailRole.activeNode ?? 'the mail node';
    title = `Mail failover target (${mailRole.role})`;
    if (stranded) {
      body = `While ${nodeName} is cordoned, mail cannot fail over: it is the only Ready failover node`
        + `${mailRole.onlyStandbyCopy ? ' and holds the only standby copy of the mail data' : ''}. `
        + `If ${where} goes down meanwhile, mail stays down until it is back. Set another failover node first.`;
    } else {
      body = `While ${nodeName} is cordoned, mail fails over to ${list(others)} instead`
        + `${mailRole.onlyStandbyCopy ? ' — restored from backup, slower: the standby copy is only on this node' : ''}.`;
    }
  }

  return (
    <div className={`rounded-lg border p-3 text-xs ${tone}`} data-testid="mail-role-notice" data-stranded={stranded ? 'true' : 'false'}>
      <h3 className="mb-1 flex items-center gap-1.5 font-semibold">
        <Mail size={14} aria-hidden="true" />
        {title}
      </h3>
      <p>{body}</p>
      {stranded && (
        <Link
          to="/email/operations/placement"
          className="mt-1 inline-block font-medium text-brand-700 underline hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
          data-testid="mail-role-notice-placement-link"
        >
          Email → Operations → Placement
        </Link>
      )}
    </div>
  );
}
