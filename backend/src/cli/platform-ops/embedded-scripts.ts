/**
 * SINGLE SOURCE OF TRUTH for the `scripts/` files embedded into the platform-ops
 * binary as SEA assets and launched verbatim by the CLI (deps.runEmbeddedScript).
 *
 * Three consumers stay in lockstep off this one map, so the CLI, the binary, and
 * the on-disk scripts CANNOT drift apart:
 *   1. CLI dispatch (dr.ts, housekeeping.ts) references these keys — typed via
 *      `EmbeddedScriptKey`, so dispatching an unknown key is a COMPILE error.
 *   2. scripts/build-platform-ops.sh embeds EXACTLY these entries (it parses
 *      this file), and fails the build if a referenced file is missing.
 *   3. scripts/ci-platform-ops-embed-check.sh asserts keys ≡ dispatch ≡ files at
 *      PR time, before any release.
 *
 * The binary embeds whatever is in `scripts/` AT BUILD TIME — there is no second
 * copy in the repo. So the one residual gap is *version lag* (a fix to a script
 * reaches the binary only on the next release); `platform-ops version` /
 * `cluster doctor` surface that. This manifest closes *reference* drift.
 *
 * FORMAT (machine-parsed): keep one `'<asset-key>': '<scripts/ basename>',` per
 * line. The asset-key directory prefix (`dr/`, `ops/`) is the SEA bucket the CLI
 * dispatches against. host-migrations are versioned + embedded dynamically (NOT
 * runEmbeddedScript assets, managed by their own manifest.json) — not listed here.
 */
export const EMBEDDED_SCRIPTS = {
  'dr/restore-etcd-local.sh': 'restore-etcd-local.sh',
  'dr/restore-etcd-from-shim.sh': 'restore-etcd-from-shim.sh',
  'dr/restore-mail-from-shim.sh': 'restore-mail-from-shim.sh',
  'dr/restore-postgres-from-shim.sh': 'restore-postgres-from-shim.sh',
  'ops/cleanup-orphaned-namespaces.sh': 'cleanup-orphaned-namespaces.sh',
  'ops/upgrade-cnpg.sh': 'upgrade-cnpg.sh',
  'ops/component-watch.sh': 'component-watch.sh',
  'ops/node-terminal-cleanup-stale-artifacts.sh': 'node-terminal-cleanup-stale-artifacts.sh',
  'ops/backup-target-key-rotate.sh': 'backup-target-key-rotate.sh',
} as const;

/** Asset key the CLI is allowed to launch — `keyof` the manifest. */
export type EmbeddedScriptKey = keyof typeof EMBEDDED_SCRIPTS;
