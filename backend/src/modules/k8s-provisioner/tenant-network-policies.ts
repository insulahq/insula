/**
 * Tenant-namespace NetworkPolicies — the per-tenant isolation boundary.
 *
 * Four policies are applied to every tenant namespace:
 *
 *   1. default-deny-ingress   — deny cross-namespace ingress except from
 *                               Traefik (so the tenant's web app stays
 *                               reachable through the ingress controller).
 *   2. allow-intra-namespace  — pods within one tenant namespace may reach
 *                               each other (multi-component apps: WordPress
 *                               → its MariaDB sibling, etc).
 *   3. allow-platform-api     — platform-api → the tenant's file-manager
 *                               sidecar (:8111) only.
 *   4. tenant-egress          — default-deny EGRESS + an allowlist: DNS,
 *                               intra-namespace, and the public internet
 *                               MINUS the cluster-internal pod/service CIDRs
 *                               and the cloud metadata endpoint.
 *
 * ── Why the pod-CIDR ipBlock was REMOVED (2026-07-27) ──────────────────────
 * Policies 1 and 3 used to carry an `ipBlock: 10.42.0.0/16` (the whole k3s
 * pod CIDR) alongside their namespaceSelector, added 2026-04-27 to fix LE
 * HTTP-01 504s. But 10.42.0.0/16 matches EVERY pod in the cluster — including
 * every other tenant — so the "default-deny" denied nothing between tenants,
 * and :8111 (an unauthenticated root file API) was reachable cluster-wide.
 * The ipBlock was a workaround for a premise that no longer holds: the
 * original ingress controller (ingress-nginx) ran hostNetwork=true, so its
 * cross-node packets were re-sourced to the pod CIDR and the namespaceSelector
 * could not match. Traefik runs hostPort (NOT hostNetwork), so Calico
 * preserves the Traefik pod's own source IP across the VXLAN overlay and the
 * `traefik` namespaceSelector matches cross-node. Verified live on the 4-node
 * staging cluster 2026-07-27: a pod in the traefik namespace reaches a tenant
 * pod on a DIFFERENT node with namespaceSelector-only (no ipBlock), while a
 * pod in any other namespace is denied. Same conclusion the platform-side
 * `allow-ingress-to-platform` policy already reached for platform-api:3000.
 *
 * The ACME HTTP-01 solver pod cert-manager creates in the tenant namespace
 * receives its challenge THROUGH Traefik, so it is covered by the same
 * `traefik` namespaceSelector — no ipBlock needed for cert issuance either.
 */

import type { K8sClients } from './k8s-client.js';
import type * as k8s from '@kubernetes/client-node';
import type { Database } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import { tenants } from '../../db/schema.js';

/** k3s defaults — overridden by the platform-cluster-cidrs ConfigMap when present. */
const DEFAULT_POD_CIDR_V4 = '10.42.0.0/16';
const DEFAULT_SVC_CIDR_V4 = '10.43.0.0/16';
/** Cloud metadata service (AWS/GCP/Azure/Hetzner/OpenStack IMDS). Never a
 *  legitimate tenant destination; a prime SSRF/credential-theft target. */
const METADATA_IP_V4 = '169.254.169.254/32';

const CLUSTER_CIDRS_CM_NAME = 'platform-cluster-cidrs';
const CLUSTER_CIDRS_CM_NAMESPACE = 'platform';

const FILE_MANAGER_PORT = 8111;

export interface TenantNetworkCidrs {
  /** IPv4 pod CIDR — always present. */
  readonly podV4: string;
  /** IPv4 service CIDR — always present. */
  readonly svcV4: string;
  /** IPv6 pod CIDR — only on dual-stack / v6 clusters. */
  readonly podV6?: string;
  /** IPv6 service CIDR — only on dual-stack / v6 clusters. */
  readonly svcV6?: string;
}

const DEFAULT_CIDRS: TenantNetworkCidrs = {
  podV4: DEFAULT_POD_CIDR_V4,
  svcV4: DEFAULT_SVC_CIDR_V4,
};

