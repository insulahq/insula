/**
 * k3s agent bootstrap tokens for the admin panel's join command.
 *
 * k3s (docs.k3s.io/cli/token) supports "dynamically generated, automatically
 * expiring agent bootstrap tokens" — the kubeadm bootstrap-token mechanism.
 * `k3s token create` does nothing more than write a kube-system Secret and
 * print `K10<cluster CA hash>::<id>.<secret>`; this module does exactly the
 * same through the kube API, so the platform can hand a WORKER a short-lived
 * credential instead of the cluster's root server token.
 *
 * AGENTS ONLY. The supervisor serves the agent endpoints to the groups
 * `k3s:agent`, `system:nodes` and `system:bootstrappers`, but
 * `/v1-k3s/server-bootstrap` only to `k3s:server` — which only the server
 * token grants (k3s pkg/server/handlers/router.go). A server also needs the
 * server token as the PBKDF2 passphrase that decrypts the bootstrap data.
 * So a SERVER join cannot use a minted token; see bootstrap-command.ts.
 *
 * Expiry is safe for a joined node: after registration the agent
 * authenticates to the supervisor with its kubelet client certificate (node
 * identity) and only falls back to the token if its Node object is deleted.
 *
 * Shape parity with k3s v1.36 (pkg/cli/token + pkg/kubeadm):
 *   Secret  kube-system/bootstrap-token-<id>, type bootstrap.kubernetes.io/token
 *   data    token-id, token-secret, description, expiration (RFC3339, UTC),
 *           usage-bootstrap-authentication / usage-bootstrap-signing = "true"
 *           (k3s's default usages), auth-extra-groups =
 *           system:bootstrappers:k3s:default-node-token (k3s's default group)
 *   token   K10 + sha256(raw /cacerts bytes) + "::" + <id>.<secret>
 */

import { createHash, randomInt } from 'node:crypto';
import type { V1Secret } from '@kubernetes/client-node';
import { CRD_GROUP, CRD_VERSION, type LoadOptions } from './k8s-client.js';

export const BOOTSTRAP_TOKEN_NAMESPACE = 'kube-system';
export const BOOTSTRAP_TOKEN_SECRET_TYPE = 'bootstrap.kubernetes.io/token';
/** k3s's default extra group for `k3s token create` (kubeadm.NodeBootstrapTokenAuthGroup). */
export const K3S_NODE_TOKEN_AUTH_GROUP = 'system:bootstrappers:k3s:default-node-token';
/** How long a minted worker join token lives. The pre-enrolment's own TTL
 *  usually ends it sooner — the Secret is owned by the ClusterPendingPeer. */
export const JOIN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
/** Label linking a minted token to its pre-enrolment (operator forensics). */
export const PENDING_PEER_LABEL = 'insula.host/pending-peer';

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_ID_RE = /^[a-z0-9]{6}$/;
const TOKEN_SECRET_RE = /^[a-z0-9]{16}$/;
const CA_HASH_RE = /^[0-9a-f]{64}$/;
const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----/g;
const CACERTS_MAX_BYTES = 64 * 1024;
const CACERTS_TIMEOUT_MS = 5_000;

export interface BootstrapTokenParts {
  /** `[a-z0-9]{6}` — public; names the Secret. */
  readonly id: string;
  /** `[a-z0-9]{16}` — the credential. */
  readonly secret: string;
}

function randomChars(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  return out;
}

/** A fresh `<id>.<secret>` pair in the bootstrap-token alphabet (unbiased CSPRNG). */
export function generateBootstrapTokenParts(): BootstrapTokenParts {
  return { id: randomChars(6), secret: randomChars(16) };
}

/** Go's `time.RFC3339` for a UTC instant — no fractional seconds. */
export function rfc3339Utc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface BootstrapTokenSecretInput {
  readonly token: BootstrapTokenParts;
  readonly description: string;
  readonly expiresAt: Date;
  /** The ClusterPendingPeer the token was minted for. With a uid it becomes
   *  the Secret's owner, so deleting the pre-enrolment (operator delete, TTL
   *  expiry, or the reconciler's post-claim cleanup) revokes the token. */
  readonly owner: { readonly name: string; readonly uid: string | null };
}

