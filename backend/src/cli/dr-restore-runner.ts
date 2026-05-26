/**
 * DR restore CLI entrypoint (Units B + C).
 *
 * Invoked by `scripts/dr-restore-bundle.sh` (a thin throwaway shim
 * during the transition). Eventually wrapped by `platform-ops dr
 * restore` once PR 10 of the holistic upgrade plan ships, at which
 * point this file's argv parsing collapses to a single-line
 * delegation.
 *
 * Inputs via argv (mirrors the eventual platform-ops surface):
 *
 *   --bundle             <path>    Path to bundle.tar.age (REQUIRED)
 *   --age-key            <path>    Path to operator's age private key (REQUIRED)
 *   --mode               partial|full   Restore mode (REQUIRED)
 *   --strict                       Refuse to import on drift
 *   --age-binary         <path>    Override the `age` binary (defaults to PATH)
 *   --target-mail-node   <name>    Node for mail-stack (REQUIRED for mode=full)
 *   --confirm-cluster    <name>    Typed confirmation per CNPG cluster
 *                                   (REPEATABLE; REQUIRED for mode=full —
 *                                   value MUST equal the cluster name verbatim)
 *   --kubeconfig         <path>    Override kubeconfig (defaults to in-cluster
 *                                   or KUBECONFIG env)
 *
 * Exit codes:
 *   0 = restore succeeded
 *   1 = restore failed (legacy bundle, decrypt error, FK violation,
 *       CNPG recovery error, mail restore error, ...)
 *   2 = setup error (missing argv, can't connect to DB)
 *
 * Output: a single JSON line on stdout with the restore result. Stderr
 * gets human-readable progress + error messages. Operators tail the
 * harness; PR 10's CLI surface formats this for the terminal.
 */

import { loadConfig } from '../config/index.js';
import { getDb, closeDb } from '../db/index.js';
import { createK8sClients } from '../modules/k8s-provisioner/k8s-client.js';
import {
  runDrRestore,
  BundleDecryptError,
  BundleVersionError,
  LegacyBundleError,
  DrImportError,
  CnpgRecoveryError,
  MailRestoreError,
} from '../modules/dr-restore/index.js';

interface Args {
  readonly bundle: string;
  readonly ageKey: string;
  readonly mode: 'partial' | 'full';
  readonly strict: boolean;
  readonly ageBinary?: string;
  readonly targetMailNode?: string;
  readonly confirmClusters: ReadonlyMap<string, string>;
  readonly kubeconfig?: string;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  let bundle: string | undefined;
  let ageKey: string | undefined;
  let mode: string | undefined;
  let strict = false;
  let ageBinary: string | undefined;
  let targetMailNode: string | undefined;
  let kubeconfig: string | undefined;
  const confirmClusters = new Map<string, string>();

  // Helper: read the value of a flag that requires one. Exits 2 with
  // a "requires a value" message rather than silently treating the
  // next flag as the value (or `undefined` if at end of argv).
  const takeValue = (i: number, flag: string): { value: string; nextIndex: number } => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      process.stderr.write(`dr-restore-runner: ${flag} requires a value\n`);
      process.exit(2);
    }
    return { value: v, nextIndex: i + 1 };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--bundle': {
        const t = takeValue(i, '--bundle'); bundle = t.value; i = t.nextIndex; break;
      }
      case '--age-key': {
        const t = takeValue(i, '--age-key'); ageKey = t.value; i = t.nextIndex; break;
      }
      case '--mode': {
        const t = takeValue(i, '--mode'); mode = t.value; i = t.nextIndex; break;
      }
      case '--strict':
        strict = true;
        break;
      case '--age-binary': {
        const t = takeValue(i, '--age-binary'); ageBinary = t.value; i = t.nextIndex; break;
      }
      case '--target-mail-node': {
        const t = takeValue(i, '--target-mail-node'); targetMailNode = t.value; i = t.nextIndex; break;
      }
      case '--confirm-cluster': {
        const t = takeValue(i, '--confirm-cluster');
        // Confirmation value = cluster name verbatim (server-side enforces).
        // Map key + value are the same string — we treat the flag as both
        // the "I want to recover this cluster" assertion AND the typed
        // confirmation. Repeat the flag once per cluster to recover.
        confirmClusters.set(t.value, t.value);
        i = t.nextIndex; break;
      }
      case '--kubeconfig': {
        const t = takeValue(i, '--kubeconfig'); kubeconfig = t.value; i = t.nextIndex; break;
      }
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        process.stderr.write(`dr-restore-runner: unknown arg ${a}\n`);
        process.exit(2);
    }
  }
  if (!bundle) {
    process.stderr.write('dr-restore-runner: --bundle is required\n');
    process.exit(2);
  }
  if (!ageKey) {
    process.stderr.write('dr-restore-runner: --age-key is required\n');
    process.exit(2);
  }
  if (mode !== 'partial' && mode !== 'full') {
    process.stderr.write(`dr-restore-runner: --mode must be 'partial' or 'full'; got ${mode ?? '<missing>'}\n`);
    process.exit(2);
  }
  // Full-mode required-arg pre-check. Better to fail-fast here than
  // halfway through bundle parsing.
  if (mode === 'full') {
    if (!targetMailNode) {
      process.stderr.write("dr-restore-runner: --target-mail-node=<name> is required for mode=full\n");
      process.exit(2);
    }
    if (confirmClusters.size === 0) {
      process.stderr.write("dr-restore-runner: mode=full requires at least one --confirm-cluster=<name> (one per CNPG cluster in the bundle)\n");
      process.exit(2);
    }
  }
  return {
    bundle, ageKey, mode, strict, ageBinary,
    targetMailNode, confirmClusters, kubeconfig,
  };
}