function isV6(cidr: string): boolean {
  return cidr.includes(':');
}

/**
 * Split a possibly comma-joined dual-stack CIDR string (bootstrap writes
 * `POD_CIDR` as e.g. "10.42.0.0/16,fd00:42::/56") into a v4 + optional v6.
 */
function splitFamilies(raw: string | undefined): { v4?: string; v6?: string } {
  if (!raw) return {};
  const out: { v4?: string; v6?: string } = {};
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (isV6(part)) out.v6 ??= part;
    else out.v4 ??= part;
  }
  return out;
}

/**
 * Resolve the cluster's pod + service CIDRs for the egress `except` list.
 * Order: the `platform-cluster-cidrs` ConfigMap (written by bootstrap) →
 * env overrides (POD_CIDR / SVC_CIDR) → k3s defaults. Never throws; a read
 * failure falls back to defaults so provisioning is never blocked.
 */
export async function resolveTenantNetworkCidrs(
  core: k8s.CoreV1Api,
  log?: Pick<Console, 'warn'>,
): Promise<TenantNetworkCidrs> {
  let data: Record<string, string> | undefined;
  try {
    const cm = (await core.readNamespacedConfigMap({
      name: CLUSTER_CIDRS_CM_NAME,
      namespace: CLUSTER_CIDRS_CM_NAMESPACE,
    } as Parameters<typeof core.readNamespacedConfigMap>[0])) as unknown as {
      data?: Record<string, string>;
    };
    data = cm.data;
  } catch {
    // Absent on dev / older clusters — fall through to env + defaults.
  }
  const podRaw = data?.POD_CIDR ?? process.env.POD_CIDR;
  const svcRaw = data?.SVC_CIDR ?? process.env.SVC_CIDR;
  const pod = splitFamilies(podRaw);
  const svc = splitFamilies(svcRaw);
  const cidrs: TenantNetworkCidrs = {
    podV4: pod.v4 ?? DEFAULT_POD_CIDR_V4,
    svcV4: svc.v4 ?? DEFAULT_SVC_CIDR_V4,
    podV6: pod.v6,
    svcV6: svc.v6,
  };
  // Guard against a malformed CM smuggling nonsense into the policy.
  if (!/^[0-9./]+$/.test(cidrs.podV4) || !/^[0-9./]+$/.test(cidrs.svcV4)) {
    log?.warn?.(`[tenant-netpol] malformed v4 CIDR (pod=${cidrs.podV4} svc=${cidrs.svcV4}); using defaults`);
    return DEFAULT_CIDRS;
  }
  return cidrs;
}

export interface TenantNetworkPolicy {
  readonly name: string;
  readonly body: Record<string, unknown>;
}

/**
 * Build the four tenant NetworkPolicies for a namespace. Pure — no cluster
 * I/O — so the policy shape is unit-testable.
 */
