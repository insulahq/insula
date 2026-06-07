#!/bin/bash
# ci-docs-link-check.sh — fail if any referenced docs/ path does not exist.
#
# Checks two classes of references:
#   (1) repo-root-style paths  ("docs/…/FILE.md") anywhere in tracked text files
#   (2) relative markdown links ("](…FILE.md…)") inside maintained docs/*.md
#
# docs/history/ is FROZEN: links *inside* it are not validated, and nothing
# outside docs/history/ may point INTO it from code/scripts/CI (docs may).
#
# Usage: scripts/ci-docs-link-check.sh   (run from repo root; exits 1 on failure)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
report() { echo "BROKEN: $1 -> $2"; fail=1; }

# ---------------------------------------------------------------------------
# (1) repo-root-style docs paths in all tracked text files (except history/)
# ---------------------------------------------------------------------------
while IFS=: read -r file match; do
  [ -z "$file" ] && continue
  path="${match%%[\`\)\"\' ]*}"             # strip trailing punctuation
  [ -e "$path" ] || report "$file" "$path"
done < <(git ls-files -z \
    | grep -zvE '^docs/history/|package-lock\.json|\.(png|jpg|svg|ico|woff2?)$' \
    | xargs -0 grep -hoE --with-filename 'docs/[A-Za-z0-9_./+-]+\.(md|jsonl|ya?ml)' 2>/dev/null \
    | sort -u)

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
    [ -z "$target" ] && continue
    resolved=$(realpath -m --relative-base=. "$dir/$target" 2>/dev/null || true)
    [ -e "$resolved" ] || report "$f" "$target"
  done < <(grep -oE '\]\([^)]+\.(md|jsonl)(#[^)]*)?\)' "$f" 2>/dev/null \
             | sed -E 's/^\]\(//; s/\)$//' | sort -u)
done < <(git ls-files 'docs/**/*.md' 'docs/*.md' | grep -v '^docs/history/')

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "ci-docs-link-check: FAILED — fix the paths above or move the target out of docs/history/."
  exit 1
fi
echo "ci-docs-link-check: OK"
