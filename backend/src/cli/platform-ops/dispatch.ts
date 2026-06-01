/**
 * platform-ops argument dispatch (ADR-045 / W17).
 *
 * A small hand-rolled dispatcher — no third-party arg parser, to keep the SEA
 * bundle lean and the supply-chain surface minimal. Returns a process exit code.
 */
import type { Deps } from './deps.js';
import {
  versionCommand,
  clusterStatus,
  clusterDiagnostics,
  migrationsList,
  shellCommand,
  selfUpgrade,
} from './commands.js';

const HELP = `platform-ops — Insula operator CLI

Usage: platform-ops <command> [args]

Commands:
  version [--json]        Show installed / running / available platform version
  cluster status         Cluster node + control-plane health (kubectl)
  cluster diagnostics    Best-effort support bundle (nodes, pods, events, flux)
  migrations list        List platform migrations (activates in a later release)
  self-upgrade [--check] Check for / apply a CLI self-upgrade (activates later)
  shell                  Open a shell with cluster admin env (KUBECONFIG set)
  help                   Show this help

Runs on any cluster node. Read-only in this release; privileged operations
(node drain, migrations apply, snapshot/dr, upgrade, rollback) land in later
releases. See ADR-045.`;

function printHelp(deps: Deps): void {
  deps.out(HELP);
}

async function clusterCommand(args: string[], deps: Deps): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'status':
      return clusterStatus(rest, deps);
    case 'diagnostics':
      return clusterDiagnostics(rest, deps);
    default:
      deps.err(`cluster: expected a subcommand (status | diagnostics), got ${sub ? `'${sub}'` : 'none'}`);
      return 2;
  }
}

async function migrationsCommand(args: string[], deps: Deps): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case 'list':
      return migrationsList(rest, deps);
    default:
      deps.err(`migrations: expected 'list', got '${sub}'`);
      return 2;
  }
}

export async function dispatch(argv: string[], deps: Deps): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      printHelp(deps);
      return 0;
    case 'version':
    case '-v':
    case '--version':
      return versionCommand(rest, deps);
    case 'cluster':
      return clusterCommand(rest, deps);
    case 'migrations':
      return migrationsCommand(rest, deps);
    case 'self-upgrade':
      return selfUpgrade(rest, deps);
    case 'shell':
      return shellCommand(rest, deps);
    default:
      deps.err(`unknown command: ${cmd}`);
      printHelp(deps);
      return 2;
  }
}
