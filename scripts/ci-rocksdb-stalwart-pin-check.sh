#!/usr/bin/env bash
# ci-rocksdb-stalwart-pin-check.sh — rocksdb-secondary-checkpoint must link the
# SAME C++ rocksdb that Stalwart links.
#
# WHY THIS IS A GUARD AND NOT A COMMENT
#   images/rocksdb-secondary-checkpoint opens Stalwart's LIVE RocksDB store as a
#   secondary instance: both processes read the same MANIFEST and SST files. If
#   the two link different rocksdb versions, the on-disk format can disagree and
#   the checkpoint fails — against the production mail database, at archive time,
#   on real data. Nothing fails at build time.
#
#   This binary is initContainer #1 of the `no_downtime` archive path, which is
#   DEFAULT_ARCHIVE_MODE — so this is the normal path, not an edge case.
#
#   The coupling used to live in a Cargo.toml comment that read "Pinned to the
#   same C++ rocksdb version Stalwart 0.16.5 uses" while Stalwart had already
#   moved to v0.16.16. It happened to still be correct (both resolve
#   librocksdb-sys 0.17.3+10.4.2) — nobody had checked, and nothing would have
#   said so if it were not. A comment cannot hold an invariant across a version
#   bump made by someone who never opens that file.
#
# WHAT IT CHECKS
#   offline (default, hermetic — safe for every CI run):
#     1. security/components.yaml `stalwart.pinned` == rocksdb-secondary-checkpoint
#        `tracks.verified_against`. This is the one that fires: bump Stalwart and
#        CI goes red until someone re-verifies the rocksdb pin against it.
#     2. Cargo.toml pins `librocksdb-sys = "=<semver>"` matching tracks.crate_version.
#     3. Cargo.lock resolves that exact version (the lockfile is what builds).
#   --online (network; run in component-watch, which is already online):
#     4. Fetch Stalwart's Cargo.lock AT THE PINNED TAG from GitHub and confirm it
#        really resolves tracks.crate_version — i.e. that the recorded mapping is
#        true upstream, not just internally consistent.
#
# Exit: 0 clean · 1 violation · 2 harness/precondition failure
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

ONLINE=0
[[ "${1:-}" == "--online" ]] && ONLINE=1

REG="security/components.yaml"
CARGO_TOML="images/rocksdb-secondary-checkpoint/Cargo.toml"
CARGO_LOCK="images/rocksdb-secondary-checkpoint/Cargo.lock"

for f in "$REG" "$CARGO_TOML" "$CARGO_LOCK"; do
  [[ -f "$f" ]] || { echo "❌ ci-rocksdb-stalwart-pin: missing $f" >&2; exit 2; }
done

# ── read the declared coupling out of the registry ──────────────────────────
read -r STALWART_PINNED TRACK_COMPONENT TRACK_VERIFIED TRACK_CRATE TRACK_VERSION < <(
python3 - "$REG" <<'PY'
import sys, yaml
reg = yaml.safe_load(open(sys.argv[1])) or {}
comps = {c.get("id"): c for c in (reg.get("components") or [])}
rc = comps.get("rocksdb-secondary-checkpoint") or {}
t = rc.get("tracks") or {}
dep = comps.get(t.get("component", "")) or {}
print(dep.get("pinned", ""), t.get("component", ""), t.get("verified_against", ""),
      t.get("crate", ""), t.get("crate_version", ""))
PY
) || { echo "❌ ci-rocksdb-stalwart-pin: cannot parse $REG (pyyaml installed?)" >&2; exit 2; }

if [[ -z "$TRACK_COMPONENT" || -z "$TRACK_VERIFIED" || -z "$TRACK_VERSION" ]]; then
  echo "❌ ci-rocksdb-stalwart-pin: rocksdb-secondary-checkpoint has no complete 'tracks:' block in $REG" >&2
  echo "   Expected: tracks: {component, verified_against, crate, crate_version}" >&2
  exit 2
fi
# "0.17.3+10.4.2" → "0.17.3" (the part a Cargo version requirement can express)
TRACK_SEMVER="${TRACK_VERSION%%+*}"

fail=0

# ── 1. has Stalwart moved since the rocksdb pin was verified? ───────────────
if [[ "$STALWART_PINNED" != "$TRACK_VERIFIED" ]]; then
  cat >&2 <<EOF
