/**
 * Bootstrap (join) command generator — the admin panel's "Get bootstrap
 * command" for a pre-enrolled node (ClusterPendingPeer).
 *
 * Returns shell steps to run ON THE NEW NODE as root (join-script.ts):
 *   1. download the signed `insula` CLI of the cluster's own release,
 *   2. verify it against the cluster's release key, install it,
 *   3. `insula bootstrap --join-as <role> --server '<ip>' --token … [--dual-stack]`.
 *
 * Token, by role:
 *   worker — a short-lived k3s agent bootstrap token is MINTED here
 *            (join-token.ts), owned by the ClusterPendingPeer, and embedded.
 *   server — k3s bootstrap tokens join agents only; a server needs the
 *            cluster's root server token, which is not readable through the
 *            kube API and which this endpoint deliberately never serves. A
 *            first step reads it on an existing server; the join prompts
 *            for it (hidden input, out of shell history).
 *
 * Cluster facts are read, never guessed:
 *   --server     an IPv4 InternalIP of a Ready control-plane node
 *                (bootstrap.sh's --server is IPv4-only; workers serve no :6443)
 *   dual-stack   the platform-cluster-cidrs ConfigMap (bootstrap writes it),
 *                else any Node spec.podCIDRs entry that is IPv6
 *   private net  a server whose ExternalIP differs from its InternalIP was
 *                pinned with --cluster-network-cidr; the CIDR itself is not
 *                recorded, so the join step carries a marked comment instead
 *
 * A join never carries cluster-scoped flags (--domain, --env, --acme-*):
 * bootstrap.sh refuses them on a join. The only kube-API write is the
 * worker's bootstrap-token Secret.
 */

import { ApiError } from '../../shared/errors.js';
import { type BootstrapCommandResponse } from '@insula/api-contracts';
import { getPendingPeerRecord } from './cluster-pending-peers.js';
import {
  loadClusterNetworkClients,
  type ClusterNetworkClients,
  type LoadOptions,
} from './k8s-client.js';
import {
  BOOTSTRAP_TOKEN_NAMESPACE,
  JOIN_TOKEN_TTL_MS,
  buildBootstrapTokenSecret,
  clusterCaHash,
  fetchClusterCaBundle,
  formatK10Token,
  generateBootstrapTokenParts,
  rfc3339Utc,
  type BootstrapTokenParts,
} from './join-token.js';
import {
  loadPinnedReleaseKey,
  renderJoin,
  resolveJoinRelease,
  type JoinTokenInput,
} from './join-script.js';

const CLUSTER_CIDRS_CM = { name: 'platform-cluster-cidrs', namespace: 'platform' } as const;
/** bootstrap.sh's IPv6 defaults; a cluster created with others needs them on every join. */
const DEFAULT_POD_CIDR_V6 = 'fd42:42::/56';
const DEFAULT_SVC_CIDR_V6 = 'fd42:43::/112';
const V6_CIDR_RE = /^[0-9a-fA-F:]+\/\d{1,3}$/;
const V4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

interface NodeAddress {
  readonly type?: string;
  readonly address?: string;
}

interface NodeShape {
  readonly metadata?: { readonly labels?: Readonly<Record<string, string>> };
  readonly spec?: { readonly podCIDRs?: readonly string[] };
  readonly status?: {
    readonly addresses?: readonly NodeAddress[];
    readonly conditions?: ReadonlyArray<{ type?: string; status?: string }>;
  };
}

interface NodeListShape {
  readonly items?: readonly NodeShape[];
}

interface NodeSummary {
  /** The node a join targets (`--server`). Null when none qualifies. */
  readonly target: { readonly internalIp: string; readonly privateUnderlay: boolean } | null;
  /** Nodes (ready or not) carrying the k3s control-plane label — the
   *  current etcd member count, since every server runs embedded etcd. */
  readonly serverCount: number;
  /** Any Node was allocated an IPv6 pod CIDR (dual-stack evidence). */
  readonly anyV6PodCidr: boolean;
}

function isControlPlane(n: NodeShape): boolean {
  const labels = n.metadata?.labels ?? {};
  return (
    labels['node-role.kubernetes.io/control-plane'] !== undefined ||
    labels['node-role.kubernetes.io/master'] !== undefined
  );
}

function addressOf(n: NodeShape, type: 'InternalIP' | 'ExternalIP'): string | undefined {
  return (n.status?.addresses ?? []).find((a) => a.type === type && a.address && V4_RE.test(a.address))
    ?.address;
}

function isReady(n: NodeShape): boolean {
  return (n.status?.conditions ?? []).find((c) => c.type === 'Ready')?.status === 'True';
}

/** Pick the join target: the first Ready control-plane node with an IPv4
 *  InternalIP. Only when NO node carries a control-plane label (unlabelled
 *  legacy nodes) does any Ready node qualify — never a known worker. */
