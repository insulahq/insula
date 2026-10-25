/**
 * `insula etcd members` / `insula etcd remove-learner` — the cluster's etcd
 * membership, read and repaired from any server without etcdctl.
 *
 * remove-learner removes LEARNERS only: a server join that started etcd but never
 * caught up stays in the cluster as a learner — k3s's leader does not evict it,
 * and etcd admits one learner at a time, so it blocks the next server join. A
 * learner has no vote, so removing one cannot touch quorum or data. A voting
 * member is refused: removing one is the runbook's "Remove a node permanently".
 *
 * bootstrap.sh calls `remove-learner --address <ip>… --name <node>` when a server
 * join on this host fails, so re-running the join starts clean (exit codes below).
 */
import type { Deps } from './deps.js';
import type { EtcdMember } from './etcd-client.js';

const DEFAULT_ENDPOINT = 'https://127.0.0.1:2379';
const DEFAULT_TLS_DIR = '/var/lib/rancher/k3s/server/tls/etcd';
const MEMBER_ID_RE = /^[0-9a-f]{1,16}$/;
/** k3s names a server's etcd member `<node-name>-<8 hex>`. */
const MEMBER_NAME_RE = /^(.+)-[0-9a-f]{8}$/;
const NODE_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/** remove-learner exit codes bootstrap.sh relies on. */
export const ETCD_EXIT = { removed: 0, failed: 1, usage: 2, voter: 3, nothingToRemove: 4 } as const;

export interface EtcdOps {
  listMembers: (endpoint: string, tlsDir: string) => Promise<EtcdMember[]>;
  /** Resolves to the members etcd lists after the removal. */
  removeMember: (endpoint: string, tlsDir: string, id: bigint) => Promise<EtcdMember[]>;
}

const HELP = `insula etcd — the cluster's etcd members (run on a server, as root)

  insula etcd members [--json]
      List every member: ID (hex, as etcdctl prints it), name, peer address,
      and whether it votes or is still a learner.

  insula etcd remove-learner <member-id>
  insula etcd remove-learner --address <ip> [--address <ip>]... [--name <node>]
      Remove a LEARNER: a server join that started etcd but never finished.
      --address picks this host's member by its peer address; --name also
      picks a learner k3s named after node <node>.
      A learner has no vote, so this cannot affect quorum. A voting member is
      refused (exit 3) — remove a server with the runbook's "Remove a node
      permanently" instead. Exit 4: no such learner.

  Both take --endpoint <https://ip:2379> (default ${DEFAULT_ENDPOINT}) and
  --tls-dir <dir> (default ${DEFAULT_TLS_DIR}).`;

interface Parsed {
  readonly endpoint: string;
  readonly tlsDir: string;
  readonly json: boolean;
  readonly addresses: readonly string[];
  readonly nodeName: string | null;
  readonly positional: readonly string[];
}

function parseArgs(args: readonly string[]): Parsed | string {
  let endpoint = DEFAULT_ENDPOINT;
  let tlsDir = DEFAULT_TLS_DIR;
  let json = false;
  const addresses: string[] = [];
  let nodeName: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const value = (): string | undefined => args[++i];
    if (a === '--json') json = true;
    else if (a === '--endpoint' || a === '--tls-dir' || a === '--address' || a === '--name') {
      const v = value();
      if (!v) return `${a} needs a value`;
      if (a === '--endpoint') endpoint = v;
      else if (a === '--tls-dir') tlsDir = v;
      else if (a === '--name') {
        if (!NODE_NAME_RE.test(v)) return `--name ${v} is not a node name`;
        nodeName = v;
      } else {
        const host = canonicalHost(v);
        if (!host) return `--address ${v} is not an IP address`;
        addresses.push(host);
      }
    } else if (a.startsWith('-')) return `unknown flag ${a}`;
    else positional.push(a);
  }
  const bad = endpointProblem(endpoint);
  if (bad) return bad;
  return { endpoint, tlsDir, json, addresses, nodeName, positional };
}

function endpointProblem(endpoint: string): string | null {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return `--endpoint ${endpoint} is not a URL (expected https://<ip>:2379)`;
  }
  if (u.protocol !== 'https:' || !u.hostname || !u.port || (u.pathname !== '/' && u.pathname !== '')) {
    return `--endpoint ${endpoint}: expected https://<ip>:<port>`;
  }
  return null;
}

/** An address in the form a URL hostname takes — compressed, lower-case IPv6
 *  — without brackets, so `2001:DB8:0::5` and a peer URL's `[2001:db8::5]`
 *  compare equal. Null for anything that is not an IP literal. */
