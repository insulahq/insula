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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--bundle':
        bundle = argv[++i];
        break;
      case '--age-key':
        ageKey = argv[++i];
        break;
      case '--mode':
        mode = argv[++i];
        break;
      case '--strict':
        strict = true;
        break;
      case '--age-binary':
        ageBinary = argv[++i];
        break;
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
    if (err instanceof LegacyBundleError) {
      process.stderr.write(`dr-restore-runner: LEGACY_BUNDLE — ${err.message}\n`);
    } else if (err instanceof BundleVersionError) {
      process.stderr.write(`dr-restore-runner: UNKNOWN_VERSION — ${err.message}\n`);
    } else if (err instanceof BundleDecryptError) {
      process.stderr.write(`dr-restore-runner: DECRYPT_ERROR — ${err.message}\n`);
    } else if (err instanceof DrImportError) {
      process.stderr.write(`dr-restore-runner: IMPORT_ERROR — ${err.message}\n`);
    } else {
      process.stderr.write(`dr-restore-runner: UNEXPECTED — ${(err as Error).message ?? String(err)}\n`);
    }
    process.stdout.write(JSON.stringify({ ok: false, error: (err as Error).message ?? String(err) }) + '\n');
    await closeDb();
    process.exit(1);
  }
}

void main();
