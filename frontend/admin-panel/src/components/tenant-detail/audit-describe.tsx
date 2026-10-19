/**
 * One audit-log row as a line a person reads: what happened, and who did it.
 *
 * The audit log records the request (method, path, resource, the changed
 * fields); this names it. Anything not recognised falls back to the resource
 * and action as recorded, so nothing is dropped — only described less well.
 */
import type { ReactNode } from 'react';
import type { AuditLogEntry } from '@/hooks/use-audit-logs';
import UserLabel from '@/components/ui/UserLabel';

const PATH_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\/impersonate\//, 'Signed in to the tenant panel as this tenant'],
  [/\/cpu-migration\/.*\/apply$/, 'CPU settings applied to the cluster'],
  [/\/storage\/resize$/, 'Storage volume resized'],
  [/\/storage\/fsck/, 'Filesystem check started'],
  [/\/mail\/imapsync\/[^/]+\/resync$/, 'Mail migration re-synced'],
  [/\/mail\/imapsync\/[^/]+$/, 'Mail migration changed'],
  [/\/mail\/imapsync$/, 'Mail migration started'],
  [/\/mailboxes(\/|$)/, 'Mailbox changed'],
  [/\/email\/aliases|\/aliases$/, 'Mailing list changed'],
  [/\/email\/domains/, 'Mail domain changed'],
  [/\/domains(\/|$)/, 'Domain changed'],
  [/\/deployments(\/|$)/, 'Application changed'],
  [/\/snapshots(\/|$)/, 'Snapshot taken or restored'],
  [/\/tenant-bundles|\/bundles(\/|$)/, 'Backup started or restored'],
  [/\/provision/, 'Provisioning run'],
  [/\/migrate/, 'Moved to another node'],
];

const FIELD_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ['status', 'Lifecycle status changed'],
  ['email_send_rate_limit', 'Send limits changed'],
  ['email_send_rate_limit_daily', 'Send limits changed'],
  ['email_outbound_suspended', 'Outbound mail suspended or resumed'],
  ['plan_id', 'Plan changed'],
  ['node_name', 'Pinned node changed'],
  ['storage_tier', 'Storage tier changed'],
  ['storage_limit_override', 'Storage limit changed'],
];

const VERB: Record<string, string> = { create: 'created', update: 'updated', delete: 'deleted' };

export function describeAuditWhat(e: Pick<AuditLogEntry, 'actionType' | 'resourceType' | 'httpMethod' | 'httpPath' | 'changes'>): string {
  const path = (e.httpPath ?? '').split('?')[0] ?? '';
  for (const [re, phrase] of PATH_PHRASES) if (re.test(path)) return phrase;
  const changed = e.changes ? Object.keys(e.changes) : [];
  for (const [field, phrase] of FIELD_PHRASES) if (changed.includes(field)) return phrase;
  if (e.resourceType === 'tenant' && e.actionType === 'update') return 'Tenant settings changed';
  const resource = e.resourceType.replace(/[_-]+/g, ' ');
  return `${resource.charAt(0).toUpperCase()}${resource.slice(1)} ${VERB[e.actionType] ?? e.actionType}`;
}

export function describeAuditEntry(e: AuditLogEntry): { readonly what: string; readonly who: ReactNode } {
  return {
    what: describeAuditWhat(e),
    who: e.actorType === 'user' ? <UserLabel userId={e.actorId} /> : e.actorType === 'system' ? 'System' : 'Webhook',
  };
}
