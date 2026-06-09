#!/usr/bin/env bash
# install-git-hooks.sh — install the repo's git hooks into .git/hooks.
#
# Adds the pre-commit secret/infra guard WITHOUT disturbing any existing hook
# (e.g. the pre-push lint/typecheck). Safe to re-run. Symlinks so the hook stays
# in sync with the tracked source under scripts/git-hooks/.
set -euo pipefail

repo="$(git rev-parse --show-toplevel)"
hooks_dir="$(git rev-parse --git-path hooks)"
mkdir -p "$hooks_dir"

src="$repo/scripts/git-hooks/pre-commit"
dest="$hooks_dir/pre-commit"

if [[ -e "$dest" && ! -L "$dest" ]]; then
  echo "warning: $dest exists and is not a symlink — backing up to $dest.bak"
  mv "$dest" "$dest.bak"
fi
ln -sf "$src" "$dest"
chmod +x "$src"
echo "✓ installed pre-commit hook → $dest"
echo "  (CI enforces the same checks; this is the local early-warning.)"
command -v gitleaks >/dev/null 2>&1 \
  || echo "  note: install 'gitleaks' locally to enable staged-secret scanning in the hook."
