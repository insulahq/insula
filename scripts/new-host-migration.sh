#!/usr/bin/env bash
# new-host-migration.sh — scaffold a W10c host-migration (Tier 3).
#
# Authoring a host-migration is FORCED in two places — the per-PR
# ci-migration-coverage.sh guard (firewall-shape change → migration required)
# and the cut-release.sh release-time audit. This scaffolder removes the
# friction: it creates a correctly-named, correctly-located, contract-complete
# stub so a migration never lands missing the `# idempotent:` / `# allow-paths:`
# headers or a malformed name that ci-host-migrations-check.sh would reject.
#
# Usage:
#   scripts/new-host-migration.sh NAME [--version YYYY.M.P] [--root DIR] [--print-path]
#   make new-host-migration NAME=relabel-longhorn-mount [VERSION=2026.7.1]
#
#   NAME           kebab-case migration name (e.g. relabel-longhorn-mount)
#   --version      target release version dir; default: the NEXT version
#                  (scripts/cut-release.sh --print-version) so it lands in the
#                  upcoming release. Any -rc.N suffix is stripped (migrations
#                  ship in the final version dir).
#   --root DIR     repo root (default: this script's parent)
#   --print-path   print only the path that WOULD be created, then exit 0
#                  (no file written) — for tests / scripting.
#
# Picks the next zero-padded 4-digit NNNN within the version dir. REFUSES to
# overwrite an existing script (once shipped, a migration's path is its
# contract — never rename/renumber/edit). Exit: 0 ok · 1 error · 2 usage.
set -euo pipefail

NAME="" VERSION="" ROOT="" PRINT_PATH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || { echo "new-host-migration: --version requires a value" >&2; exit 2; }; VERSION="$2"; shift 2 ;;
    --root)    [ $# -ge 2 ] || { echo "new-host-migration: --root requires a value" >&2; exit 2; }; ROOT="$2"; shift 2 ;;
    --print-path) PRINT_PATH=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    -*) echo "new-host-migration: unknown arg: $1" >&2; exit 2 ;;
    *) [ -z "$NAME" ] || { echo "new-host-migration: unexpected extra arg: $1" >&2; exit 2; }; NAME="$1"; shift ;;
  esac
done

[ -n "$NAME" ] || { echo "new-host-migration: NAME is required (kebab-case, e.g. relabel-longhorn-mount)" >&2; exit 2; }
# Kebab-case, matching the part of ci-host-migrations-check.sh's NAME_RE that
# follows the numeric prefix: lowercase alnum, single hyphens, no leading/
# trailing/double hyphen.
if ! printf '%s' "$NAME" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$'; then
  echo "new-host-migration: NAME '$NAME' must be kebab-case (^[a-z0-9]+(-[a-z0-9]+)*$)" >&2
  exit 2
fi

[ -n "$ROOT" ] || ROOT=$(cd "$(dirname "$0")/.." && pwd)

# Default version = the next release version, so a migration authored now ships
# in the upcoming release. Strip any -rc.N (migrations live in the base dir).
if [ -z "$VERSION" ]; then
  VERSION=$("$ROOT/scripts/cut-release.sh" --print-version --root "$ROOT" 2>/dev/null || true)
  VERSION="${VERSION%%-rc.*}"
fi
[ -n "$VERSION" ] || { echo "new-host-migration: could not determine version (pass --version YYYY.M.P)" >&2; exit 1; }
# CalVer, matching ci-host-migrations-check.sh VER_RE.
if ! printf '%s' "$VERSION" | grep -qE '^[0-9]{4}\.[0-9]{1,2}\.[0-9]+$'; then
  echo "new-host-migration: --version '$VERSION' is not CalVer (^[0-9]{4}\\.[0-9]{1,2}\\.[0-9]+$)" >&2
  exit 2
fi

VER_DIR="$ROOT/platform/host-migrations/$VERSION"

# Next NNNN: max existing 4+-digit prefix in the version dir + 1 (4-padded).
next_num=1
if [ -d "$VER_DIR" ]; then
  max=0
  for f in "$VER_DIR"/[0-9]*-*.sh; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    num="${base%%-*}"
    case "$num" in *[!0-9]*) continue ;; esac
    num=$((10#$num))
    [ "$num" -gt "$max" ] && max="$num"
  done
  next_num=$((max + 1))
fi
printf -v padded '%04d' "$next_num"

REL="platform/host-migrations/$VERSION/${padded}-${NAME}.sh"
DEST="$ROOT/$REL"

if [ "$PRINT_PATH" -eq 1 ]; then
  printf '%s\n' "$REL"
  exit 0
fi

if [ -e "$DEST" ]; then
  echo "new-host-migration: $REL already exists — refusing to overwrite (migrations are order-stable)" >&2
  exit 1
fi

mkdir -p "$VER_DIR"
# Stub satisfies ci-host-migrations-check.sh (shebang, set -euo pipefail, both
# header contracts, kebab name, shellcheck-clean) and FAILS LOUDLY until
# implemented — an un-edited stub must never silently "succeed" doing nothing.
cat > "$DEST" <<EOF
#!/usr/bin/env bash
# idempotent: TODO — describe why re-running on an already-applied node is a no-op
# allow-paths: TODO — list the host path(s) this migration may touch (review allow-list)
set -euo pipefail

# TODO: implement the host change for "${NAME}".
#  - Idempotent: guard your writes (the runner's per-node .done marker helps,
#    but defend anyway — e.g. cmp -s / grep -q before writing).
#  - You MAY assume earlier-numbered migrations in this version already ran;
#    NEVER assume which platform version the node was on when this runs.
#  - Runs as root via 'bash' from stdin: no \$0 / \$BASH_SOURCE, clean env
#    (PATH + HOME only), 10-minute timeout.
echo "host-migration ${padded}-${NAME}: not yet implemented" >&2
exit 1
EOF
chmod +x "$DEST"

echo "✓ created $REL"
echo
echo "Next steps:"
echo "  1. Implement the change + fill in the '# idempotent:' / '# allow-paths:' headers."
echo "  2. If it backfills a scripts/bootstrap.sh firewall-shape change, refresh the"
echo "     baseline:  ./scripts/ci-migration-coverage.sh --update-baseline   (commit the hash)."
echo "  3. Add a CHANGELOG [Unreleased] entry; a host path outside '# allow-paths:'"
echo "     needs a '### BREAKING' note."
echo "  4. Validate:  ./scripts/ci-host-migrations-check.sh"
