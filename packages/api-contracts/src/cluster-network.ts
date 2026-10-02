/**
 * Cluster network — admin-side schemas for the always-on set-mode firewall.
 *
 * Three resource families exposed by the admin API:
 *   1. Nodes          — list, toggle exposure (public ↔ private)
 *   2. Trusted ranges — CRUD ClusterTrustedRange CRs
 *   3. Pending peers  — CRUD ClusterPendingPeer CRs + bootstrap command
 *
 * The CRDs are defined in k8s/base/cluster-network/. The peer-firewall-
 * reconciler DaemonSet converges them into nft sets on every node.
 * See docs/operations/CLUSTER_NETWORK.md for the operator workflow.
 */

import { z } from 'zod';

// ─── IP / CIDR validation (mirrors reconciler's net/netip rules) ──────────
//
// CRD admission is the primary gate (regex + CEL); these schemas are the
// SECONDARY gate at the platform-api layer. Reconciler is authoritative.

/** IPv4 CIDR — accepts /1..32; rejects /0 (allow-all). */
const ipv4CidrPattern = /^([0-9]{1,3}\.){3}[0-9]{1,3}\/([1-9]|[12][0-9]|3[0-2])$/;
/** Bare IPv4 — implies /32 downstream. */
const ipv4BarePattern = /^([0-9]{1,3}\.){3}[0-9]{1,3}$/;
/** IPv6 CIDR — accepts /1..128. */
const ipv6CidrPattern = /^[0-9a-fA-F:]+\/([1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/;
/** Bare IPv6 — implies /128 downstream. Must contain at least one `:` */
const ipv6BarePattern = /^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/;

/** Accept any IPv4/v6 single address or CIDR. /0 prefixes are rejected. */
const cidrOrIpString = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (s) =>
      ipv4CidrPattern.test(s) ||
      ipv4BarePattern.test(s) ||
      ipv6CidrPattern.test(s) ||
      ipv6BarePattern.test(s),
    { message: 'must be IPv4/v6 address or CIDR (e.g. 1.2.3.4, 10.0.0.0/16, 2001:db8::1, fd00::/8); /0 prefix not allowed' },
  );

/** Accept ONLY a bare IPv4/v6 (used by ClusterPendingPeer.spec.ip). */
const bareIpString = z
  .string()
  .min(1)
  .max(64)
  .refine((s) => ipv4BarePattern.test(s) || ipv6BarePattern.test(s), {
    message: 'must be a bare IPv4 or IPv6 address (no prefix)',
  });

// Note: cluster Node listing is already exposed via the existing
// `/admin/nodes` API (see packages/api-contracts/src/cluster-nodes.ts
// and backend/src/modules/nodes/). The Phase 6 PRIVATE NODE feature
// will add the exposure-toggle endpoint there alongside the scheduler
// affinity + reconciler firewall-chain changes.

// ─── Trusted ranges (ClusterTrustedRange) ─────────────────────────────────

export const trustedRangeSchema = z.object({
  /** Kubernetes resource name; URL-safe. */
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  /** spec.cidr — see cidrOrIpString. */
  cidr: cidrOrIpString,
  /** spec.description — operator-readable purpose. */
  description: z.string().max(200).default(''),
  /** spec.addedBy — set by platform-api on POST. */
  addedBy: z.string().max(200).default(''),
  /** status.normalizedCidr — reconciler-written; null until first reconcile. */
  normalizedCidr: z.string().nullable(),
  /** status.family — null until first reconcile. */
  family: z.enum(['v4', 'v6']).nullable(),
  /** status.lastSyncedAt — null until first reconcile. */
  lastSyncedAt: z.string().datetime().nullable(),
  /** Last condition observed — surfaced in UI as "Synced" / "Failed: <reason>". */
  ready: z.enum(['True', 'False', 'Unknown']),
  readyReason: z.string().nullable(),
  readyMessage: z.string().nullable(),
  /** ISO creationTimestamp. */
  createdAt: z.string().datetime(),
});
export type TrustedRange = z.infer<typeof trustedRangeSchema>;

export const listTrustedRangesResponseSchema = z.object({
  data: z.array(trustedRangeSchema),
});
export type ListTrustedRangesResponse = z.infer<typeof listTrustedRangesResponseSchema>;

export const createTrustedRangeRequestSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  cidr: cidrOrIpString,
  description: z.string().max(200).default(''),
});
export type CreateTrustedRangeRequest = z.infer<typeof createTrustedRangeRequestSchema>;

