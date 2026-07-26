/**
 * `insula bootstrap` — single-binary fresh install (ADR-055).
 *
 * Thin dispatch shell: the whole install is the battle-hardened `bootstrap.sh`
 * (OS detection, k3s, firewall, cert-manager, Flux, the local kustomize
 * seed-apply, secrets bundle, …), embedded in this signed binary as SEA assets
 * and run verbatim — NOT ported to TypeScript (ADR-055 / R18: the bash rides in
 * the binary the way host-migrations do; the logic is unchanged). `deps.runBootstrap`
 * extracts the embedded tree and execs it; this command just handles `--help` and
 * forwards every other flag to `bootstrap.sh` untouched.
 */
import type { Deps } from './deps.js';

const HELP = `insula bootstrap — install Insula on this node (fresh single-binary install)

Usage:
  insula bootstrap --join-as server --domain <FQDN> --acme-email <email> [--allow-source <ip|cidr>] [...]

This runs the full installer — the same one a repo checkout ships as
scripts/bootstrap.sh — from inside the signed binary, so no clone is needed.
All flags are passed straight through; run 'insula bootstrap --help-full' to see
the installer's complete, authoritative flag list.

Common flags:
  --join-as server              This node is the control plane (the first node).
  --domain <FQDN>               Platform base domain (required on the first server).
  --acme-email <email>          Let's Encrypt email (required on the first server).
  --allow-source <ip|cidr>      Trust a source IP for kubectl/SSH before the panel exists (repeatable).
  --env <dev|staging|production>  Defaults to production.
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