/** The kube-system Secret `k3s token create` would write. Pure. */
export function buildBootstrapTokenSecret(input: BootstrapTokenSecretInput): V1Secret {
  const { token, owner } = input;
  if (!TOKEN_ID_RE.test(token.id) || !TOKEN_SECRET_RE.test(token.secret)) {
    throw new Error('bootstrap token must match [a-z0-9]{6}.[a-z0-9]{16}');
  }
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `bootstrap-token-${token.id}`,
      namespace: BOOTSTRAP_TOKEN_NAMESPACE,
      labels: {
        'app.kubernetes.io/managed-by': 'insula',
        [PENDING_PEER_LABEL]: owner.name,
      },
      ...(owner.uid
        ? {
            ownerReferences: [
              {
                apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
                kind: 'ClusterPendingPeer',
                name: owner.name,
                uid: owner.uid,
              },
            ],
          }
        : {}),
    },
    type: BOOTSTRAP_TOKEN_SECRET_TYPE,
    stringData: {
      'token-id': token.id,
      'token-secret': token.secret,
      description: input.description,
      expiration: rfc3339Utc(input.expiresAt),
      'usage-bootstrap-authentication': 'true',
      'usage-bootstrap-signing': 'true',
      'auth-extra-groups': K3S_NODE_TOKEN_AUTH_GROUP,
    },
  };
}

/** Number of PEM certificates in a CA bundle. */
export function countPemCertificates(bundle: Buffer): number {
  return (bundle.toString('utf8').match(PEM_CERT_RE) ?? []).length;
}

/**
 * The cluster-CA hash of a K10 token, as the joining node computes it.
 *
 * For the self-signed cluster CA k3s generates, this is the SHA-256 of the
 * RAW `/cacerts` bytes, trailing newline included (verified on a live
 * cluster against the node-token's own K10 prefix; bootstrap.sh's join
 * preflight hashes the same raw bytes). A multi-certificate bundle (custom
 * CA) is hashed by k3s as the DER of its ROOT instead, which bootstrap.sh's
 * preflight cannot match — so we refuse it rather than mint a token that one
 * of the two checks is guaranteed to reject.
 */
export function clusterCaHash(bundle: Buffer): string {
  const certs = countPemCertificates(bundle);
  if (certs === 0) throw new Error('cluster CA bundle contains no PEM certificate');
  if (certs > 1) {
    throw new Error(
      `cluster CA bundle holds ${certs} certificates (custom CA) — k3s hashes its root, ` +
        'bootstrap.sh hashes the raw bundle; a minted token cannot satisfy both',
    );
  }
  return createHash('sha256').update(bundle).digest('hex');
}

/** `K10<ca-hash>::<id>.<secret>` — the secure token format. Pure. */
export function formatK10Token(caHash: string, token: BootstrapTokenParts): string {
  if (!CA_HASH_RE.test(caHash)) throw new Error('CA hash must be 64 lowercase hex chars');
  if (!TOKEN_ID_RE.test(token.id) || !TOKEN_SECRET_RE.test(token.secret)) {
    throw new Error('bootstrap token must match [a-z0-9]{6}.[a-z0-9]{16}');
  }
  return `K10${caHash}::${token.id}.${token.secret}`;
}

/**
 * Fetch the raw `/cacerts` bundle from the API server endpoint in the
 * platform-api's kubeconfig (in-cluster: the `kubernetes` Service → the k3s
 * supervisor on each server's :6443, which serves `/cacerts` unauthenticated).
 *
 * TLS is VERIFIED against the kubeconfig's CA, so the bytes we hash are the
 * cluster's real CA — the token pins exactly what the platform already
 * trusts. No credentials are sent: the endpoint needs none.
 */
export async function fetchClusterCaBundle(opts: LoadOptions = {}): Promise<Buffer> {
  const k8s = await import('@kubernetes/client-node');
  const { readFileSync } = await import('node:fs');
  const https = await import('node:https');
  const kc = new k8s.KubeConfig();
  if (opts.kubeconfigPath) kc.loadFromFile(opts.kubeconfigPath);
  else kc.loadFromCluster();
  const cluster = kc.getCurrentCluster();
  if (!cluster?.server) throw new Error('kubeconfig has no current cluster server');
  const url = new URL('/cacerts', cluster.server);
  if (url.protocol !== 'https:') throw new Error(`refusing a non-https API server URL (${url.protocol})`);
  const ca = cluster.caData
    ? Buffer.from(cluster.caData, 'base64')
    : cluster.caFile
      ? readFileSync(cluster.caFile)
      : undefined;

  return new Promise<Buffer>((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || 443,
        path: url.pathname,
        method: 'GET',
        ca,
        servername: cluster.tlsServerName,
        rejectUnauthorized: cluster.skipTLSVerify !== true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > CACERTS_MAX_BYTES) {
            req.destroy(new Error(`/cacerts response exceeds ${CACERTS_MAX_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GET /cacerts returned HTTP ${res.statusCode ?? 'unknown'}`));
            return;
          }
          const body = Buffer.concat(chunks);
          if (countPemCertificates(body) === 0) {
            reject(new Error('GET /cacerts returned no PEM certificate'));
            return;
          }
          resolve(body);
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(CACERTS_TIMEOUT_MS, () => {
      req.destroy(new Error(`GET /cacerts timed out after ${CACERTS_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}
