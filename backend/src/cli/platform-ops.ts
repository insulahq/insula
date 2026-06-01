#!/usr/bin/env node
/**
 * platform-ops — Insula operator CLI entrypoint (ADR-045 / W17).
 *
 * Compiled into a self-contained Node SEA binary (scripts/build-platform-ops.sh)
 * and installed at /usr/local/bin/platform-ops by bootstrap.sh (cosign-verified;
 * see scripts/lib/bootstrap-phases.sh). Imports backend TS modules directly so
 * the CLI and the in-cluster controllers share one source of truth.
 *
 * This file stays a thin shell: parse → dispatch → exit. All logic lives in
 * ./platform-ops/ so it is unit-testable without spawning a process.
 */
import { dispatch } from './platform-ops/dispatch.js';
import { realDeps } from './platform-ops/deps.js';

dispatch(process.argv.slice(2), realDeps())
  .then((code) => process.exit(code))
  .catch((e) => {
    // Scrub any `scheme://user:pass@host` credentials (e.g. a DATABASE_URL that
    // surfaces in a module-init error) before printing.
    const raw = e instanceof Error ? e.message : String(e);
    const msg = raw.replace(/:\/\/[^@\s/]*@/g, '://***@');
    process.stderr.write(`platform-ops: fatal: ${msg}\n`);
    process.exit(70); // EX_SOFTWARE
  });
