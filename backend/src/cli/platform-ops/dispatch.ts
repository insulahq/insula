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
  migrationsApply,
  shellCommand,
  selfUpgrade,
} from './commands.js';
import { drCommand } from './dr.js';
import { snapshotCommand } from './snapshot.js';

const HELP = `platform-ops — Insula operator CLI

Usage: platform-ops <command> [args]

Commands:
  version [--json]        Show installed / running / available platform version
  cluster status         Cluster node + control-plane health (kubectl)
  cluster diagnostics    Best-effort support bundle (nodes, pods, events, flux)
  migrations list [--json] List platform-migrations + their applied status
  migrations apply [--dry-run] Apply pending platform-migrations (DB + cluster)
  snapshot capture       Create an on-demand CNPG base backup (Backup CR)
  snapshot list          List object-store backups via the backup-rclone-shim
  dr verify              Inspect a DR bundle (decrypt + manifest; read-only)
  dr restore             Restore from a DR bundle (partial rows | full recovery)
  dr rescue              Take Longhorn safety snapshots of the system volumes
  self-upgrade [--check] [--force] [--version X.Y.Z]
                         Update this binary: cosign-verified atomic replace
  shell                  Open a shell with cluster admin env (KUBECONFIG set)
  help                   Show this help

Runs on any cluster node. Mostly read-only; the privileged operations in this
release are \`dr restore\` / \`dr rescue\` (disaster recovery) and
\`snapshot capture\` — all work when platform-api is down (they talk to the DB
+ k8s API directly). Other privileged ops (node drain, migrations apply,
upgrade, rollback) land in later releases. See ADR-045.`;

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
    case 'apply':
      return migrationsApply(rest, deps);
    default:
      deps.err(`migrations: expected 'list' or 'apply', got '${sub}'`);
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
    case 'dr':
      return drCommand(rest, deps);
    case 'snapshot':
      return snapshotCommand(rest, deps);
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