export function buildTenantNetworkPolicies(
  namespace: string,
  cidrs: TenantNetworkCidrs = DEFAULT_CIDRS,
): TenantNetworkPolicy[] {
  // ── Egress: internet MINUS cluster-internal, per IP family ──
  // NetworkPolicy `except` entries must sit inside the rule's `cidr`.
  // We except the pod + service CIDRs (all in-cluster ClusterIP + pod
  // traffic) and the metadata IP. We deliberately do NOT except the whole
  // RFC-1918 space or node IPs: a tenant app legitimately reaches the mail
  // server on the node's public/host IP (mail.<apex>), and self-hosted
  // clusters may sit on private node IPs — blocking those would break
  // outbound mail. Cross-tenant / cross-service reach is already cut by
  // excepting the pod + service CIDRs.
  const v4Except = [cidrs.podV4, cidrs.svcV4, METADATA_IP_V4];
  const egressRules: Array<Record<string, unknown>> = [
    // DNS — CoreDNS in kube-system. Matched on the post-DNAT pod endpoint,
    // so the namespaceSelector resolves the ClusterIP correctly on Calico.
    {
      to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
      ports: [
        { protocol: 'UDP', port: 53 },
        { protocol: 'TCP', port: 53 },
      ],
    },
    // Intra-namespace — the tenant's own multi-component app + its DB
    // add-on + its file-manager sidecar all live in this namespace.
    { to: [{ podSelector: {} }] },
    // Public internet, minus the cluster-internal ranges + metadata.
    { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: v4Except } }] },
  ];
  // IPv6: only emit a v6 rule on v6-aware clusters. When we know the v6
  // CIDRs we except them; when we don't (v6 present but unconfigured) we
  // allow ::/0 outright rather than silently blackholing v6 egress — the
  // v4 rule already blocks the primary internal path (ClusterIPs are v4).
  if (cidrs.podV6 || cidrs.svcV6) {
    const v6Except = [cidrs.podV6, cidrs.svcV6].filter((c): c is string => !!c);
    egressRules.push({
      to: [{ ipBlock: v6Except.length ? { cidr: '::/0', except: v6Except } : { cidr: '::/0' } }],
    });
  }

  return [
    {
      name: 'default-deny-ingress',
      body: {
        metadata: { name: 'default-deny-ingress', namespace },
        spec: {
          podSelector: {},
          policyTypes: ['Ingress'],
          ingress: [
            {
              _from: [
                {
                  namespaceSelector: {
                    matchLabels: { 'kubernetes.io/metadata.name': 'traefik' },
                  },
                },
              ],
            },
          ],
        },
      },
    },
    {
      name: 'allow-intra-namespace',
      body: {
        metadata: { name: 'allow-intra-namespace', namespace },
        spec: {
          podSelector: {},
          policyTypes: ['Ingress'],
          ingress: [{ _from: [{ podSelector: {} }] }],
        },
      },
    },
    {
      name: 'allow-platform-api',
      body: {
        metadata: { name: 'allow-platform-api', namespace },
        spec: {
          podSelector: {},
          policyTypes: ['Ingress'],
          ingress: [
            {
              _from: [
                {
                  namespaceSelector: {
                    matchLabels: { 'kubernetes.io/metadata.name': 'platform' },
                  },
                  podSelector: {
                    matchLabels: { app: 'platform-api' },
                  },
                },
              ],
              ports: [{ protocol: 'TCP', port: FILE_MANAGER_PORT }],
            },
          ],
        },
      },
    },
    {
      name: 'tenant-egress',
      body: {
        metadata: { name: 'tenant-egress', namespace },
        spec: {
          podSelector: {},
          policyTypes: ['Egress'],
          egress: egressRules,
        },
      },
    },
    {
      // Backup/restore Jobs run IN the tenant namespace and reach two
      // platform-namespace services over their ClusterIPs:
      //   - platform-api:3000        — bundle orchestration + the
      //                                HMAC-token-gated /internal/bundles
      //                                metadata/component endpoints.
      //   - backup-rclone-shim:9000  — the S3-compatible endpoint restic
      //                                actually backs up to / restores from
      //                                (`s3:http://backup-rclone-shim.platform
      //                                .svc:9000/…`); the shim proxies to the
      //                                operator's real S3/SSH target.
      // The blanket `tenant-egress` policy excepts the service CIDR, so without
      // this scoped allow those Jobs cannot reach EITHER service — restic hangs
      // on `dial tcp <shim-ip>:9000: i/o timeout`, every backup/restore fails
      // partial, and the hung Jobs pin RWO volume attachments. Mirrors the
      // ingress side (`allow-backup-files-jobs-to-platform-api` +
      // backup-rclone-shim's own ingress allowlist). Scoped to the
      // backup/restore component label so ordinary tenant workloads get neither
      // egress. NetworkPolicy egress is additive — the Job's allowed egress is
      // the union of this rule + tenant-egress (DNS + internet).
      name: 'allow-backup-jobs-egress',
      body: {
        metadata: { name: 'allow-backup-jobs-egress', namespace },
        spec: {
          podSelector: {
            matchExpressions: [
              { key: 'platform.io/component', operator: 'In', values: ['backup-files', 'restore-files'] },
            ],
          },
          policyTypes: ['Egress'],
          egress: [
            {
              to: [
                {
                  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'platform' } },
                  podSelector: { matchLabels: { app: 'platform-api' } },
                },
              ],
              ports: [{ protocol: 'TCP', port: 3000 }],
            },
            {
              to: [
                {
                  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'platform' } },
                  podSelector: { matchLabels: { app: 'backup-rclone-shim' } },
                },
              ],
              ports: [{ protocol: 'TCP', port: 9000 }],
            },
          ],
        },
      },
    },
  ];
}