export function summariseNodes(items: readonly NodeShape[]): NodeSummary {
  const serverCount = items.filter(isControlPlane).length;
  const eligible = items.filter((n) => isReady(n) && addressOf(n, 'InternalIP'));
  const pick = eligible.find(isControlPlane) ?? (serverCount === 0 ? eligible[0] : undefined);
  const internalIp = pick ? addressOf(pick, 'InternalIP') : undefined;
  const externalIp = pick ? addressOf(pick, 'ExternalIP') : undefined;
  return {
    target:
      pick && internalIp
        ? { internalIp, privateUnderlay: externalIp !== undefined && externalIp !== internalIp }
        : null,
    serverCount,
    anyV6PodCidr: items.some((n) => (n.spec?.podCIDRs ?? []).some((c) => c.includes(':'))),
  };
}

/** Operator-facing caution for a SERVER join, or null when there is none.
 *  Every k3s server is an etcd member; an EVEN member count tolerates no
 *  more failures than one fewer, and 2 members is strictly worse than 1. */
export function serverJoinWarning(role: 'server' | 'worker', existingServers: number): string | null {
  if (role !== 'server') return null;
  const after = existingServers + 1;
  if (existingServers > 0 && after % 2 === 1) return null;
  if (existingServers === 0 || after === 2) {
    return (
      'Joining a second server gives a 2-member etcd, which is LESS available than one server: ' +
      'either node down loses quorum (the control plane stops), a permanently lost node needs ' +
      '`k3s server --cluster-reset` on the survivor, and every reboot or k3s upgrade of either ' +
      'node interrupts the control plane. Go straight from 1 to 3 servers (join the third right ' +
      'after this one), or join this node as a worker instead.'
    );
  }
  return (
    `Joining this server gives ${after} etcd members — an even count tolerates no more node ` +
    `failures than ${after - 1}. Join one more server to reach ${after + 1}, or join this node as a worker.`
  );
}

export interface ClusterCidrFacts {
  readonly dualStack: boolean;
  /** Non-default IPv6 CIDRs every join must repeat, as [flag, cidr]. */
  readonly extraFlags: ReadonlyArray<readonly [string, string]>;
}

function v6Part(raw: string | undefined): string | undefined {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .find((s) => s.includes(':'));
}

/** Dual-stack + custom-v6-CIDR facts from the ConfigMap bootstrap writes,
 *  with the Nodes' own podCIDRs as the fallback dual-stack evidence (older
 *  clusters never got the ConfigMap). */
export function clusterCidrFacts(
  cm: Readonly<Record<string, string>> | undefined,
  anyV6PodCidr: boolean,
): ClusterCidrFacts {
  const pod = v6Part(cm?.POD_CIDR);
  const svc = v6Part(cm?.SVC_CIDR);
  const dualStack = pod !== undefined || svc !== undefined || anyV6PodCidr;
  const extraFlags: Array<readonly [string, string]> = [];
  if (pod && V6_CIDR_RE.test(pod) && pod.toLowerCase() !== DEFAULT_POD_CIDR_V6) {
    extraFlags.push(['--pod-cidr-v6', pod]);
  }
  if (svc && V6_CIDR_RE.test(svc) && svc.toLowerCase() !== DEFAULT_SVC_CIDR_V6) {
    extraFlags.push(['--service-cidr-v6', svc]);
  }
  return { dualStack, extraFlags };
}

async function readClusterCidrs(c: ClusterNetworkClients): Promise<Record<string, string> | undefined> {
  try {
    const cm = (await c.core.readNamespacedConfigMap(
      CLUSTER_CIDRS_CM as unknown as Parameters<typeof c.core.readNamespacedConfigMap>[0],
    )) as unknown as { data?: Record<string, string> };
    return cm.data;
  } catch {
    // Absent on clusters bootstrapped before the ConfigMap was written —
    // the Nodes' podCIDRs still answer the dual-stack question.
    return undefined;
  }
}

export type BootstrapCommandOptions = LoadOptions;

/** Seams for tests; production uses the defaults. */
export interface BootstrapCommandDeps {
  readonly clients?: ClusterNetworkClients;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly fetchCaBundle?: () => Promise<Buffer>;
  readonly generateToken?: () => BootstrapTokenParts;
  /** PEM of the cluster's release key; undefined → read the pinned file. */
  readonly releaseKeyPem?: string | null;
  /** Receives a minting failure (never the token). */
  readonly log?: (msg: string, err: unknown) => void;
}

interface MintResult {
  readonly token: JoinTokenInput;
  readonly tokenId: string | null;
  readonly note: string | null;
}

