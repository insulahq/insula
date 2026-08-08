#!/usr/bin/env bash
# ci-actions-pinned-check.sh — every GitHub Action must be pinned to a full
# commit SHA, never a tag or branch.
#
# THE BUG THIS PREVENTS
#   A tag is a MUTABLE pointer. `actions/checkout@v7` resolves to whatever commit
#   the tag names at the moment the job starts, so whoever can move that tag —
#   the maintainer, or anyone who takes over the maintainer's account — executes
#   arbitrary code inside our runner. That runner holds the checkout, the registry
#   credentials and, in several jobs here, a `contents: write` token. This is the
#   tj-actions/changed-files pattern: one retagged release, thousands of repos
#   leaking secrets, no CVE and no version bump to notice.
#
#   The whole workflow tree was SHA-pinned on 2026-08-05 — and by 2026-08-06 it
#   was 227/228, because nothing enforced it. The single drifted reference was
#   `actions/checkout@v7` in release.yml's version-sync job, which runs with
#   `permissions: contents: write`. Pinning by hand is a one-time act; this guard
#   is what makes it a property.
#
# THE RULE
#   uses: owner/repo@<40-hex-sha>   # vX.Y   ← comment the human-readable version
#   Local actions (`./.github/...`) are exempt: they come from this checkout, so
#   they are already pinned by the commit under test.
#   Docker refs (`docker://…`) must carry an @sha256: digest for the same reason.
#
# Exit: 0 clean · 1 violations found
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

violations=0
report=""

while IFS= read -r f; do
  while IFS= read -r hit; do
    line_no="${hit%%:*}"
    text="${hit#*:}"
    # Strip everything up to and including `uses:`, then take the first token —
    # the ref may be followed by a `# v7` comment.
    ref="$(printf '%s' "$text" | sed -E 's/.*uses:[[:space:]]*//' | awk '{print $1}' | tr -d '"'"'"'')"
    [[ -n "$ref" ]] || continue
    # Local action from this very checkout — already pinned by the commit itself.
    [[ "$ref" == ./* ]] && continue
    if [[ "$ref" == docker://* ]]; then
      # A docker action is third-party code too; require a digest.
      [[ "$ref" == *@sha256:* ]] && continue
      report+="  $f:$line_no: docker ref not digest-pinned → $ref"$'\n'
      violations=$((violations + 1))
      continue
    fi
    # Everything else must end in @<40 hex chars>.
    if [[ ! "$ref" =~ @[0-9a-f]{40}$ ]]; then
      report+="  $f:$line_no: not SHA-pinned → $ref"$'\n'
      violations=$((violations + 1))
    fi
  done < <(grep -nE '^[[:space:]]*-?[[:space:]]*uses:' "$f" 2>/dev/null || true)
done < <(git ls-files '.github/workflows/*.yml' '.github/workflows/*.yaml' '.github/actions/**/*.yml' '.github/actions/**/*.yaml' 2>/dev/null)

if (( violations > 0 )); then
  echo "❌ ci-actions-pinned: $violations unpinned action reference(s):" >&2
  printf '%s' "$report" >&2
  cat >&2 <<'EOF'

  A tag is mutable: whoever can move it runs code in our runner, with whatever
  permissions that job holds. Pin to the full commit SHA and keep the version in
  a trailing comment so the reference stays readable:

    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

  Resolve a tag to its SHA with:
    gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq '.object.sha'
  (if that returns an annotated-tag object, dereference it:
    gh api repos/<owner>/<repo>/git/tags/<sha> --jq '.object.sha')
EOF
  exit 1
fi

echo "✅ ci-actions-pinned: every action reference is pinned to a commit SHA."
