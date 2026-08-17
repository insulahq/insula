/**
 * The HTTPS listener that cert-manager reaches through the Kubernetes API
 * aggregation layer.
 *
 * cert-manager does not call a DNS-01 webhook directly — it POSTs a
 * ChallengePayload to `/apis/<group>/<version>/<solver>` on the kube
 * apiserver, which proxies to the Service named by our APIService. That
 * shapes three requirements this server has to satisfy:
 *
 *   1. Serve TLS with a certificate whose CA is in `APIService.caBundle`
 *      (cert-manager's ca-injector fills that in from our Certificate).
 *   2. Answer Kubernetes API *discovery* — the aggregator probes
 *      /apis/<group> and /apis/<group>/<version> and marks the APIService
 *      unavailable if they don't return well-formed documents.
 *   3. Authenticate the caller. The aggregator connects with a client
 *      certificate signed by the cluster's requestheader CA and asserts
 *      the end user in `X-Remote-User`. We verify BOTH: the CA (mTLS) and
 *      that the asserted user is on the allowlist — a proxy-header
 *      allowlist without mTLS would be trivially spoofable by anything
 *      that can reach the pod.
 *
 * Fail-closed: if the requestheader CA cannot be read, the webhook does
 * not start. A DNS-01 solver that writes TXT records into customer zones
 * is not something to expose unauthenticated because a ConfigMap read
 * failed.
 */

import https from 'node:https';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ACME_WEBHOOK_GROUP,
  ACME_WEBHOOK_SOLVER_NAME,
  ACME_WEBHOOK_VERSION,
  challengeFailure,
  challengePayloadSchema,
  challengeSuccess,
} from './types.js';
import { solveChallenge, SolverError } from './solver.js';
import type { SolverDeps, SolverLogger } from './solver.js';

const GROUP_VERSION = `${ACME_WEBHOOK_GROUP}/${ACME_WEBHOOK_VERSION}`;
const SOLVE_PATH = `/apis/${ACME_WEBHOOK_GROUP}/${ACME_WEBHOOK_VERSION}/${ACME_WEBHOOK_SOLVER_NAME}`;
const MAX_BODY_BYTES = 256 * 1024;

/** kube-apiserver identities allowed to drive the solver. */
const DEFAULT_ALLOWED_USERS = ['system:serviceaccount:cert-manager:cert-manager'];

export interface WebhookServerOptions {
  readonly db: SolverDeps['db'];
  readonly encryptionKey: string;
  readonly logger: SolverLogger;
  readonly port: number;
  readonly tlsCertPath: string;
  readonly tlsKeyPath: string;
  /** PEM bundle of the cluster's requestheader client CA. */
  readonly clientCaPem: string;
  readonly allowedUsers?: readonly string[];
}

export interface RunningWebhook {
  readonly port: number;
  close(): Promise<void>;
}

// ─── Kubernetes discovery documents ──────────────────────────────────

export function apiGroupListDocument() {
  return {
    kind: 'APIGroupList',
    apiVersion: 'v1',
    groups: [apiGroupDocument()],
  };
}

export function apiGroupDocument() {
  const versionEntry = { groupVersion: GROUP_VERSION, version: ACME_WEBHOOK_VERSION };
  return {
    kind: 'APIGroup',
    apiVersion: 'v1',
    name: ACME_WEBHOOK_GROUP,
    versions: [versionEntry],
    preferredVersion: versionEntry,
  };
}

export function apiResourceListDocument() {
  return {
    kind: 'APIResourceList',
    apiVersion: 'v1',
    groupVersion: GROUP_VERSION,
    resources: [
      {
        name: ACME_WEBHOOK_SOLVER_NAME,
        singularName: '',
        // cert-manager POSTs a payload rather than persisting an object;
        // the resource is cluster-scoped and create-only.
        namespaced: false,
        kind: 'ChallengePayload',
        verbs: ['create'],
      },
    ],
  };
}

// ─── Request helpers ─────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The user the aggregator asserts for this request.
 *
 * Only meaningful because the connection itself is mTLS-verified against
 * the requestheader CA — the apiserver is the only party that can set
 * these headers on a connection we accept.
 */
