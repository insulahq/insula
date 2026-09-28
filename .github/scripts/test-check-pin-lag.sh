#!/usr/bin/env bash
# TDD harness for check-pin-lag.sh, beside it.
# Run: ./.github/scripts/test-check-pin-lag.sh   (exit 0 = all pass)
#
# The guard decides whether the development image pin is orphaned by walking
# git history, so the fixtures here are real throwaway repositories: a mocked
# `git log` would only prove the guard agrees with the mock.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
GUARD="$HERE/check-pin-lag.sh"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Fixture history is written in a single second, and `git log` breaks that
# tie by walking a merge's first parent before the branch it merged — which
# put a merge's own parent ahead of the commits it brought in and quietly
# changed which commits fell inside the slack window. Every write here gets
# its own minute instead, so history reads in the order it was created.
TICK=0
git_at() { # <dir> <git args…> — the next minute on the fixture clock
  local dir="$1"; shift
  TICK=$((TICK + 1))
  local when="@$((1700000000 + TICK * 60)) +0000"
  GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" git -C "$dir" "$@"
}

PIN_REL=k8s/overlays/development/platform-version-patch.yaml

# A fresh repo with the pin file and one initial commit. Sets REPO rather
# than printing the path: a command substitution would take the fixture
# clock's ticks into a subshell with it.
new_repo() {
  local dir="$WORK/$1"
  REPO="$dir"
  mkdir -p "$dir/$(dirname "$PIN_REL")" "$dir/backend" "$dir/documentation/docs"
  git -C "$dir" init --quiet
  git -C "$dir" config user.email t@example.test
  git -C "$dir" config user.name t
  echo 'seed' > "$dir/backend/seed.txt"
  commit "$dir" 'feat: seed'
}

