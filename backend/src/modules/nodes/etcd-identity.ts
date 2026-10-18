/**
 * One machine, two node objects, one etcd member — refuse to delete either.
 *
 * k3s removes a server's etcd member when its Node object is deleted
 * (pkg/etcd/member_controller.go onRemove), keyed on the node's
 * `etcd.k3s.cattle.io/node-name` annotation. When a server's hostname changes
 * and k3s re-registers it as a NEW node, the new object carries the SAME member
 * annotation as the old NotReady one (seen on production). Deleting either
 * object then removes the machine's live etcd member: one voter gone, and the
 * server's k3s cannot start until it is reset and rejoined. The recovery
 * (Nodes & cluster → When a node comes back under another name) strips the
 * etcd role from the duplicate before deleting it; this guard makes the panel's
 * Delete refuse instead of doing the damage.
 */
import { ApiError } from '../../shared/errors.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export const ETCD_ROLE_LABEL = 'node-role.kubernetes.io/etcd';
export const ETCD_MEMBER_ANNOTATION = 'etcd.k3s.cattle.io/node-name';

export interface NodeLite {
  readonly metadata?: {
    readonly name?: string;
    readonly labels?: Record<string, string>;
    readonly annotations?: Record<string, string>;
  };
}

/** Pure: the OTHER nodes that carry this node's etcd member, when deleting it would remove that member. */
export function nodesSharingEtcdMember(target: NodeLite, all: readonly NodeLite[]): string[] {
  const name = target.metadata?.name;
  const member = target.metadata?.annotations?.[ETCD_MEMBER_ANNOTATION];
  // No etcd role: k3s skips the member removal on delete, so there is nothing to protect.
  if (!name || !member || target.metadata?.labels?.[ETCD_ROLE_LABEL] === undefined) return [];
  return all
    .filter((n) => n.metadata?.name && n.metadata.name !== name
      && n.metadata.annotations?.[ETCD_MEMBER_ANNOTATION] === member)
    .map((n) => n.metadata?.name as string);
}

/** Refuse — before anything changes — to delete a node whose etcd member another node object also carries. */
export async function assertNoSharedEtcdMember(k8s: K8sClients, target: NodeLite): Promise<void> {
  if (!target.metadata?.annotations?.[ETCD_MEMBER_ANNOTATION]) return;
  const list = await k8s.core.listNode() as { items?: NodeLite[] };
  const others = nodesSharingEtcdMember(target, list.items ?? []);
  if (others.length === 0) return;
  const name = target.metadata?.name ?? '?';
  const member = (target.metadata?.annotations?.[ETCD_MEMBER_ANNOTATION] ?? '').replace(/-[0-9a-f]{8}$/, '');
  throw new ApiError(
    'NODE_DELETE_SHARED_ETCD_MEMBER',
    `'${name}' and '${others.join("', '")}' are the same server registered under two names (its hostname changed), ` +
    `and both carry its etcd member '${member}'. Deleting either one would remove that LIVE etcd member. Nothing was ` +
    `deleted — follow Nodes & cluster → When a node comes back under another name.`,
    409,
    { node_name: name, same_member_as: others },
  );
}