export function assertedUser(headers: NodeJS.Dict<string | string[]>): string | null {
  const raw = headers['x-remote-user'];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

export function isAllowedUser(
  user: string | null,
  allowed: readonly string[],
): boolean {
  if (allowed.length === 0) return false;
  return user !== null && allowed.includes(user);
}

// ─── Server ──────────────────────────────────────────────────────────

export async function startAcmeDns01Webhook(
  opts: WebhookServerOptions,
): Promise<RunningWebhook> {
  const allowedUsers = opts.allowedUsers ?? DEFAULT_ALLOWED_USERS;
  const deps: SolverDeps = {
    db: opts.db,
    encryptionKey: opts.encryptionKey,
    logger: opts.logger,
  };

  const server = https.createServer(
    {
      cert: readFileSync(opts.tlsCertPath),
      key: readFileSync(opts.tlsKeyPath),
      ca: opts.clientCaPem,
      requestCert: true,
      // The aggregator always presents a client certificate. Anything
      // that cannot is not the apiserver and has no business here.
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
    (req, res) => {
      void handleRequest(req, res, deps, allowedUsers, opts.logger);
    },
  );

  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  opts.logger.info(
    { port: opts.port, group: ACME_WEBHOOK_GROUP, solver: ACME_WEBHOOK_SOLVER_NAME },
    'acme-dns01: solver webhook listening',
  );

  return {
    port: opts.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SolverDeps,
  allowedUsers: readonly string[],
  logger: SolverLogger,
): Promise<void> {
  const url = (req.url ?? '').split('?')[0];
  const method = req.method ?? 'GET';

  try {
    // Liveness/readiness — unauthenticated by design, no data exposed.
    if (method === 'GET' && (url === '/healthz' || url === '/readyz')) {
      return sendJson(res, 200, { status: 'ok' });
    }

    // Discovery. The aggregator polls these; failing them marks the
    // APIService Unavailable and every DNS-01 order stalls.
    if (method === 'GET' && url === '/apis') {
      return sendJson(res, 200, apiGroupListDocument());
    }
    if (method === 'GET' && url === `/apis/${ACME_WEBHOOK_GROUP}`) {
      return sendJson(res, 200, apiGroupDocument());
    }
    if (method === 'GET' && url === `/apis/${ACME_WEBHOOK_GROUP}/${ACME_WEBHOOK_VERSION}`) {
      return sendJson(res, 200, apiResourceListDocument());
    }

    if (method !== 'POST' || !isSolvePath(url)) {
      return sendJson(res, 404, { kind: 'Status', apiVersion: 'v1', status: 'Failure', code: 404 });
    }

    const user = assertedUser(req.headers);
    if (!isAllowedUser(user, allowedUsers)) {
      logger.warn({ user, url }, 'acme-dns01: rejected solve request from unexpected identity');
      return sendJson(res, 403, {
        kind: 'Status',
        apiVersion: 'v1',
        status: 'Failure',
        code: 403,
        message: 'caller is not permitted to drive the DNS-01 solver',
      });
    }

    const parsed = challengePayloadSchema.safeParse(JSON.parse(await readBody(req)));
    if (!parsed.success) {
      return sendJson(res, 400, {
        kind: 'Status',
        apiVersion: 'v1',
        status: 'Failure',
        code: 400,
        message: `malformed ChallengePayload: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      });
    }

    const request = parsed.data.request;
    try {
      await solveChallenge(deps, request);
      return sendJson(res, 200, challengeSuccess(request.uid));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A SolverError is a legitimate "we cannot solve this" answer
      // (not our zone, not authoritative); anything else is a bug or an
      // upstream outage and deserves the stack in the log.
      if (err instanceof SolverError) {
        logger.warn({ dnsName: request.dnsName, action: request.action, message }, 'acme-dns01: solve refused');
      } else {
        logger.error({ err, dnsName: request.dnsName, action: request.action }, 'acme-dns01: solve failed');
      }
      // 200 with success:false is the contract — a non-2xx makes
      // cert-manager report a transport error instead of our message.
      return sendJson(res, 200, challengeFailure(request.uid, message));
    }
  } catch (err) {
    logger.error({ err, url }, 'acme-dns01: unhandled webhook error');
    if (!res.headersSent) {
      sendJson(res, 500, { kind: 'Status', apiVersion: 'v1', status: 'Failure', code: 500 });
    }
  }
}

/** `/apis/G/V/<solver>`, with or without a namespace segment. */
export function isSolvePath(url: string): boolean {
  if (url === SOLVE_PATH) return true;
  const namespaced = new RegExp(
    `^/apis/${escapeRegExp(ACME_WEBHOOK_GROUP)}/${ACME_WEBHOOK_VERSION}/namespaces/[^/]+/${ACME_WEBHOOK_SOLVER_NAME}$`,
  );
  return namespaced.test(url);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
