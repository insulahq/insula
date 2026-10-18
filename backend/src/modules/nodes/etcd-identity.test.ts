import { describe, it, expect, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { assertNoSharedEtcdMember, nodesSharingEtcdMember } from './etcd-identity.js';

const node = (name: string, member?: string, etcdRole = true) => ({
  metadata: {
    name,
    labels: etcdRole ? { 'node-role.kubernetes.io/etcd': 'true' } : {},
    annotations: member ? { 'etcd.k3s.cattle.io/node-name': member } : {},
  },
});

// Production: the server came back as a new object carrying its old member.
const old = node('sv2.example.test', 'sv2.example.test-0a1b2c3d');
const phantom = node('vps-provider-default-01', 'sv2.example.test-0a1b2c3d');
const sv1 = node('sv1', 'sv1-1a2b3c4d');

describe('one server under two node objects — the etcd member they share', () => {
  it('names the other object for either one', () => {
    expect(nodesSharingEtcdMember(old, [sv1, old, phantom])).toEqual(['vps-provider-default-01']);
    expect(nodesSharingEtcdMember(phantom, [sv1, old, phantom])).toEqual(['sv2.example.test']);
  });

  it('nothing to protect: a sole member, a worker, or a node whose etcd role was stripped (the recovery)', () => {
    expect(nodesSharingEtcdMember(sv1, [sv1, old])).toEqual([]);
    expect(nodesSharingEtcdMember(node('w1'), [node('w1'), old])).toEqual([]);
    expect(nodesSharingEtcdMember(node('vps-provider-default-01', 'sv2.example.test-0a1b2c3d', false), [old])).toEqual([]);
  });

  it('refuses before anything changes, naming both and the member — without its id', async () => {
    const k8s = { core: { listNode: vi.fn(async () => ({ items: [sv1, old, phantom] })) } } as unknown as K8sClients;
    await expect(assertNoSharedEtcdMember(k8s, phantom)).rejects.toMatchObject({
      code: 'NODE_DELETE_SHARED_ETCD_MEMBER', status: 409,
      details: { node_name: 'vps-provider-default-01', same_member_as: ['sv2.example.test'] },
      message: expect.stringContaining("etcd member 'sv2.example.test'."),
    });
  });

  it('a node with no member annotation is not even looked up', async () => {
    const listNode = vi.fn();
    await expect(assertNoSharedEtcdMember({ core: { listNode } } as unknown as K8sClients, node('w1'))).resolves.toBeUndefined();
    expect(listNode).not.toHaveBeenCalled();
  });
});
