import { describe, it, expect } from 'vitest';
import { mailRoleOnNode, MAIL_STANDBY_LABEL, type MailLiveNode, type MailPlacementFacts } from './mail-role.js';

const node = (name: string, o: { cordoned?: boolean; ready?: boolean; standby?: boolean } = {}): MailLiveNode => ({
  metadata: { name, labels: o.standby ? { [MAIL_STANDBY_LABEL]: 'true' } : {} },
  spec: { unschedulable: o.cordoned ?? false },
  status: { conditions: [{ type: 'Ready', status: o.ready === false ? 'False' : 'True' }] },
});
const facts = (o: Partial<MailPlacementFacts> = {}): MailPlacementFacts => ({
  activeNode: 's1', secondaryNode: 's2', tertiaryNode: null,
  autoFailoverEnabled: true, failoverThresholdSeconds: 300, ...o,
});

describe('mailRoleOnNode — what cordoning a node does to mail', () => {
  it('production: cordoning the only failover target leaves mail nowhere to fail over to', () => {
    const r = mailRoleOnNode('s2', facts(), [node('s1'), node('s2', { standby: true }), node('s3')]);
    expect(r).toEqual({
      role: 'secondary', activeNode: 's1', autoFailoverEnabled: true, failoverThresholdSeconds: 300,
      otherFailoverTargets: [], onlyStandbyCopy: true,
    });
  });

  it('a tertiary that is Ready and uncordoned is what is left', () => {
    const r = mailRoleOnNode('s2', facts({ tertiaryNode: 's3' }), [node('s1'), node('s2', { standby: true }), node('s3', { standby: true })]);
    expect(r?.otherFailoverTargets).toEqual(['s3']);
    expect(r?.onlyStandbyCopy).toBe(false);
  });

  it('the node mail runs on: lists where it would fail over, skipping cordoned and NotReady targets', () => {
    const r = mailRoleOnNode('s1', facts({ tertiaryNode: 's3' }), [node('s1'), node('s2', { cordoned: true }), node('s3', { ready: false })]);
    expect(r?.role).toBe('active');
    expect(r?.otherFailoverTargets).toEqual([]);
    const ok = mailRoleOnNode('s1', facts(), [node('s1'), node('s2'), node('s3')]);
    expect(ok?.otherFailoverTargets).toEqual(['s2']);
  });

  it('a node with no mail role gets no notice', () => {
    expect(mailRoleOnNode('s3', facts(), [node('s1'), node('s2'), node('s3')])).toBeNull();
  });

  it('a target that no longer exists is not counted as one', () => {
    const r = mailRoleOnNode('s1', facts({ secondaryNode: 'gone' }), [node('s1')]);
    expect(r?.otherFailoverTargets).toEqual([]);
  });
});