❌ ci-rocksdb-stalwart-pin: Stalwart moved without re-verifying the rocksdb pin.

     component '$TRACK_COMPONENT' is pinned : $STALWART_PINNED
     rocksdb pin was verified against       : $TRACK_VERIFIED

  rocksdb-secondary-checkpoint opens Stalwart's LIVE store as a secondary, so the
  two must link the same C++ rocksdb. Re-verify before shipping this bump:

    ./scripts/ci-rocksdb-stalwart-pin-check.sh --online

  Then, in $REG under rocksdb-secondary-checkpoint.tracks:
    - set verified_against: "$STALWART_PINNED"
    - if upstream's $TRACK_CRATE changed, set crate_version to the new value AND
      update the '=' pin in $CARGO_TOML, then regenerate the lockfile:
        docker run --rm -v "\$PWD/images/rocksdb-secondary-checkpoint:/b" -w /b \\
          rust:1.95-bookworm cargo generate-lockfile
EOF
  fail=1
fi

# ── 2. Cargo.toml pins exactly that version ────────────────────────────────
toml_pin="$(grep -oE "^${TRACK_CRATE} *= *\"=[0-9][^\"]*\"" "$CARGO_TOML" | grep -oE '=[0-9][^"]*' | tr -d '=')"
if [[ "$toml_pin" != "$TRACK_SEMVER" ]]; then
  echo "❌ ci-rocksdb-stalwart-pin: $CARGO_TOML pins $TRACK_CRATE '${toml_pin:-<none/not an = pin>}', registry says '$TRACK_SEMVER'." >&2
  echo "   The pin must be exact ('=$TRACK_SEMVER') — a caret range would let cargo drift off Stalwart's rocksdb." >&2
  fail=1
fi

# ── 3. the LOCKFILE resolves it (the lockfile is what actually builds) ──────
lock_ver="$(awk -v c="$TRACK_CRATE" '
  $0 == "name = \"" c "\"" { getline; if ($1 == "version") { gsub(/"/, "", $3); print $3 } }
' "$CARGO_LOCK")"
if [[ "$lock_ver" != "$TRACK_VERSION" ]]; then
  echo "❌ ci-rocksdb-stalwart-pin: $CARGO_LOCK resolves $TRACK_CRATE '${lock_ver:-<absent>}', expected '$TRACK_VERSION'." >&2
  echo "   Regenerate the lockfile after changing the pin (see command above)." >&2
  fail=1
fi

# ── 4. online: is the recorded mapping actually true upstream? ──────────────
if (( ONLINE )); then
  url="https://raw.githubusercontent.com/stalwartlabs/stalwart/${STALWART_PINNED}/Cargo.lock"
  upstream_lock="$(curl -fsSL --max-time 60 "$url" 2>/dev/null)"
  if [[ -z "$upstream_lock" ]]; then
    # A network failure must not read as "verified". Distinguish it from a
    # mismatch: exit 2 (harness) so a blip is never mistaken for a green check.
    echo "❌ ci-rocksdb-stalwart-pin: could not fetch $url — NOT verified (network/tag issue)." >&2
    exit 2
  fi
  up_ver="$(printf '%s\n' "$upstream_lock" | awk -v c="$TRACK_CRATE" '
    $0 == "name = \"" c "\"" { getline; if ($1 == "version") { gsub(/"/, "", $3); print $3 } }
  ')"
  if [[ "$up_ver" != "$TRACK_VERSION" ]]; then
    cat >&2 <<EOF
❌ ci-rocksdb-stalwart-pin: upstream disagrees with the recorded mapping.

     Stalwart $STALWART_PINNED resolves $TRACK_CRATE : ${up_ver:-<absent>}
     registry tracks.crate_version                   : $TRACK_VERSION

  Update tracks.crate_version, the '=' pin in $CARGO_TOML, and the lockfile.
EOF
    fail=1
  else
    echo "  ✓ upstream Stalwart $STALWART_PINNED resolves $TRACK_CRATE $up_ver"
  fi
fi

(( fail )) && exit 1
echo "✅ ci-rocksdb-stalwart-pin: $TRACK_CRATE $TRACK_VERSION matches Stalwart $STALWART_PINNED (toml + lockfile agree)."
