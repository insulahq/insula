#!/usr/bin/env bash
# sync-development-changelog.sh — after a release is cut, reconcile the
# `development` branch's CHANGELOG so it matches the tag's released history.
#
# WHY: `cut-release.sh` promotes `## [Unreleased]` → `## [version]` in the
# CHANGELOG on the `main` worktree only (ADR-053: releases are cut from `main`).
# `development` never gets that promotion, so it perpetually carries the
# just-released content under `[Unreleased]` AND lacks the `[version]` section —
# a drift that has bitten every recent cut and forced a manual reconcile.
#
# WHAT: the release tag's CHANGELOG is authoritative for released history. This
# script rebuilds development's CHANGELOG as:
#     <header> + <reconciled [Unreleased]> + <tag's history from ## [version] down>
# where the reconciled [Unreleased] keeps only bullets NOT already in the tag's
# [version] section (i.e. work added to development AFTER the cut), dropping any
# now-empty `### Added/Fixed/…` subsections. Idempotent: a no-op once synced.
#
# Usage:  sync-development-changelog.sh --tag vX.Y.Z [--root DIR] [--write]
#   --tag     the release tag whose CHANGELOG is authoritative (required)
#   --root    repo root (default: this script's parent)
#   --write   write CHANGELOG.md in place (default: print to stdout, exit 0/2)
#
# Exit: 0 wrote/would-write a change · 2 already in sync (no change) · 1 error
set -euo pipefail

TAG="" ROOT="" WRITE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)   TAG="$2"; shift 2 ;;
    --root)  ROOT="$2"; shift 2 ;;
    --write) WRITE=1; shift ;;
    *) echo "sync-development-changelog: unknown arg '$1'" >&2; exit 1 ;;
  esac
done
[ -n "$TAG" ] || { echo "sync-development-changelog: --tag is required" >&2; exit 1; }
ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CHANGELOG="$ROOT/CHANGELOG.md"
[ -f "$CHANGELOG" ] || { echo "sync-development-changelog: $CHANGELOG not found" >&2; exit 1; }

# The tag's CHANGELOG is authoritative; read it from git (never the worktree).
TAG_CHANGELOG="$(git -C "$ROOT" show "${TAG}:CHANGELOG.md" 2>/dev/null)" \
  || { echo "sync-development-changelog: cannot read ${TAG}:CHANGELOG.md" >&2; exit 1; }

TAG="$TAG" WRITE="$WRITE" CHANGELOG="$CHANGELOG" python3 - "$TAG_CHANGELOG" <<'PY'
import os, re, sys

tag = os.environ["TAG"]
version = tag[1:] if tag.startswith("v") else tag          # vX.Y.Z -> X.Y.Z
dev = open(os.environ["CHANGELOG"]).read()
tagged = sys.argv[1]

ver_hdr_re = re.compile(r'^## \[' + re.escape(version) + r'\]', re.M)
m = ver_hdr_re.search(tagged)
if not m:
    sys.stderr.write(f"sync-development-changelog: tag CHANGELOG has no '## [{version}]' section\n")
    sys.exit(1)

# Authoritative released history = everything from '## [version]' to the end.
released_history = tagged[m.start():]

# Bullet titles already published in the tag's [version] section (dedup key).
def section(text, start_re):
    s = start_re.search(text)
    if not s:
        return ""
    nxt = re.compile(r'^## \[', re.M).search(text, s.end())
    return text[s.start(): nxt.start() if nxt else len(text)]

ver_section = section(tagged, ver_hdr_re)
def bullet_titles(block):
    # Top-level entries are '- **Title**...'; key on the bold title.
    return set(re.findall(r'^- \*\*(.+?)\*\*', block, re.M))
published = bullet_titles(ver_section)

# development's current [Unreleased] block.
unrel_re = re.compile(r'^## \[Unreleased\]', re.M)
u = unrel_re.search(dev)
if not u:
    sys.stderr.write("sync-development-changelog: development CHANGELOG has no [Unreleased]\n")
    sys.exit(1)
after = re.compile(r'^## \[', re.M).search(dev, u.end())
unrel_block = dev[u.end(): after.start() if after else len(dev)]
header = dev[:u.start()]

# Reconcile [Unreleased]: within each '### Sub' group, drop bullets whose title
# is already published; drop the whole sub-heading if it ends up empty.
lines = unrel_block.splitlines()
out_groups = []          # list of (subheading_or_None, [entry_blocks])
cur_sub = None
cur_entries = []
def flush():
    if cur_entries or cur_sub is not None:
        out_groups.append((cur_sub, cur_entries))

entry = None
for ln in lines:
    if ln.startswith('### '):
        # close current entry + group
        if entry is not None:
            cur_entries.append(entry); entry = None
        flush()
        cur_sub = ln; cur_entries = []
    elif re.match(r'^- ', ln):
        if entry is not None:
            cur_entries.append(entry)
        entry = ln + "\n"
    else:
        if entry is not None:
            entry += ln + "\n"
        # stray text outside an entry (blank lines) is ignored between entries
if entry is not None:
    cur_entries.append(entry)
flush()

kept = []
for sub, entries in out_groups:
    keep_entries = []
    for e in entries:
        tm = re.match(r'^- \*\*(.+?)\*\*', e)
        if tm and tm.group(1) in published:
            continue          # already released — drop
        keep_entries.append(e.rstrip("\n"))
    if keep_entries:
        block = (sub + "\n" if sub else "") + "\n".join(keep_entries) + "\n"
        kept.append(block)

reconciled_unrel = "## [Unreleased]\n\n" + ("\n".join(kept) + "\n" if kept else "")
new = header + reconciled_unrel + "\n" + released_history
# Normalise trailing whitespace/newlines.
new = re.sub(r'\n{3,}', '\n\n', new).rstrip("\n") + "\n"

if new == re.sub(r'\n{3,}', '\n\n', dev).rstrip("\n") + "\n":
    sys.stderr.write(f"sync-development-changelog: already in sync with {tag} — no change\n")
    sys.exit(2)

if os.environ.get("WRITE") == "1":
    open(os.environ["CHANGELOG"], "w").write(new)
    sys.stderr.write(f"sync-development-changelog: reconciled development CHANGELOG against {tag}\n")
else:
    sys.stdout.write(new)
sys.exit(0)
PY
