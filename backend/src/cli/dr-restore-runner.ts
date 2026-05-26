/**
 * DR restore CLI entrypoint (Unit B.3).
 *
 * Invoked by `scripts/dr-restore-bundle.sh` (a thin throwaway shim
 * during the transition). Eventually wrapped by `platform-ops dr
 * restore` once PR 10 of the holistic upgrade plan ships, at which
 * point this file's argv parsing collapses to a single-line
 * delegation.
 *
 * Inputs via argv (mirrors the eventual platform-ops surface):
 *
 *   --bundle    <path>    Path to bundle.tar.age (REQUIRED)
 *   --age-key   <path>    Path to operator's age private key (REQUIRED)
 *   --mode      partial   Currently the only supported mode (REQUIRED)
 *   --strict              Refuse to import on apex/version/topology drift
 *   --age-binary <path>   Override the `age` binary (defaults to PATH)
 *
 * Exit codes:
 *   0 = import succeeded
 *   1 = import failed (legacy bundle, decrypt error, FK violation, ...)
 *   2 = setup error (missing argv, can't connect to DB)
 *
 * Output: a single JSON line on stdout with the import result. Stderr
 * gets human-readable progress + error messages. Operators tail the
 * harness; PR 10's CLI surface formats this for the terminal.
 */

import { loadConfig } from '../config/index.js';
import { getDb, closeDb } from '../db/index.js';
import {
  runDrRestore,
  BundleDecryptError,
  BundleVersionError,
  LegacyBundleError,
  DrImportError,
} from '../modules/dr-restore/index.js';

interface Args {
  readonly bundle: string;
  readonly ageKey: string;
  readonly mode: 'partial';
  readonly strict: boolean;
  readonly ageBinary?: string;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  let bundle: string | undefined;
  let ageKey: string | undefined;
  let mode: string | undefined;
  let strict = false;
  let ageBinary: string | undefined;
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
  if (mode !== 'partial') {
    process.stderr.write(`dr-restore-runner: --mode must be 'partial' (Unit C adds 'full'); got ${mode ?? '<missing>'}\n`);
    process.exit(2);
  }
  return { bundle, ageKey, mode, strict, ageBinary };
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dr-restore-runner --bundle <path> --age-key <path> --mode partial [--strict] [--age-binary <path>]',
    '',
    'Consumes an A2-format secrets-bundle.tar.age + populates a freshly',
    'bootstrapped system-db with backup_configurations + backup_target_',
    'assignments rows. Every row is inserted with readOnly=true (DR-freeze).',
    '',
    'Prerequisites:',
    '  - Cluster is bootstrapped (./scripts/bootstrap.sh ran)',
    '  - system-db is up + reachable via DATABASE_URL',
    '  - `make secrets-restore` has applied the Secrets bundle (Unit B',
    '    only handles the DB row import; Secrets are out of scope)',
    '',
  ].join('\n'));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const config = loadConfig();
  const db = getDb(config.DATABASE_URL);

  process.stderr.write(`dr-restore-runner: bundle=${args.bundle} mode=${args.mode}${args.strict ? ' --strict' : ''}\n`);

  try {
    const result = await runDrRestore({
      db,
      mode: args.mode,
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
    let label: 'LEGACY_BUNDLE' | 'UNKNOWN_VERSION' | 'DECRYPT_ERROR' | 'IMPORT_ERROR' | 'UNEXPECTED';
    if (err instanceof LegacyBundleError) label = 'LEGACY_BUNDLE';
    else if (err instanceof BundleVersionError) label = 'UNKNOWN_VERSION';
    else if (err instanceof BundleDecryptError) label = 'DECRYPT_ERROR';
    else if (err instanceof DrImportError) label = 'IMPORT_ERROR';
    else label = 'UNEXPECTED';
    const fullMessage = (err as Error).message ?? String(err);
    process.stderr.write(`dr-restore-runner: ${label} — ${fullMessage}\n`);
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
