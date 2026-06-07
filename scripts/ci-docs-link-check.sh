#!/bin/bash
# ci-docs-link-check.sh — fail if any referenced docs/ path does not exist.
#
# Checks two classes of references:
#   (1) repo-root-style paths  ("docs/…/FILE.md") anywhere in tracked text files
#   (2) relative markdown links ("](…FILE.md…)") inside maintained docs/*.md
#
# docs/history/ is FROZEN: links *inside* it are not validated. Prose pointers
# INTO docs/history/ from anywhere are allowed (they resolve like any path) —
# but new load-bearing references (CI scripts, runtime lookups) should target
# maintained docs instead.
#
# Known limitation: class (1) also matches docs/ paths embedded in absolute
# URLs (e.g. github.com/<org>/<repo>/blob/main/docs/<FILE>). They validate against the
# local tree — acceptable, since our URLs reference our own main branch.
#
# Usage: scripts/ci-docs-link-check.sh   (run from repo root; exits 1 on failure)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
report() { echo "BROKEN: $1 -> $2"; fail=1; }

# ---------------------------------------------------------------------------
# (1) repo-root-style docs paths in all tracked text files (except history/)
#     grep --null emits "FILE\0MATCH\n" — NUL-safe for any tracked filename.
# ---------------------------------------------------------------------------
while IFS= read -r -d '' file && IFS= read -r match; do
  [ -z "$match" ] && continue
  path="${match%%[\`\)\"\' ]*}"             # strip trailing punctuation
  [ -e "$path" ] || report "$file" "$path"
done < <(git ls-files -z \
    | grep -zvE '^docs/history/|package-lock\.json|\.(png|jpg|svg|ico|woff2?)$' \
    | xargs -0 -r grep -oE --with-filename --null 'docs/[A-Za-z0-9_.+/-]+\.(md|jsonl|ya?ml)' 2>/dev/null \
    || true)

# ---------------------------------------------------------------------------
# (2) relative markdown links inside maintained docs (history/ excluded)
# ---------------------------------------------------------------------------
while IFS= read -r f; do
  dir=$(dirname "$f")
  while IFS= read -r link; do
    [ -z "$link" ] && continue
    case "$link" in
      http://*|https://*|mailto:*|docs/*|/*) continue ;;   # class (1) or external
    esac
    target="${link%%#*}"                       # drop anchors
    target="${target%% *}"                     # drop inline '"title"' suffixes
    [ -z "$target" ] && continue
    resolved=$(realpath -m --relative-base=. "$dir/$target" 2>/dev/null || true)
    [ -e "$resolved" ] || report "$f" "$target"
  done < <(grep -oE '\]\([^)]+\.(md|jsonl|ya?ml)( "[^"]*")?(#[^)]*)?\)' "$f" 2>/dev/null \
             | sed -E 's/^\]\(//; s/\)$//' | sort -u)
done < <(git ls-files 'docs/**/*.md' 'docs/*.md' | grep -v '^docs/history/')

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "ci-docs-link-check: FAILED — fix the paths above or update the reference."
  exit 1
fi
echo "ci-docs-link-check: OK"