function printHelp(): void {
  process.stdout.write([
    'Usage:',
    '  dr-restore-runner --bundle <path> --age-key <path> --mode partial|full',
    '                    [--strict] [--age-binary <path>] [--kubeconfig <path>]',
    '                    [--target-mail-node <name>]',
    '                    [--confirm-cluster <name> ...]',
    '',
    'Modes:',
    '  partial  Import backup_configurations + backup_target_assignments only;',
    '           every row inserted with readOnly=true. Operator restores',
    '           tenants individually via admin UI. No CNPG / mail state',
    '           change.',
    '',
    '  full     Everything in partial + CNPG recovery (side-by-side',
    '           bootstrap.recovery + promote, per cluster in the bundle)',
    '           + mail data restore (PVC wipe + restic restore via existing',
    '           failover state machine).',
    '',
    '           REQUIRES --target-mail-node + a --confirm-cluster=<name> for',
    '           EVERY CNPG cluster in the bundle (typed confirmation; value',
    '           must equal the cluster name verbatim).',
    '',
    'Prerequisites (operator must complete BEFORE this CLI):',
    '  - Cluster is bootstrapped (./scripts/bootstrap.sh ran)',
    '  - system-db is up + reachable via DATABASE_URL',
    '  - `make secrets-restore` has applied the Secrets bundle',
    '  - For mode=full: also run mode=partial FIRST so the shim',
    '    reconciler can materialize the ObjectStore CRs from the',
    '    imported backup_configurations rows',
    '',
  ].join('\n'));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const config = loadConfig();
  const db = getDb(config.DATABASE_URL);

  process.stderr.write(`dr-restore-runner: bundle=${args.bundle} mode=${args.mode}${args.strict ? ' --strict' : ''}\n`);

  // K8s clients only matter for mode=full. For partial we skip — the
  // CLI may run from an environment that has DATABASE_URL but no
  // kubeconfig (e.g. a one-off jump host).
  const k8sClients = args.mode === 'full' ? createK8sClients(args.kubeconfig) : undefined;

  try {
    // The discriminated union on RunDrRestoreOpts forces us to build
    // two distinct opts shapes — TS won't accept a spread-pattern that
    // mixes the partial + full member shapes. argv-parse already
    // guarantees targetMailNode + confirmClusters for mode=full, so
    // the non-null reads here are correct by construction.
    const result = args.mode === 'full'
      ? await runDrRestore({
          db,
          mode: 'full',
          bundlePath: args.bundle,
          ageKeyPath: args.ageKey,
          ageBinary: args.ageBinary,
          strict: args.strict,
          config: {
            PLATFORM_BASE_DOMAIN: config.PLATFORM_BASE_DOMAIN,
            INGRESS_BASE_DOMAIN: config.INGRESS_BASE_DOMAIN,
            PLATFORM_VERSION: config.PLATFORM_VERSION,
          },
          k8s: k8sClients!,
          confirmClusterNames: args.confirmClusters,
          targetMailNode: args.targetMailNode!,
        })
      : await runDrRestore({
          db,
          mode: 'partial',
          bundlePath: args.bundle,
          ageKeyPath: args.ageKey,
          ageBinary: args.ageBinary,
          strict: args.strict,
          config: {
            PLATFORM_BASE_DOMAIN: config.PLATFORM_BASE_DOMAIN,
            INGRESS_BASE_DOMAIN: config.INGRESS_BASE_DOMAIN,
            PLATFORM_VERSION: config.PLATFORM_VERSION,
          },
        });

    if (result.importResult.drift.hasDrift) {
      process.stderr.write(`dr-restore-runner: WARN drift detected (continuing):\n`);
      for (const note of result.importResult.drift.notes) {
        process.stderr.write(`  - ${note}\n`);
      }
    }
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
    await closeDb();
    process.exit(0);
  } catch (err) {
    // Stderr: full diagnostic — operator-facing, intended for a
    // terminal or journalctl, NOT a public log artefact.
    let label:
      | 'LEGACY_BUNDLE'
      | 'UNKNOWN_VERSION'
      | 'DECRYPT_ERROR'
      | 'IMPORT_ERROR'
      | 'CNPG_RECOVERY_ERROR'
      | 'MAIL_RESTORE_ERROR'
      | 'UNEXPECTED';
    if (err instanceof LegacyBundleError) label = 'LEGACY_BUNDLE';
    else if (err instanceof BundleVersionError) label = 'UNKNOWN_VERSION';
    else if (err instanceof BundleDecryptError) label = 'DECRYPT_ERROR';
    else if (err instanceof DrImportError) label = 'IMPORT_ERROR';
    else if (err instanceof CnpgRecoveryError) label = 'CNPG_RECOVERY_ERROR';
    else if (err instanceof MailRestoreError) label = 'MAIL_RESTORE_ERROR';
    else label = 'UNEXPECTED';
    const fullMessage = (err as Error).message ?? String(err);
    process.stderr.write(`dr-restore-runner: ${label} — ${fullMessage}\n`);
    // MailRestoreError carries an internal `.detail` field separated
    // from the public message (security review LOW#11). The operator-
    // facing terminal benefits from seeing it; the stdout JSON path
    // below intentionally does NOT include it.
    if (err instanceof MailRestoreError && err.detail) {
      process.stderr.write(`dr-restore-runner: detail: ${err.detail}\n`);
    }
    // Stdout JSON (security review M-S2): emit ONLY the label, never
    // the verbatim error body. age's stderr can include the key file
    // path or recipient fingerprint — if a CI pipeline captures
    // stdout to a public artefact, that path leaks. The label is
    // enough for programmatic dispatch; stderr is the diagnostic.
    process.stdout.write(JSON.stringify({ ok: false, errorCode: label }) + '\n');
    await closeDb();
    process.exit(1);
  }
}

void main();
