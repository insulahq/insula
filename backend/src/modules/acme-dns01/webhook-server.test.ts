/**
 * Discovery documents and access control for the solver webhook.
 *
 * The discovery shapes are not cosmetic: the API aggregator polls them,
 * and a malformed APIResourceList marks the APIService Unavailable, at
 * which point every DNS-01 order stalls with no error on the Certificate.
 */

import { describe, it, expect } from 'vitest';
import {
  apiGroupDocument,
  apiGroupListDocument,
  apiResourceListDocument,
  assertedUser,
  isAllowedUser,
  isSolvePath,
} from './webhook-server.js';
import {
  ACME_WEBHOOK_GROUP,
  ACME_WEBHOOK_SOLVER_NAME,
  ACME_WEBHOOK_VERSION,
  challengeFailure,
  challengePayloadSchema,
  challengeSuccess,
} from './types.js';

describe('discovery documents', () => {
  it('advertises the group and version the APIService registers', () => {
    const group = apiGroupDocument();
    expect(group.name).toBe(ACME_WEBHOOK_GROUP);
    expect(group.preferredVersion.groupVersion).toBe(
      `${ACME_WEBHOOK_GROUP}/${ACME_WEBHOOK_VERSION}`,
    );
    expect(apiGroupListDocument().groups[0].name).toBe(ACME_WEBHOOK_GROUP);
  });

  it('advertises a cluster-scoped create-only solver resource', () => {
    const list = apiResourceListDocument();
    expect(list.kind).toBe('APIResourceList');
    const resource = list.resources[0];
    expect(resource.name).toBe(ACME_WEBHOOK_SOLVER_NAME);
    expect(resource.namespaced).toBe(false);
    expect(resource.verbs).toContain('create');
  });
});

describe('isSolvePath', () => {
  const base = `/apis/${ACME_WEBHOOK_GROUP}/${ACME_WEBHOOK_VERSION}`;

  it('accepts the cluster-scoped and namespaced forms', () => {
    expect(isSolvePath(`${base}/${ACME_WEBHOOK_SOLVER_NAME}`)).toBe(true);
    expect(isSolvePath(`${base}/namespaces/cert-manager/${ACME_WEBHOOK_SOLVER_NAME}`)).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isSolvePath(`${base}/other`)).toBe(false);
    expect(isSolvePath(`${base}/${ACME_WEBHOOK_SOLVER_NAME}/extra`)).toBe(false);
    expect(isSolvePath('/apis/acme.evil.test/v1alpha1/insula-dns')).toBe(false);
    expect(isSolvePath('/')).toBe(false);
  });
});

describe('caller identity', () => {
  it('reads the aggregator-asserted user', () => {
    expect(assertedUser({ 'x-remote-user': 'system:serviceaccount:cert-manager:cert-manager' })).toBe(
      'system:serviceaccount:cert-manager:cert-manager',
    );
    expect(assertedUser({ 'x-remote-user': ['a', 'b'] })).toBe('a');
    expect(assertedUser({})).toBeNull();
  });

  it('allows only listed identities and never an absent one', () => {
    const allowed = ['system:serviceaccount:cert-manager:cert-manager'];
    expect(isAllowedUser('system:serviceaccount:cert-manager:cert-manager', allowed)).toBe(true);
    expect(isAllowedUser('system:serviceaccount:default:default', allowed)).toBe(false);
    expect(isAllowedUser(null, allowed)).toBe(false);
    // An empty allowlist must deny, not admit everything.
    expect(isAllowedUser('system:serviceaccount:cert-manager:cert-manager', [])).toBe(false);
  });
});

describe('ChallengePayload contract', () => {
  it('accepts a cert-manager payload', () => {
    const parsed = challengePayloadSchema.safeParse({
      apiVersion: `${ACME_WEBHOOK_GROUP}/${ACME_WEBHOOK_VERSION}`,
      kind: 'ChallengePayload',
      request: {
        uid: 'abc',
        action: 'Present',
        type: 'dns-01',
        dnsName: '*.example.test',
        key: 'token',
        resourceNamespace: 'cert-manager',
        resolvedFQDN: '_acme-challenge.example.test.',
        resolvedZone: 'example.test.',
        allowAmbientCredentials: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a payload missing the fields the solver needs', () => {
    expect(challengePayloadSchema.safeParse({ request: { uid: 'x' } }).success).toBe(false);
    expect(
      challengePayloadSchema.safeParse({
        request: { uid: 'x', action: 'Explode', dnsName: 'a.test', key: 'k', resolvedFQDN: 'f.' },
      }).success,
    ).toBe(false);
  });

  it('shapes success and failure responses the way cert-manager expects', () => {
    expect(challengeSuccess('u1').response).toEqual({
      uid: 'u1',
      success: true,
      status: { status: 'Success' },
    });
    const failure = challengeFailure('u1', 'no authority');
    expect(failure.response.success).toBe(false);
    expect(failure.response.status?.message).toBe('no authority');
  });
});
