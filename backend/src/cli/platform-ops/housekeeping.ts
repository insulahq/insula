/**
 * `platform-ops` T3 housekeeping subcommands (R18).
 *
 * Each wraps a proven, self-contained operator script embedded as a SEA asset
 * and launched verbatim (deps.runEmbeddedScript) — the same embed-and-launch
 * pattern the DR component restores use. ONE source of truth; the standalone
 * scripts stay usable. Args pass straight through; stdio is inherited so the
 * operator sees progress + answers any confirmation prompts (some are
 * destructive — e.g. backup rotate-key invalidates all remote backups).
 */
import type { Deps } from './deps.js';

const OPS = {
  gcNamespaces: 'ops/cleanup-orphaned-namespaces.sh',
  upgradeCnpg: 'ops/upgrade-cnpg.sh',
  componentWatch: 'ops/component-watch.sh',
  nodeTerminalGc: 'ops/node-terminal-cleanup-stale-artifacts.sh',
  backupRotateKey: 'ops/backup-target-key-rotate.sh',
} as const;

/** `cluster gc-namespaces` — delete orphaned tenant-* namespaces. */
export function clusterGcNamespaces(args: string[], deps: Deps): Promise<number> {
  return deps.runEmbeddedScript(OPS.gcNamespaces, args);
}

/** `cluster upgrade-cnpg` — bump the CloudNativePG operator. */
export function clusterUpgradeCnpg(args: string[], deps: Deps): Promise<number> {
  return deps.runEmbeddedScript(OPS.upgradeCnpg, args);
}

/** `component-watch` — operator helper for the component CVE/version watch. */
export function componentWatchCommand(args: string[], deps: Deps): Promise<number> {
  return deps.runEmbeddedScript(OPS.componentWatch, args);
}

/** `node-terminal gc` — clean up stale node-terminal pods/artifacts. */
export async function nodeTerminalCommand(args: string[], deps: Deps): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'gc') return deps.runEmbeddedScript(OPS.nodeTerminalGc, rest);
  deps.err(`node-terminal: expected 'gc', got ${sub ? `'${sub}'` : 'none'}`);
  return 2;
}

/** `backup rotate-key` — rotate BACKUP_TARGET_KEY (DESTRUCTIVE: invalidates remote backups). */
export async function backupCommand(args: string[], deps: Deps): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'rotate-key') return deps.runEmbeddedScript(OPS.backupRotateKey, rest);
  deps.err(`backup: expected 'rotate-key', got ${sub ? `'${sub}'` : 'none'}`);
  return 2;
}
