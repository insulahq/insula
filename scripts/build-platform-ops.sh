#!/usr/bin/env bash
# build-platform-ops.sh — produce the self-contained `platform-ops` operator CLI
# as a Node Single Executable Application (SEA) binary (ADR-045 / W17).
#
# Pipeline: esbuild bundles backend/src/cli/platform-ops.ts (+ the backend TS
# modules it imports) into ONE CommonJS file → `node --experimental-sea-config`
# turns it into a SEA blob → postject injects the blob into a copy of the Node
# runtime → a single ~110-120 MB executable that needs no Node on the host.
#
# Same runtime as the backend (Node), so there is zero module-compat risk with
# the Node-native deps the CLI imports (pg, Drizzle). Cross-arch builds inject
# the (arch-independent) blob into a downloaded target-arch Node binary.
#
#   ./scripts/build-platform-ops.sh --version 2026.6.1 [--arch amd64|arm64] \
#       [--node-binary /path/to/node] [--out-dir dist-platform-ops]
#
# Output: <out-dir>/platform-ops-linux-<arch>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=""
ARCH=""
NODE_BINARY=""
OUT_DIR="${REPO_ROOT}/dist-platform-ops"
SENTINEL="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

while [ $# -gt 0 ]; do
  case "$1" in
    --version)     VERSION="$2"; shift 2 ;;
    --arch)        ARCH="$2"; shift 2 ;;
    --node-binary) NODE_BINARY="$2"; shift 2 ;;
    --out-dir)     OUT_DIR="$2"; shift 2 ;;
    *) echo "build-platform-ops: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

# Default version to platform/VERSION; default arch to the host.
[ -n "$VERSION" ] || VERSION="$(tr -d '[:space:]' < "${REPO_ROOT}/platform/VERSION")"
if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    x86_64|amd64)  ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "build-platform-ops: unsupported host arch $(uname -m); pass --arch" >&2; exit 2 ;;
  esac
fi

command -v node >/dev/null 2>&1 || { echo "build-platform-ops: node is required" >&2; exit 2; }

# The backend graph esbuild bundles imports `@insula/api-contracts`, whose
# package "main" is ./dist/index.js. `npm ci` installs but does NOT build
# workspace packages, so on a fresh checkout (CI, release.yml, a clean clone)
# that dist is absent and esbuild fails "Could not resolve @insula/api-contracts".
# Build it here so this script is self-contained — matching every other CI job
# (ci-backend / ci-admin-panel / ci-api-contracts all run the same).
if [ ! -f "${REPO_ROOT}/packages/api-contracts/dist/index.js" ]; then
  echo "build-platform-ops: building @insula/api-contracts (dist missing)..."
  # `--force` is required: a plain `tsc --build` honours the (gitignored)
  # incremental tsconfig.tsbuildinfo and can emit 0 files when dist was
  # removed but the cache lingers. --force always emits. Root-resolved npx so
  # it works under a git worktree too.
  ( cd "${REPO_ROOT}" && npx tsc --build packages/api-contracts --force ) \
    || { echo "build-platform-ops: @insula/api-contracts build failed" >&2; exit 1; }
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$OUT_DIR"
bundle="${work}/platform-ops.cjs"
blob="${work}/platform-ops.blob"
out="${OUT_DIR}/platform-ops-linux-${ARCH}"

echo "build-platform-ops: bundling (version=${VERSION}, arch=${ARCH})..."
# Bundle to a single CJS file. The version is baked in via --define so the
# binary knows its own build version with no runtime env. pg-native is an
# optional native binding pg only requires on its native path (unused here);
# mark it external so the pure-JS path bundles cleanly.
npx --yes esbuild "${REPO_ROOT}/backend/src/cli/platform-ops.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --outfile="${bundle}" \
  --tsconfig="${REPO_ROOT}/backend/tsconfig.json" \
  --define:process.env.PLATFORM_OPS_VERSION="\"${VERSION}\"" \
  --external:pg-native \
  --log-level=warning