# commit <dir> <subject> [file ...] — touches each file (default backend/app.ts).
commit() {
  local dir="$1" subject="$2"; shift 2
  local files=("$@"); [[ ${#files[@]} -eq 0 ]] && files=(backend/app.ts)
  local f
  for f in "${files[@]}"; do
    mkdir -p "$dir/$(dirname "$f")"
    echo "$subject" >> "$dir/$f"
    git -C "$dir" add "$f"
  done
  git_at "$dir" commit --quiet -m "$subject"
}

# Point the pin at a commit-ish (or at a literal sha for the orphan cases).
pin_to() {
  local dir="$1" sha="$2"
  sha=$(git -C "$dir" rev-parse --short=7 "$sha" 2>/dev/null || echo "$sha")
  printf 'spec:\n  template:\n    metadata:\n      labels:\n        version: "2026.9.1-%s"\n' \
    "$sha" > "$dir/$PIN_REL"
  git -C "$dir" add "$PIN_REL"
  git_at "$dir" commit --quiet -m "chore(development): pin platform-version to 2026.9.1-$sha"
}

run() { ( cd "$1" && bash "$GUARD" >/dev/null 2>&1 ); }
run_out() { ( cd "$1" && bash "$GUARD" 2>&1 ); }
expect() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want rc=$2 got rc=$3)"; fi; }

echo '── the pin is current ──'
new_repo healthy; d=$REPO
commit "$d" 'fix: something in the backend'
pin_to "$d" HEAD~0
expect 'pin on the last code commit passes' 0 "$(run "$d"; echo $?)"

echo '── documentation commits on top of a healthy pin ──'
# The regression this harness exists for: a docs commit triggers no build, so
# no pin can ever name it. Three of them used to exhaust the slack and report
# an orphan on a pin that was correct.
new_repo docs-on-top; d=$REPO
commit "$d" 'fix: backend change that builds'
pin_to "$d" HEAD
commit "$d" 'docs: one'   documentation/docs/a.md
commit "$d" 'docs: two'   documentation/docs/b.md
commit "$d" 'docs: three' documentation/docs/c.md
commit "$d" 'docs: four'  documentation/docs/d.md
expect 'four non-building commits do not age the pin' 0 "$(run "$d"; echo $?)"

echo '── a stale pin is still caught ──'
new_repo orphan; d=$REPO
commit "$d" 'fix: built and pinned'
pin_to "$d" HEAD
commit "$d" 'fix: built, pin never landed' backend/one.ts
commit "$d" 'fix: and another'            backend/two.ts
commit "$d" 'fix: and a third'            backend/three.ts
expect 'three unpinned code commits fail' 1 "$(run "$d"; echo $?)"

echo '── slack for an in-flight pin ──'
new_repo inflight; d=$REPO
commit "$d" 'fix: built and pinned'
pin_to "$d" HEAD
commit "$d" 'fix: build in flight' backend/later.ts
expect 'one code commit ahead of the pin passes' 0 "$(run "$d"; echo $?)"

echo '── which paths count ──'
new_repo paths; d=$REPO
commit "$d" 'fix: built and pinned'
pin_to "$d" HEAD
commit "$d" 'chore: infra' k8s/base/thing.yaml
commit "$d" 'chore: infra' scripts/thing.sh
commit "$d" 'chore: infra' packages/api-contracts/src/x.ts
expect 'k8s, scripts and api-contracts changes do age the pin' 1 "$(run "$d"; echo $?)"

new_repo paths-ignored; d=$REPO
commit "$d" 'fix: built and pinned'
pin_to "$d" HEAD
commit "$d" 'docs: roadmap'  docs/roadmap/ROADMAP.md
commit "$d" 'chore: memory'  CHANGELOG.md
commit "$d" 'ci: some guard' .github/scripts/other-guard.sh
expect 'roadmap, changelog and non-build CI changes do not' 0 "$(run "$d"; echo $?)"

# build-deploy.yml dropped images/** — those DaemonSets are pinned by their
# own workflows, so an images-only commit produces nothing for THIS pin.
new_repo paths-images; d=$REPO
commit "$d" 'fix: built and pinned'
pin_to "$d" HEAD
commit "$d" 'fix: reconciler' images/firewall-reconciler/main.go
commit "$d" 'fix: backup tool' images/tenant-backup-tools/run.sh
commit "$d" 'fix: reconciler again' images/firewall-reconciler/other.go
expect 'images-only commits do not age the pin' 0 "$(run "$d"; echo $?)"

# A manual pin written without the conventional subject line is still a pin.
new_repo paths-pinfiles; d=$REPO
commit "$d" 'fix: built and pinned'
pin_to "$d" HEAD
commit "$d" 'chore: repin by hand' k8s/overlays/development/kustomization.yaml
commit "$d" 'chore: repin by hand' k8s/overlays/development/deploy-rev-patch.yaml
commit "$d" 'chore: repin by hand' k8s/overlays/development/kustomization.yaml
expect 'commits touching only the pin files do not age the pin' 0 "$(run "$d"; echo $?)"

echo '── a merge commit reports what it merged ──'
# A merge shows no files of its own. Without -m --first-parent it would look
# like a commit that built nothing, and a promote merge full of backend code
# would stop ageing the pin — the exact blindness this guard exists to avoid.
new_repo merge; d=$REPO
commit "$d" 'fix: built and pinned'
pin_to "$d" HEAD
git -C "$d" checkout --quiet -b side
commit "$d" 'fix: one on a branch'   backend/one.ts
commit "$d" 'fix: two on a branch'   backend/two.ts
commit "$d" 'fix: three on a branch' backend/three.ts
git -C "$d" checkout --quiet -
git_at "$d" merge --quiet --no-ff -m 'Merge pull request #1 from side' side
expect 'a merge bringing backend code ages the pin' 1 "$(run "$d"; echo $?)"
# The merge must be the newest counted commit. If it were skipped as
# file-less, the list would start with one of the branch commits instead.
merge_sha=$(git -C "$d" rev-parse --short=7 HEAD)
if grep -q "\[0\] $(git -C "$d" rev-parse HEAD | cut -c1-12)" <<<"$(run_out "$d")"; then
  ok 'the merge itself is counted, not skipped as file-less'
else
  bad "the merge $merge_sha was not counted as a code commit"
fi

# `git diff-tree -m` reports the union of the diffs against every parent, so
# a merge of a documentation branch would inherit whatever landed on the
# trunk while that branch was open — and count as a commit with an image
# behind it. GitHub's own path filter sees the first-parent diff, and so
# must this. Two building commits sit between the pin and the merge, so the
# verdict turns on the merge alone: count it and the pin falls out of the
# window, skip it and the pin is the third and last entry.
new_repo merge-trunk-moved; d=$REPO
commit "$d" 'fix: built and pinned'
pin_to "$d" HEAD
git -C "$d" checkout --quiet -b side
commit "$d" 'docs: on a branch' documentation/docs/side.md
git -C "$d" checkout --quiet -
commit "$d" 'fix: trunk moved on'   backend/trunk-one.ts
commit "$d" 'fix: trunk moved more' backend/trunk-two.ts
git_at "$d" merge --quiet --no-ff -m 'Merge pull request #2 from side' side
expect 'a docs-only merge does not inherit trunk-side backend files' 0 "$(run "$d"; echo $?)"

echo '── a window in which nothing builds ──'
new_repo nothing-builds; d=$REPO
commit "$d" 'fix: built and pinned'
pin_to "$d" HEAD
for i in 1 2 3 4 5; do commit "$d" "docs: page $i" "documentation/docs/p$i.md"; done
git -C "$d" rm --quiet -r --cached k8s >/dev/null 2>&1 || true
expect 'a run of documentation commits alone passes' 0 "$(run "$d"; echo $?)"

echo '── a shallow checkout must not silently skip its frontier ──'
# fetch-depth is finite, so the oldest visible commit has no readable
# parent. Counting it anyway is the safe direction: skipping it is how a
# real orphan would disappear from the window.
new_repo shallow-src; d=$REPO
commit "$d" 'fix: the commit that built'  backend/built.ts
commit "$d" 'fix: newer, never pinned'    backend/newer.ts
pin_to "$d" deadbee
SHALLOW="$WORK/shallow"
git clone --quiet --depth=2 "file://$d" "$SHALLOW" 2>/dev/null
expect 'the frontier commit still counts as a code commit' 1 "$(run "$SHALLOW"; echo $?)"

echo '── a malformed pin file is an error, not a pass ──'
new_repo malformed; d=$REPO
commit "$d" 'fix: something'
printf 'spec: {}\n' > "$d/$PIN_REL"
git -C "$d" add "$PIN_REL"
git_at "$d" commit --quiet -m 'chore(development): break the pin'
expect 'a pin with no version string fails' 1 "$(run "$d"; echo $?)"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
