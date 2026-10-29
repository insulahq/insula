/**
 * The cause of a workload's outage is read from ITS evidence. The namespace's
 * evidence is gathered once, and a starting file manager was recorded as
 * `quota_rejected` because another Deployment's ReplicaSet had a quota
 * FailedCreate (seen on staging). Since the quota check runs before the volume
 * one, a real mount failure next to a quota refusal elsewhere would have been
 * read as the quota too.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyUnavailability, currentEvidenceByOwner, deploymentOfPod, deploymentOfReplicaSet, evidenceFor,
  type EvidenceEvent, type EvidencePod,
} from './workload-health.js';

const NOW = Date.parse('2026-10-13T03:00:00Z');
const recent = new Date(NOW - 60_000).toISOString();

const pod = (name: string, rs: string | null, uid: string, extra: Partial<NonNullable<EvidencePod['status']>> = {}): EvidencePod => ({
  metadata: { uid, name, ...(rs ? { ownerReferences: [{ kind: 'ReplicaSet', name: rs }] } : {}) },
  status: { phase: 'Pending', ...extra },
});
const QUOTA_EVENT: EvidenceEvent = {
  type: 'Warning', reason: 'FailedCreate', lastTimestamp: recent,
  message: 'Error creating: pods "cd-big-59494ff7dd-hmrqz" is forbidden: exceeded quota: tenant-x-quota, requested: limits.memory=512Mi',
  involvedObject: { kind: 'ReplicaSet', name: 'cd-big-59494ff7dd' },
};

describe('owners', () => {
  it('a ReplicaSet belongs to the Deployment its name extends; a pod to its ReplicaSet\'s', () => {
    expect(deploymentOfReplicaSet('cd-big-59494ff7dd')).toBe('cd-big');
    expect(deploymentOfReplicaSet('file-manager-64dc6fbb54')).toBe('file-manager');
    expect(deploymentOfReplicaSet(undefined)).toBeNull();
    expect(deploymentOfPod(pod('file-manager-64dc6fbb54-7dwm9', 'file-manager-64dc6fbb54', 'u1'))).toBe('file-manager');
    expect(deploymentOfPod(pod('bare', null, 'u2'))).toBeNull();
  });
});

describe('evidenceFor', () => {
  const starting = pod('file-manager-64dc6fbb54-7dwm9', 'file-manager-64dc6fbb54', 'fm', {
    conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady', message: 'containers with unready status: [file-manager]' }],
    containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating', message: '' } } }],
  });

  it('★ a starting file manager is not put down to another Deployment\'s quota refusal (seen on staging)', () => {
    const ev = currentEvidenceByOwner([starting], [QUOTA_EVENT], NOW);
    expect(classifyUnavailability(null, evidenceFor('file-manager', ev)).reason).toBe('unknown');
    expect(classifyUnavailability(null, evidenceFor('cd-big', ev)).reason).toBe('quota_rejected');
  });

  it('★ a real mount failure next to a quota refusal elsewhere is read as the mount', () => {
    const mounting = pod('website-6b8c9d7f4-ab12c', 'website-6b8c9d7f4', 'web');
    const mountEvent: EvidenceEvent = {
      type: 'Warning', reason: 'FailedMount', message: 'MountVolume.SetUp failed for volume "data"',
      involvedObject: { kind: 'Pod', uid: 'web', name: 'website-6b8c9d7f4-ab12c' },
    };
    const ev = currentEvidenceByOwner([mounting], [QUOTA_EVENT, mountEvent], NOW);
    expect(classifyUnavailability(null, evidenceFor('website', ev)).reason).toBe('volume_attach');
  });

  it('evidence that cannot be attributed still counts for every workload, as before', () => {
    const unowned: EvidenceEvent = { ...QUOTA_EVENT, involvedObject: { kind: 'Namespace' } };
    const ev = currentEvidenceByOwner([], [unowned], NOW);
    expect(classifyUnavailability(null, evidenceFor('anything', ev)).reason).toBe('quota_rejected');
  });
});
