#!/usr/bin/env bash
# ci-platform-ops-embed-check.sh — guard against drift between the platform-ops
# CLI and the bash scripts it embeds + launches (the embed-and-launch pattern,
# ADR-045 R18 T2/T3).
#
# There is ONE source of truth: backend/src/cli/platform-ops/embedded-scripts.ts
# (the EMBEDDED_SCRIPTS map). Three consumers must agree with it, and this guard
# proves they do at PR time — BEFORE any release bakes a binary:
#
#   1. Every manifest entry's file exists in scripts/ and the key is
#      '<dr|ops>/<basename>' for that basename. (A typo'd entry would make the
#      build embed the wrong asset or fail.)
#   2. Dispatch ≡ manifest: every `'dr/*.sh'` / `'ops/*.sh'` literal the CLI
#      launches (deps.runEmbeddedScript) is in the manifest (no launch of an
#      un-embedded script → runtime "asset missing"), AND every manifest key is
#      actually dispatched (no dead embed bloating the binary). The CLI dispatch
#      is already type-checked against the manifest via `EmbeddedScriptKey`, so
#      this is belt-and-suspenders against a cast or a stale embed.
#   3. scripts/build-platform-ops.sh DERIVES its embed list from the manifest
#      (parses embedded-scripts.ts) and carries no re-hardcoded list — so the
#      binary embeds exactly the manifest, no more, no less.
#
# This guard closes REFERENCE drift. It does NOT (and cannot) close VERSION lag:
# a deployed binary embeds the scripts/ content as of its build, so a fix to a
# script reaches the binary only on the next release. `platform-ops version` /
# `cluster doctor` surface that separately.
#
# Exits non-zero on any drift. Pure read-only static analysis (no build, no DB).

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

MANIFEST="$REPO_ROOT/backend/src/cli/platform-ops/embedded-scripts.ts"
BUILD="$REPO_ROOT/scripts/build-platform-ops.sh"
CLI_DIR="$REPO_ROOT/backend/src/cli/platform-ops"

[[ -f "$MANIFEST" ]] || { echo "ci-platform-ops-embed-check: FAIL — manifest not found: $MANIFEST" >&2; exit 1; }
[[ -f "$BUILD" ]] || { echo "ci-platform-ops-embed-check: FAIL — build script not found: $BUILD" >&2; exit 1; }

# (3) build script must derive from the manifest, not a re-hardcoded list.
if ! grep -q "embedded-scripts.ts" "$BUILD"; then
  echo "ci-platform-ops-embed-check: FAIL — build-platform-ops.sh does not reference embedded-scripts.ts; it must DERIVE the embed list from the manifest, not hardcode one" >&2
  exit 1
fi

# (1) + (2): parse the manifest + scan the CLI dispatch surface in Node — the
# literals are TS string literals, so a real parser beats fragile shell globbing.
node - "$MANIFEST" "$CLI_DIR" <<'NODECHECK'
const fs = require('node:fs');
const path = require('node:path');
const [, , manifestPath, cliDir] = process.argv;

const fail = (m) => { console.error(`ci-platform-ops-embed-check: FAIL — ${m}`); process.exit(1); };
const repoRoot = path.resolve(path.dirname(manifestPath), '..', '..', '..', '..');

// --- manifest set M -------------------------------------------------------
const src = fs.readFileSync(manifestPath, 'utf8');
const body = src.slice(src.indexOf('EMBEDDED_SCRIPTS'));
const entries = [...body.matchAll(/^\s*'([^']+)':\s*'([^']+)'/gm)].map((m) => ({ key: m[1], file: m[2] }));
if (entries.length === 0) fail(`parsed 0 entries from embedded-scripts.ts — format changed? the build script + this guard both depend on the \`'key': 'file',\` one-per-line shape`);
const manifestKeys = new Set();
for (const { key, file } of entries) {
  if (key !== `dr/${file}` && key !== `ops/${file}`) fail(`manifest key '${key}' must be 'dr/${file}' or 'ops/${file}' (prefix + scripts/ basename)`);
  if (manifestKeys.has(key)) fail(`duplicate manifest key '${key}'`);
  manifestKeys.add(key);
  const p = path.join(repoRoot, 'scripts', file);
  if (!fs.existsSync(p)) fail(`manifest references scripts/${file} (key '${key}') but that file does not exist`);
}

// --- dispatch set D -------------------------------------------------------
// Every 'dr/*.sh' / 'ops/*.sh' string literal the CLI launches. Walk the CLI
// dir, skip the manifest itself (it defines all keys) and *.test.ts (tests may
// reference keys deliberately — they assert against the manifest, not dispatch).
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(fp));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && e.name !== 'embedded-scripts.ts') out.push(fp);
  }
  return out;
}
const dispatched = new Map(); // key -> first file it was seen in
for (const f of walk(cliDir)) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(/'((?:dr|ops)\/[A-Za-z0-9_.-]+\.sh)'/g)) {
    if (!dispatched.has(m[1])) dispatched.set(m[1], path.relative(repoRoot, f));
  }
}

// (2a) no dispatch of an un-embedded script.
for (const [key, where] of dispatched) {
  if (!manifestKeys.has(key)) fail(`${where} launches '${key}' but it is NOT in EMBEDDED_SCRIPTS — add it to the manifest (or fix the typo)`);
}
// (2b) no dead embed — every manifest key is actually dispatched.
for (const key of manifestKeys) {
  if (!dispatched.has(key)) fail(`manifest embeds '${key}' but nothing in the CLI launches it — remove the dead embed or wire the dispatch`);
}

console.error(`ci-platform-ops-embed-check: OK — ${manifestKeys.size} embedded script(s); manifest ≡ dispatch ≡ scripts/ files`);
NODECHECK

echo "ci-platform-ops-embed-check: PASS"
