/**
 * `insula bootstrap` — single-binary install / node join (ADR-055).
 *
 * Thin dispatch shell: the whole install is the battle-hardened `bootstrap.sh`
 * (OS detection, k3s, firewall, cert-manager, Flux, the local kustomize
 * seed-apply, secrets bundle, …), embedded in this signed binary as SEA assets
 * and run verbatim — NOT ported to TypeScript (ADR-055 / R18: the bash rides in
 * the binary the way host-migrations do; the logic is unchanged). `deps.runBootstrap`
 * extracts the embedded tree and execs it; this command just handles `--help` and
 * forwards every other flag to `bootstrap.sh` untouched. Flag validation (the
 * create-vs-join contract, cluster-scoped flags refused on a join) lives in
 * bootstrap.sh alone — duplicating it here would only let the two drift.
 */
import type { Deps } from './deps.js';

const HELP = `insula bootstrap — install Insula on this node (single-binary install)

Usage:
  Create a NEW cluster (the first server only):
    insula bootstrap --domain <FQDN> --acme-email <email> [--allow-source <ip|cidr>] [...]

  JOIN an existing cluster (every other node):
    insula bootstrap --join-as <server|worker> --server <existing-node-ip> --token <node-token> [...]

This runs the full installer — the same one a repo checkout ships as
scripts/bootstrap.sh — from inside the signed binary, so no clone is needed.
All flags are passed straight through; run 'insula bootstrap --help-full' to see
the installer's complete, authoritative flag list.

Create flags (first server; cluster-wide):
  --domain <FQDN>               Platform base domain (required).
  --acme-email <email>          Let's Encrypt email.
  --env <dev|staging|production>  Defaults to production.

Join flags (node-local only — a join never changes cluster-wide state):
  --join-as <server|worker>     Join as a control-plane server or a worker.
                                Requires --server and --token.
  --server <ip>                 An existing node of the cluster.
  --token <token>               From an existing server:
                                cat /var/lib/rancher/k3s/server/node-token
  Cluster-wide flags (--domain, --env, --acme-*, …) are refused on a join.
  Pre-enroll the new node's IP first (admin UI: Pre-Enroll Node).
  A 2nd server gives a 2-member etcd — LESS available than one server.
  Grow servers 1 -> 3, or add workers.

Common flags:
  --allow-source <ip|cidr>      Trust a source IP for kubectl/SSH before the panel exists (repeatable).
  --remote <host> --ssh-key <p>   Run against a remote server from your workstation.
`;

export async function bootstrapCommand(argv: string[], deps: Deps): Promise<number> {
  const first = argv[0];
  if (first === undefined || first === 'help' || first === '-h' || first === '--help') {
    deps.out(HELP);
    return 0;
  }
  // `--help-full` reaches bootstrap.sh's own --help (the authoritative list).
  const passthrough = first === '--help-full' ? ['--help'] : argv;
  return deps.runBootstrap(passthrough);
}