function canonicalHost(raw: string): string | null {
  const bare = raw.replace(/^\[|\]$/g, '');
  if (!/^[0-9A-Fa-f:.]+$/.test(bare)) return null;
  try {
    return new URL(`https://${bare.includes(':') ? `[${bare}]` : bare}/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function peerHosts(m: EtcdMember): string[] {
  return m.peerUrls.flatMap((u) => {
    try {
      const host = canonicalHost(new URL(u).hostname);
      return host ? [host] : [];
    } catch {
      return [];
    }
  });
}

/** This host's members: any at one of its addresses, plus a LEARNER k3s named
 *  after this node (its peer address may be one this host no longer lists). A
 *  voter under this name at another address is another host's — never ours. */
function ownMembers(members: readonly EtcdMember[], p: Parsed): EtcdMember[] {
  return members.filter(
    (m) =>
      peerHosts(m).some((h) => p.addresses.includes(h)) ||
      (m.isLearner && p.nodeName !== null && MEMBER_NAME_RE.exec(m.name)?.[1] === p.nodeName),
  );
}

const hex = (id: bigint): string => id.toString(16);

function memberText(m: EtcdMember): string {
  return `${hex(m.id)} (${m.name || 'never started'}, ${m.peerUrls[0] ?? 'no peer address'})`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function membersCommand(p: Parsed, deps: Deps): Promise<number> {
  const members = await deps.etcd.listMembers(p.endpoint, p.tlsDir);
  if (p.json) {
    deps.out(
      JSON.stringify(
        members.map((m) => ({
          id: hex(m.id),
          name: m.name,
          peerUrls: m.peerUrls,
          clientUrls: m.clientUrls,
          isLearner: m.isLearner,
        })),
      ),
    );
    return 0;
  }
  const rows = members.map((m) => [hex(m.id), m.name || '(never started)', m.peerUrls.join(','), m.isLearner ? 'learner' : 'voter']);
  const header = ['ID', 'NAME', 'PEER ADDRESS', 'ROLE'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  for (const r of [header, ...rows]) deps.out(r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd());
  return 0;
}

async function removeLearnerCommand(p: Parsed, deps: Deps): Promise<number> {
  const id = p.positional[0];
  const bySelf = p.addresses.length > 0 || p.nodeName !== null;
  if ((id === undefined) === !bySelf || p.positional.length > 1) {
    deps.err('etcd remove-learner: give one member ID, or --address <ip> / --name <node> (not both)');
    return ETCD_EXIT.usage;
  }
  if (id !== undefined && !MEMBER_ID_RE.test(id)) {
    deps.err(`etcd remove-learner: ${id} is not a member ID (hex, as 'insula etcd members' prints it)`);
    return ETCD_EXIT.usage;
  }
  const members = await deps.etcd.listMembers(p.endpoint, p.tlsDir);
  const targets = id !== undefined ? members.filter((m) => m.id === BigInt(`0x${id}`)) : ownMembers(members, p);
  if (targets.length === 0) {
    const where = [...p.addresses, ...(p.nodeName ? [`node ${p.nodeName}`] : [])].join(', ');
    deps.out(id !== undefined ? `no etcd member ${id} — nothing to remove` : `the cluster lists no etcd member for ${where} — nothing to remove`);
    return ETCD_EXIT.nothingToRemove;
  }
  const voters = targets.filter((m) => !m.isLearner);
  if (voters.length > 0) {
    deps.out(`not removed: ${voters.map(memberText).join('; ')} is a voting member — its etcd finished joining`);
    return ETCD_EXIT.voter;
  }
  for (const m of targets) {
    // etcd has no conditional remove: look again right before removing, so a
    // learner promoted since the first list is refused, not removed.
    const now = (await deps.etcd.listMembers(p.endpoint, p.tlsDir)).find((x) => x.id === m.id);
    if (!now) {
      deps.out(`${memberText(m)} is no longer listed — nothing to remove`);
      continue;
    }
    if (!now.isLearner) {
      deps.out(`not removed: ${memberText(now)} became a voting member just now — its etcd finished joining`);
      return ETCD_EXIT.voter;
    }
    const after = await deps.etcd.removeMember(p.endpoint, p.tlsDir, m.id);
    if (after.some((x) => x.id === m.id)) throw new Error(`etcd still lists ${memberText(m)} after removing it`);
    deps.out(`removed etcd learner ${memberText(m)}`);
  }
  return ETCD_EXIT.removed;
}

export async function etcdCommand(args: string[], deps: Deps): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
    deps.out(HELP);
    return sub === undefined ? ETCD_EXIT.usage : 0;
  }
  if (sub !== 'members' && sub !== 'remove-learner') {
    deps.err(`etcd: expected 'members' or 'remove-learner', got '${sub}'`);
    return ETCD_EXIT.usage;
  }
  const p = parseArgs(rest);
  if (typeof p === 'string') {
    deps.err(`etcd ${sub}: ${p}`);
    return ETCD_EXIT.usage;
  }
  try {
    return sub === 'members' ? await membersCommand(p, deps) : await removeLearnerCommand(p, deps);
  } catch (err) {
    deps.err(`etcd ${sub}: ${errText(err)}`);
    return ETCD_EXIT.failed;
  }
}