/** True for k8s 409 Conflict (already exists) across client-node versions. */
function isConflict(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 409')) return true;
  const e = err as { code?: unknown; statusCode?: unknown };
  return e?.code === 409 || e?.statusCode === 409;
}

/**
 * Apply the tenant NetworkPolicies to a namespace, create-OR-REPLACE so a
 * changed policy body converges on existing tenants (the old create-only,
 * ignore-409 path left stale policies in place forever). Idempotent.
 */
export async function applyTenantNetworkPolicies(
  k8s: K8sClients,
  namespace: string,
  cidrs?: TenantNetworkCidrs,
): Promise<void> {
  const resolved = cidrs ?? (await resolveTenantNetworkCidrs(k8s.core, console));
  const policies = buildTenantNetworkPolicies(namespace, resolved);
  for (const policy of policies) {
    try {
      await k8s.networking.createNamespacedNetworkPolicy({
        namespace,
        body: policy.body as Parameters<typeof k8s.networking.createNamespacedNetworkPolicy>[0]['body'],
      });
    } catch (err: unknown) {
      if (!isConflict(err)) throw err;
      // Already exists — replace so a changed body (e.g. the ipBlock
      // removal or the new tenant-egress rules) converges.
      await k8s.networking.replaceNamespacedNetworkPolicy({
        name: policy.name,
        namespace,
        body: policy.body as Parameters<typeof k8s.networking.replaceNamespacedNetworkPolicy>[0]['body'],
      } as Parameters<typeof k8s.networking.replaceNamespacedNetworkPolicy>[0]);
    }
  }
}

export interface ReconcileNetpolResult {
  readonly attempted: number;
  readonly converged: number;
  readonly failed: ReadonlyArray<{ namespace: string; error: string }>;
}

/**
 * Boot-time convergence: re-apply the tenant NetworkPolicies to EVERY
 * provisioned tenant namespace so a policy-shape change (the ipBlock removal
 * + the new tenant-egress rule) reaches pre-existing tenants without waiting
 * for each to be touched by a provisioning operation. Best-effort per tenant;
 * one failure never aborts the sweep. Mirrors reconcileAllTenantQuotas.
 */
export async function reconcileAllTenantNetworkPolicies(
  db: Database,
  k8s: K8sClients,
  log: Pick<Console, 'info' | 'warn'>,
): Promise<ReconcileNetpolResult> {
  const rows = await db
    .select({ ns: tenants.kubernetesNamespace })
    .from(tenants)
    .where(sql`${tenants.kubernetesNamespace} IS NOT NULL AND ${tenants.kubernetesNamespace} != ''`);

  if (rows.length === 0) {
    return { attempted: 0, converged: 0, failed: [] };
  }

  // Resolve CIDRs once for the whole sweep.
  const cidrs = await resolveTenantNetworkCidrs(k8s.core, console);
  let converged = 0;
  const failed: Array<{ namespace: string; error: string }> = [];
  for (const row of rows) {
    const ns = row.ns;
    if (!ns) continue;
    try {
      await applyTenantNetworkPolicies(k8s, ns, cidrs);
      converged += 1;
    } catch (err) {
      failed.push({ namespace: ns, error: err instanceof Error ? err.message : String(err) });
    }
  }
  log.info(
    `[tenant-netpol] reconcile: ${converged}/${rows.length} converged, ${failed.length} failed`,
  );
  if (failed.length > 0) {
    log.warn(`[tenant-netpol] reconcile failures: ${failed.map((f) => f.namespace).join(', ')}`);
  }
  return { attempted: rows.length, converged, failed };
}