export const updateTrustedRangeRequestSchema = z.object({
  description: z.string().max(200),
});
export type UpdateTrustedRangeRequest = z.infer<typeof updateTrustedRangeRequestSchema>;

// ─── Pending peers (ClusterPendingPeer) ───────────────────────────────────

export const pendingPeerSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  ip: bareIpString,
  /** spec.hostname — operator hint, not used by reconciler. */
  hostname: z.string().max(253).default(''),
  /** spec.role — the `--join-as` value of the generated JOIN command
   *  (`insula bootstrap --join-as <role> --server <ip> --token <t>`). Not
   *  used by the reconciler. A server join adds an etcd member: grow 1 → 3. */
  role: z.enum(['server', 'worker']),
  ttlSeconds: z.number().int().min(60).max(86400),
  addedBy: z.string().max(200).default(''),
  /** status.normalizedIp — null until first reconcile. */
  normalizedIp: z.string().nullable(),
  family: z.enum(['v4', 'v6']).nullable(),
  /** status.expiresAt — set by reconciler. */
  expiresAt: z.string().datetime().nullable(),
  /** status.claimedAt — set when matching Node InternalIP appears. */
  claimedAt: z.string().datetime().nullable(),
  ready: z.enum(['True', 'False', 'Unknown']),
  readyReason: z.string().nullable(),
  readyMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type PendingPeer = z.infer<typeof pendingPeerSchema>;

export const listPendingPeersResponseSchema = z.object({
  data: z.array(pendingPeerSchema),
});
export type ListPendingPeersResponse = z.infer<typeof listPendingPeersResponseSchema>;

export const createPendingPeerRequestSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  ip: bareIpString,
  hostname: z.string().max(253).default(''),
  role: z.enum(['server', 'worker']),
  ttlSeconds: z.number().int().min(60).max(86400).default(1800),
});
export type CreatePendingPeerRequest = z.infer<typeof createPendingPeerRequestSchema>;

// ─── Bootstrap command ────────────────────────────────────────────────────

/** Where a join step runs. Every step runs on the NEW node, except reading
 *  the cluster's server token — only an existing server holds it. */
export const bootstrapStepHostSchema = z.enum(['new-node', 'existing-server']);
export type BootstrapStepHost = z.infer<typeof bootstrapStepHostSchema>;

/** One shell step of the join procedure, run as root on `runOn`. */
export const bootstrapStepSchema = z.object({
  /** Stable key: `server-token` | `download` | `verify-install` | `join`. */
  id: z.string(),
  title: z.string(),
  runOn: bootstrapStepHostSchema,
  /** Shell to paste (bash, as root). May span several lines. */
  command: z.string(),
  /** One operator hint shown under the step, or null. */
  note: z.string().nullable(),
});
export type BootstrapStep = z.infer<typeof bootstrapStepSchema>;

/** How the join step authenticates to the cluster.
 *   bootstrap  — a short-lived k3s agent bootstrap token minted for this
 *                pre-enrolment (workers). Already embedded in the join step;
 *                revoked with the pre-enrolment, expires at `expiresAt`.
 *   node-token — the cluster's server token. A SERVER join needs it (k3s
 *                bootstrap tokens join agents only), and the platform never
 *                serves it: the `server-token` step reads it on an existing
 *                server and the join step prompts for it. Also the fallback
 *                for a worker when minting failed (see `notes`). */
