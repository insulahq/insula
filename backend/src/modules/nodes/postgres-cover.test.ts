import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { loadCnpgFacts, postgresInstanceOnNode, type CnpgFacts, type CnpgPodFact } from './postgres-cover.js';

const pod = (p: Partial<CnpgPodFact> & { name: string }): CnpgPodFact => ({
  namespace: 'platform', cluster: 'system-db', nodeName: 's1', ready: true, primary: false,
  claimNames: [p.name], ...p,
});

const replicasOn = (map: Record<string, string[]>) => (_ns: string, pvc: string): ReadonlySet<string> =>
  new Set(map[pvc] ?? []);

describe('postgresInstanceOnNode', () => {
  const facts: CnpgFacts = {
    pvcs: [
      { namespace: 'platform', name: 'system-db-1', cluster: 'system-db', instance: 'system-db-1' },
      { namespace: 'platform', name: 'system-db-1-wal', cluster: 'system-db', instance: 'system-db-1' },
      { namespace: 'platform', name: 'system-db-2', cluster: 'system-db', instance: 'system-db-2' },
    ],
    pods: [
      pod({ name: 'system-db-1', nodeName: 's1', primary: true, claimNames: ['system-db-1', 'system-db-1-wal'] }),
      pod({ name: 'system-db-2', nodeName: 's2' }),
    ],
    cordonedNodes: new Set(),
    streamingStandbys: new Map([['platform/system-db', new Set(['system-db-2'])]]),
  };

  it('a volume that is not a CNPG instance volume is not an instance', () => {
    expect(postgresInstanceOnNode({ namespace: 'mail', pvcName: 'data-stalwart-mail-0' }, 's2', facts, replicasOn({}))).toBeNull();
  });

  it('the primary covers a replica only when every volume it mounts lives off the draining node — the WAL volume too', () => {
    const target = { namespace: 'platform', pvcName: 'system-db-2' };
    expect(postgresInstanceOnNode(target, 's2', facts, replicasOn({ 'system-db-1': ['s1'], 'system-db-1-wal': ['s1'] })))
      .toEqual({ kind: 'postgres', cluster: 'system-db', instance: 'system-db-2', primary: false, coveredBy: ['system-db-1'] });
    expect(postgresInstanceOnNode(target, 's2', facts, replicasOn({ 'system-db-1': ['s1'], 'system-db-1-wal': ['s2'] }))?.coveredBy)
      .toEqual([]);
    expect(postgresInstanceOnNode(target, 's2', facts, replicasOn({ 'system-db-1': ['s1'] }))?.coveredBy).toEqual([]);
  });

  it('the WAL volume of the primary on the draining node belongs to the primary — covered by its streaming standby', () => {
    expect(postgresInstanceOnNode({ namespace: 'platform', pvcName: 'system-db-1-wal' }, 's1', facts, replicasOn({ 'system-db-2': ['s2'] })))
      .toEqual({ kind: 'postgres', cluster: 'system-db', instance: 'system-db-1', primary: true, coveredBy: ['system-db-2'] });
  });

  it('a primary of a cluster whose replication is unknown is not covered', () => {
    const unknown: CnpgFacts = { ...facts, streamingStandbys: new Map() };
    expect(postgresInstanceOnNode({ namespace: 'platform', pvcName: 'system-db-1' }, 's1', unknown, replicasOn({ 'system-db-2': ['s2'] }))?.coveredBy)
      .toEqual([]);
  });

  it('an instance of another cluster does not cover', () => {
    const other: CnpgFacts = { ...facts, pods: [pod({ name: 'tenant-db-1', cluster: 'tenant-db', nodeName: 's1', primary: true })] };
    expect(postgresInstanceOnNode({ namespace: 'platform', pvcName: 'system-db-2' }, 's2', other, replicasOn({ 'tenant-db-1': ['s1'] }))?.coveredBy)
      .toEqual([]);
  });

  it('a volume replica on a cordoned node does not count as off the node', () => {
    const cordonedS3: CnpgFacts = { ...facts, cordonedNodes: new Set(['s3']) };
    expect(postgresInstanceOnNode({ namespace: 'platform', pvcName: 'system-db-2' }, 's2', cordonedS3,
      replicasOn({ 'system-db-1': ['s3'], 'system-db-1-wal': ['s3'] }))?.coveredBy).toEqual([]);
  });
});

describe('loadCnpgFacts', () => {
  function k8sWith(pods: unknown[], nodes: unknown[] = []): K8sClients {
    return {
      core: {
        listPersistentVolumeClaimForAllNamespaces: vi.fn().mockResolvedValue({
          items: [
            { metadata: { namespace: 'platform', name: 'system-db-3', labels: { 'cnpg.io/cluster': 'system-db' } } },
            { metadata: { namespace: 'platform', name: 'system-db-3-wal', labels: { 'cnpg.io/cluster': 'system-db' } } },
          ],
        }),
        listPodForAllNamespaces: vi.fn().mockResolvedValue({ items: pods }),
        listNode: vi.fn().mockResolvedValue({ items: nodes }),
      },
    } as unknown as K8sClients;
  }
  const instancePod = {
    metadata: { namespace: 'platform', name: 'system-db-3', labels: { 'cnpg.io/cluster': 'system-db', role: 'primary' } },
    spec: { nodeName: 's3', volumes: [{ persistentVolumeClaim: { claimName: 'system-db-3' } }, { emptyDir: {} }] },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  };

  it('reads instance pods only — a CNPG Job pod mounts the same volume but is not an instance', async () => {
    const jobPod = {
      metadata: { namespace: 'platform', name: 'system-db-3-join-abcde', labels: { 'cnpg.io/cluster': 'system-db', 'cnpg.io/jobRole': 'join' } },
      spec: { nodeName: 's3', volumes: [{ persistentVolumeClaim: { claimName: 'system-db-3' } }] },
      status: { conditions: [] },
    };
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Database;
    const facts = await loadCnpgFacts(k8sWith([instancePod, jobPod]), db);
    // Without the instanceName label the instance comes from the PVC name.
    expect(facts.pvcs.map((p) => p.instance)).toEqual(['system-db-3', 'system-db-3']);
    expect(facts.pods).toEqual([{
      namespace: 'platform', name: 'system-db-3', cluster: 'system-db', nodeName: 's3',
      ready: true, primary: true, claimNames: ['system-db-3'],
    }]);
  });

  it('reads the cordoned nodes and the platform primary\'s streaming standbys', async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ application_name: 'system-db-1' }, { application_name: null }] }) } as unknown as Database;
    const facts = await loadCnpgFacts(
      k8sWith([instancePod], [
        { metadata: { name: 's1' }, spec: { unschedulable: true } },
        { metadata: { name: 's2' }, spec: {} },
      ]),
      db,
    );
    expect([...facts.cordonedNodes]).toEqual(['s1']);
    expect([...(facts.streamingStandbys.get('platform/system-db') ?? [])]).toEqual(['system-db-1']);
  });

  it('a failed replication read leaves the cluster unknown instead of failing the lookup', async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error('connection terminated')) } as unknown as Database;
    const facts = await loadCnpgFacts(k8sWith([instancePod]), db);
    expect(facts.streamingStandbys.has('platform/system-db')).toBe(false);
    expect(facts.pods).toHaveLength(1);
  });
});
