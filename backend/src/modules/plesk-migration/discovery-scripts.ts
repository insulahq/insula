/**
 * Loader for the Plesk discovery scripts (R1 PR 1).
 *
 * The scripts live as pristine, reviewable files under ./scripts/ — a
 * remote-exec bash payload + a python assembler — read here at module
 * load. Same asset pattern as the .sql migrations: the files ship next
 * to the compiled JS via a Dockerfile COPY (backend/Dockerfile), and
 * resolve from src/ under tsx in dev/test. They are delivered to the
 * discovery Job via a per-job ConfigMap (so no image rebuild).
 *
 * Sentinels are hardcoded identically in assemble.py and here; a unit
 * test asserts they stay in sync.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const INVENTORY_BEGIN = '===INVENTORY-JSON-BEGIN===';
export const INVENTORY_END = '===INVENTORY-JSON-END===';

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), 'scripts');

function load(name: string): string {
  return readFileSync(join(scriptsDir, name), 'utf8');
}

/** Read-only Plesk inventory, runs on the source via `ssh … 'bash -s'`. */
export const REMOTE_DISCOVER_SH = load('remote-discover.sh');
/** Builds the inventory JSON from the tab-tagged stream; runs in the Job. */
export const ASSEMBLE_PY = load('assemble.py');
/** Job entrypoint: writes the key 0600, ssh + pipe to the assembler. */
export const RUNNER_SH = load('runner.sh');