export const joinTokenInfoSchema = z.object({
  kind: z.enum(['bootstrap', 'node-token']),
  /** bootstrap only — the public token id (`k3s token list` shows it). */
  tokenId: z.string().nullable(),
  /** bootstrap only — when k3s deletes the token (ISO-8601). */
  expiresAt: z.string().datetime().nullable(),
});
export type JoinTokenInfo = z.infer<typeof joinTokenInfoSchema>;

/** Returned by POST /admin/cluster/bootstrap-command/:name (POST: it may
 *  mint a join token). The steps run ON THE NEW NODE as root: download the
 *  `insula` CLI for the cluster's own release, verify its signature against
 *  the cluster's release key, install it, then run the `insula bootstrap`
 *  JOIN. Node-scoped flags only — never --domain, --env or --acme-*
 *  (cluster-scoped; bootstrap.sh rejects them on a join). */
export const bootstrapCommandResponseSchema = z.object({
  /** Ordered steps. `runOn: existing-server` steps come first. */
  steps: z.array(bootstrapStepSchema).min(1),
  /** Every `new-node` step as ONE paste-safe block: a bash subshell that
   *  stops at the first failure, so an unverified binary is never run. */
  script: z.string(),
  /** The join step's command: the `insula bootstrap --join-as …` line (for
   *  a node-token join, preceded by the hidden `read` of the token). */
  bootstrapCommand: z.string(),
  /** The existing server the join targets (`--server`, an IPv4 InternalIP). */
  serverIp: z.string(),
  /** Role hint from spec.role. */
  role: z.enum(['server', 'worker']),
  /** The new node's IP from spec.ip. */
  nodeIp: z.string(),
  /** The release the CLI download is pinned to — the cluster's version
   *  (a newer CLI would install a different k3s than the cluster runs). */
  platformVersion: z.string(),
  /** True when the cluster runs IPv4+IPv6 — the join carries --dual-stack. */
  dualStack: z.boolean(),
  joinToken: joinTokenInfoSchema,
  /** Operator caution for a SERVER join that leaves an even etcd member
   *  count (above all 1 → 2, which is less available than one server).
   *  Null for workers and for joins that reach an odd count. Optional so an
   *  older platform-api that omits it still satisfies the type. */
  warning: z.string().nullable().optional(),
  /** Further cautions the operator must read before running the steps
   *  (private-network underlay, IPv6-only pre-enrolment, mint fallback). */
  notes: z.array(z.string()),
});
export type BootstrapCommandResponse = z.infer<typeof bootstrapCommandResponseSchema>;

// ─── ClusterFirewallBlacklist (permanent host-firewall IP/CIDR ban) ──────

export const firewallBlacklistEntrySchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  cidr: cidrOrIpString,
  description: z.string().max(200).default(''),
  addedBy: z.string().max(200).default(''),
  /** "manual" or "fail2ban-promote". */
  source: z.enum(['manual', 'fail2ban-promote']).default('manual'),
  normalizedCidr: z.string().nullable(),
  family: z.enum(['v4', 'v6']).nullable(),
  lastSyncedAt: z.string().datetime().nullable(),
  /** Reconciler "Ready" condition — surfaced as "Enforced" / "Refused: <reason>". */
  ready: z.enum(['True', 'False', 'Unknown']),
  readyReason: z.string().nullable(),
  readyMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type FirewallBlacklistEntry = z.infer<typeof firewallBlacklistEntrySchema>;

export const listFirewallBlacklistResponseSchema = z.object({
  data: z.array(firewallBlacklistEntrySchema),
});
export type ListFirewallBlacklistResponse = z.infer<typeof listFirewallBlacklistResponseSchema>;

export const createFirewallBlacklistRequestSchema = z.object({
  cidr: cidrOrIpString,
  description: z.string().max(200).default(''),
  source: z.enum(['manual', 'fail2ban-promote']).default('manual'),
  /** Required type-to-confirm of the literal CIDR — guards against fat-finger
   *  bans (and against banning a range the operator didn't mean to). The
   *  backend rejects when confirmCidr !== cidr. */
  confirmCidr: z.string().min(1).max(64),
});
export type CreateFirewallBlacklistRequest = z.infer<typeof createFirewallBlacklistRequestSchema>;