async function mintWorkerToken(
  c: ClusterNetworkClients,
  cpp: { readonly name: string; readonly ip: string; readonly uid: string | null },
  opts: BootstrapCommandOptions,
  deps: BootstrapCommandDeps,
): Promise<MintResult> {
  try {
    // Without the owner uid the token would outlive its pre-enrolment.
    if (!cpp.uid) throw new Error('the pre-enrolment has no uid, so the token could not be tied to it');
    // CA first: a fetch failure must not leave a minted Secret behind.
    const caHash = clusterCaHash(await (deps.fetchCaBundle ?? (() => fetchClusterCaBundle(opts)))());
    const parts = (deps.generateToken ?? generateBootstrapTokenParts)();
    const expiresAt = new Date((deps.now ?? (() => new Date()))().getTime() + JOIN_TOKEN_TTL_MS);
    const body = buildBootstrapTokenSecret({
      token: parts,
      description: `Insula join token: worker ${cpp.ip} (ClusterPendingPeer ${cpp.name})`,
      expiresAt,
      owner: { name: cpp.name, uid: cpp.uid },
    });
    // backup-coverage: excluded:transient-join-token — a 2h k3s bootstrap token,
    // owned by the ClusterPendingPeer and revoked with it; never restored.
    await c.core.createNamespacedSecret({ namespace: BOOTSTRAP_TOKEN_NAMESPACE, body });
    return {
      token: { kind: 'bootstrap', value: formatK10Token(caHash, parts), expiresAt: rfc3339Utc(expiresAt) },
      tokenId: parts.id,
      note: null,
    };
  } catch (err) {
    deps.log?.('cluster-network: worker join token mint failed — falling back to the node-token', err);
    // First line only, capped: k8s client errors append response headers/bodies.
    const reason = String((err as Error)?.message ?? err).split('\n')[0]?.slice(0, 200) ?? 'unknown error';
    return {
      token: { kind: 'node-token' },
      tokenId: null,
      note:
        `Could not mint a short-lived join token for this worker (${reason}), ` +
        "so these steps use the cluster's server token instead: read it on an existing server (step 1) " +
        'and paste it when the join step asks.',
    };
  }
}

export async function generateBootstrapCommand(
  cppName: string,
  opts: BootstrapCommandOptions = {},
  deps: BootstrapCommandDeps = {},
): Promise<BootstrapCommandResponse> {
  const env = deps.env ?? process.env;
  // Fail before any write: an unknown cluster version has no CLI to pin.
  const release = resolveJoinRelease(env);
  const c = deps.clients ?? (await loadClusterNetworkClients(opts));
  const { peer: cpp, uid } = await getPendingPeerRecord(cppName, opts, c);
  const nodes = summariseNodes(((await c.core.listNode()) as NodeListShape).items ?? []);
  if (!nodes.target) {
    throw new ApiError(
      'NO_READY_PEERS',
      'No Ready control-plane Node with an IPv4 InternalIP found — the cluster has no server to join. ' +
        'A first-server install does not need this command; only joins do.',
      503,
    );
  }
  const serverIp = nodes.target.internalIp;
  const cidrs = clusterCidrFacts(await readClusterCidrs(c), nodes.anyV6PodCidr);

  const minted =
    cpp.role === 'worker'
      ? await mintWorkerToken(c, { name: cpp.name, ip: cpp.ip, uid }, opts, deps)
      : { token: { kind: 'node-token' } as const, tokenId: null, note: null };

  const notes: string[] = [];
  if (minted.note) notes.push(minted.note);
  if ((cpp.family ?? (cpp.ip.includes(':') ? 'v6' : 'v4')) === 'v6') {
    notes.push(
      `This node was pre-enrolled by an IPv6 address, but a join reaches --server ${serverIp} over IPv4. ` +
        "Pre-enrol the node's IPv4 address too, or the cluster firewall drops the join.",
    );
  }
  if (nodes.target.privateUnderlay) {
    notes.push(
      `The existing servers are pinned to a private network (--cluster-network-cidr). Add the same ` +
        `--cluster-network-cidr <cidr> to the join line (marked in the join step), and pre-enrol the node by ` +
        'its private IP.',
    );
  }

  const rendered = renderJoin({
    cppName: cpp.name,
    nodeIp: cpp.ip,
    role: cpp.role,
    serverIp,
    release,
    releaseKeyPem: deps.releaseKeyPem !== undefined ? deps.releaseKeyPem : loadPinnedReleaseKey(env),
    token: minted.token,
    dualStack: cidrs.dualStack,
    extraFlags: cidrs.extraFlags,
    privateUnderlay: nodes.target.privateUnderlay,
  });

  return {
    steps: rendered.steps,
    script: rendered.script,
    bootstrapCommand: rendered.bootstrapCommand,
    serverIp,
    role: cpp.role,
    nodeIp: cpp.ip,
    platformVersion: release.tag,
    dualStack: cidrs.dualStack,
    joinToken: {
      kind: minted.token.kind,
      tokenId: minted.tokenId,
      expiresAt: minted.token.kind === 'bootstrap' ? minted.token.expiresAt : null,
    },
    warning: serverJoinWarning(cpp.role, nodes.serverCount),
    notes,
  };
}
