/**
 * cert-manager ACME DNS-01 webhook wire types.
 *
 * cert-manager talks to a DNS-01 solver webhook through the Kubernetes
 * API aggregation layer: it POSTs a `ChallengePayload` to
 * `/apis/<group>/<version>/<solverName>` and expects the same kind back
 * with a `response` block. The shape below is cert-manager's
 * `acme/webhook.ChallengeRequest` / `ChallengeResponse`.
 *
 * We validate the request rather than trusting it: this endpoint is
 * reachable only through the aggregator (mTLS + user allowlist), but a
 * malformed payload must produce a clean Failure response, never an
 * unhandled throw that the aggregator surfaces as a 500 with a stack.
 */

import { z } from 'zod';

export const ACME_WEBHOOK_GROUP = 'acme.insula.host';
export const ACME_WEBHOOK_VERSION = 'v1alpha1';
/** Resource name cert-manager "creates"; also the ClusterIssuer solverName. */
export const ACME_WEBHOOK_SOLVER_NAME = 'insula-dns';

export const challengeRequestSchema = z.object({
  uid: z.string().min(1),
  action: z.enum(['Present', 'CleanUp']),
  type: z.string().optional(),
  /** The identifier being validated, e.g. `example.test` or `*.example.test`. */
  dnsName: z.string().min(1),
  /** The TXT value to publish. */
  key: z.string().min(1),
  /** Namespace of the Issuer/Certificate that triggered the challenge. */
  resourceNamespace: z.string().optional(),
  /** Fully-qualified `_acme-challenge.<name>.` — always trailing-dotted. */
  resolvedFQDN: z.string().min(1),
  /** Zone apex cert-manager resolved by SOA lookup, trailing-dotted. */
  resolvedZone: z.string().optional(),
  allowAmbientCredentials: z.boolean().optional(),
  config: z.unknown().optional(),
});

export const challengePayloadSchema = z.object({
  apiVersion: z.string().optional(),
  kind: z.string().optional(),
  request: challengeRequestSchema,
});

export type ChallengeRequest = z.infer<typeof challengeRequestSchema>;
export type ChallengePayload = z.infer<typeof challengePayloadSchema>;

export interface ChallengeResponseBody {
  readonly apiVersion: string;
  readonly kind: 'ChallengePayload';
  readonly response: {
    readonly uid: string;
    readonly success: boolean;
    readonly status?: {
      readonly status: 'Success' | 'Failure';
      readonly message?: string;
      readonly reason?: string;
      readonly code?: number;
    };
  };
}

export function challengeSuccess(uid: string): ChallengeResponseBody {
  return {
    apiVersion: `${ACME_WEBHOOK_GROUP}/${ACME_WEBHOOK_VERSION}`,
    kind: 'ChallengePayload',
    response: { uid, success: true, status: { status: 'Success' } },
  };
}

export function challengeFailure(
  uid: string,
  message: string,
  reason = 'SolverError',
): ChallengeResponseBody {
  return {
    apiVersion: `${ACME_WEBHOOK_GROUP}/${ACME_WEBHOOK_VERSION}`,
    kind: 'ChallengePayload',
    response: {
      uid,
      success: false,
      status: { status: 'Failure', message, reason, code: 500 },
    },
  };
}