# Generate the SEA preparation blob. Host-migration scripts (W10c) are EMBEDDED
# as SEA assets so they travel with every binary (and thus every self-upgrade):
# platform/host-migrations/<version>/<NNNN-name.sh> → asset "host-migrations/<version>/<name>",
# plus a generated "host-migrations/manifest.json" listing the keys (SEA has no
# asset enumeration). The manifest is ALWAYS embedded, even when the dir is empty
# (the runner then sees zero scripts — a clean dormant no-op).
node - "$REPO_ROOT" "$work" "$bundle" "$blob" <<'NODEGEN'
const fs = require('node:fs');
const path = require('node:path');
const [, , repoRoot, work, bundle, blob] = process.argv;
const hmRoot = path.join(repoRoot, 'platform', 'host-migrations');
const VER_RE = /^[0-9]{4}\.[0-9]{1,2}\.[0-9]+$/;
const NAME_RE = /^[0-9]{3,}-[a-z0-9][a-z0-9-]*\.sh$/;
const assets = {};
const scripts = [];
if (fs.existsSync(hmRoot)) {
  for (const version of fs.readdirSync(hmRoot, { withFileTypes: true })) {
    if (!version.isDirectory()) continue;
    if (!VER_RE.test(version.name)) {
      console.error(`build-platform-ops: host-migration version dir '${version.name}' is not CalVer`);
      process.exit(1); // fail the build loudly rather than embed an un-runnable script
    }
    const vdir = path.join(hmRoot, version.name);
    for (const f of fs.readdirSync(vdir)) {
      if (!f.endsWith('.sh')) continue;
      if (!NAME_RE.test(f)) {
        console.error(`build-platform-ops: host-migration '${version.name}/${f}' name must match ${NAME_RE}`);
        process.exit(1);
      }
      const key = `${version.name}/${f}`;
      assets[`host-migrations/${key}`] = path.join(vdir, f);
      scripts.push(key);
    }
  }
}
// Sort for human readability only — the runner always re-sorts via compareVersions.
// numeric: true gives CalVer ordering (2026.6.10 after 2026.6.3).
scripts.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
const manifestPath = path.join(work, 'host-migrations-manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify({ scripts }));
assets['host-migrations/manifest.json'] = manifestPath;
const cfg = { main: bundle, output: blob, disableExperimentalSEAWarning: true, assets };
fs.writeFileSync(path.join(work, 'sea-config.json'), JSON.stringify(cfg));
console.error(`build-platform-ops: embedding ${scripts.length} host-migration script(s)`);
NODEGEN
node --experimental-sea-config "${work}/sea-config.json"

# Resolve the Node runtime to inject into (host node, or a passed target-arch one).
if [ -z "$NODE_BINARY" ]; then
  NODE_BINARY="$(command -v node)"
fi
cp "$NODE_BINARY" "$out"

# Inject the blob (the blob is arch-independent; the host node binary is not,
# which is why cross-arch builds pass --node-binary for the target arch).
# Capture postject's output + exit code SEPARATELY — piping through grep would
# mask a real injection failure behind grep's exit status (a corrupt binary must
# never proceed to signing). The "Can't find string offset" line is a benign
# postject note on some Node builds; filter it from the displayed output only.
if ! postject_out="$(npx --yes postject "$out" NODE_SEA_BLOB "$blob" --sentinel-fuse "$SENTINEL" 2>&1)"; then
  printf '%s\n' "$postject_out" | grep -vi "Can't find string offset" >&2 || true
  echo "build-platform-ops: postject injection FAILED" >&2
  exit 1
fi
printf '%s\n' "$postject_out" | grep -vi "Can't find string offset" >&2 || true
chmod +x "$out"

# Smoke the result: a binary where the blob was NOT injected runs as plain Node
# (wrong entrypoint) — catch that here rather than shipping it to be signed.
# Only when building for the host arch (a cross-arch binary can't run here).
if [ "$ARCH" = "$(case "$(uname -m)" in x86_64|amd64) echo amd64;; aarch64|arm64) echo arm64;; esac)" ]; then
  if ! "$out" version 2>/dev/null | grep -q "$VERSION"; then
    echo "build-platform-ops: smoke test FAILED — built binary does not report version ${VERSION}" >&2
    exit 1
  fi
fi

echo "build-platform-ops: wrote ${out} ($(du -h "$out" | cut -f1))"
