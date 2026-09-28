#!/bin/bash
# Verify the development-branch pin points to the most-recent code commit.
#
# Detects "orphaned image" state: when an auto-pin commit failed to
# land (e.g. cross-workflow race), the previous pin remains in place,
# the just-built image stays unpinned forever, and the next code push
# pin "skips over" it. This script catches that state at PR time so
# the operator can recover before piling more PRs on top.
#
# Rule
# ----
# the `<version>-<sha>` pin in k8s/overlays/development/platform-version-patch.yaml
# MUST equal the short SHA of the most-recent commit on the ref whose
# message does NOT start with `chore(development):` (or legacy `chore(staging):`) (i.e. the last code /
# infra / merge commit, ignoring auto-pin churn).
#
# A 2-commit slack absorbs the brief window where a code commit has
# landed but its auto-pin hasn't yet — the pin still references that
# code commit's parent, which is normal in-flight state.
#
# Exit codes
# ----------
#   0  — pin is healthy
#   1  — pin is stale (> 2 commits behind last code commit) OR malformed
#
set -euo pipefail

PIN_FILE=k8s/overlays/development/platform-version-patch.yaml

if [[ ! -f "$PIN_FILE" ]]; then
  echo "::error::$PIN_FILE not found"
  exit 1
fi

# Extract the short SHA suffix from `version: "<base>-XXXXXXX"`. The base is
# whatever cut-release.sh / build-deploy.sh produced — CalVer (2026.6.1-<sha>)
# since the version spine landed, or the legacy 0.1.0-<sha>. We only need the
# trailing hex SHA, so match any `<base>-<7+hex>` shape.
PIN_SHA=$(grep -oE 'version: *"[0-9A-Za-z.]+-[0-9a-f]{7,40}"' "$PIN_FILE" \
  | head -1 \
  | sed -E 's/.*-([0-9a-f]{7,40})".*/\1/')

if [[ -z "$PIN_SHA" ]]; then
  echo "::error::could not extract a '<version>-<sha>' pin from $PIN_FILE — file shape changed?"
  cat "$PIN_FILE"
  exit 1
fi

# Collect up to SLACK_N+1 most-recent commits that could have an image
# behind them — decided by what each commit CHANGED, not by how its
# subject line is worded.
#
# Auto-pins ("chore(development): pin platform-version to ...") and manual
# pins fall out on their own: they touch nothing but the three pin files,
# which PIN_PATHS_RE removes. Matching the subject line instead would be
# trusting a convention nothing enforces — a commit carrying that prefix
# while changing backend code would leave the window silently, and if it
# were the only such commit the guard would report a healthy pin over a
# permanent orphan.
#
# SLACK_N defines how many code commits behind the latest is still
# considered "in flight, not yet orphaned":
#   - 0 → strict (pin must match HEAD's last code commit exactly)
#   - 1 → covers single auto-pin in flight
#   - 2 → covers 3-commit-rapid-fire race (typical operator workflow
#         where two PRs merge in quick succession + one in-flight pin)
# We use 2 — false-positive rate < 1% on hourly cron, and a real
# orphan would still be caught within 2 more code commits, which is
# acceptable detection latency. Note the unit: commits that BUILD.
# Commits that produce no image no longer advance this window, so the
# hourly cron alone does not shorten the wait — the next build does,
# and that build re-pins anyway.
#
# Implemented as a while-read loop (instead of `grep -v | head -3`)
# to avoid SIGPIPE under `set -o pipefail` — head closing the pipe
# after the third match would terminate grep with rc=141 and fail
# the script.
# Paths that make Build Images run at all. Mirrors the positive `paths:`
# list in .github/workflows/build-deploy.yml — a commit touching none of
# them produces no image and therefore no auto-pin.
#
# `images/**` is deliberately absent: build-deploy.yml dropped it (those
# DaemonSets are pinned by their own ci-*.yml), so an images-only commit
# never reaches this pin either.
BUILD_PATHS_RE='^(backend/|frontend/admin-panel/|frontend/tenant-panel/|packages/api-contracts/|k8s/|scripts/|\.github/workflows/build-deploy\.yml$)'

# The files a pin itself rewrites. Writing one of these IS the pin, so a
# commit that touches nothing else has no image of its own to be measured
# against. Three of them come from apply-development-pin.sh (the trio
# build-deploy excludes from its own triggers for the same reason);
# platform-config-patch.yaml comes from pin-config-image.sh, which the
# seven per-image workflows run to pin an image the backend resolves at
# runtime. Those fire concurrently by design — several such commits land
# in a row — and each one wrongly counted is a slot of slack spent on a
# pin that can never exist.
PIN_PATHS_RE='^k8s/overlays/development/(kustomization|platform-version-patch|deploy-rev-patch|platform-config-patch)\.yaml$'

# Does this commit touch anything Build Images watches?
#
# Diffed explicitly against the FIRST PARENT, which is what a push event
# shows GitHub and therefore what decides whether build-deploy ran. The
# obvious `git diff-tree -m --first-parent` does not do this: --first-parent
# is silently ignored by diff-tree, and -m returns the union of the diffs
# against every parent — so a merge of a documentation-only branch would
# report the backend files that landed on the trunk while that branch was
# open, and count as a commit with an image behind it.
#
# A commit whose parent cannot be read — the repository's first commit, or
# the frontier of the shallow checkout this runs in — is diffed against the
# empty tree, which lists its whole tree and counts as building. That is the
# safe direction: a commit we cannot classify must not silently drop out of
# the window, because dropping it is what hides an orphan.
#
# The file list is captured into a variable before grep sees it: a
# `git … | grep -q` pipeline under `set -o pipefail` can return 141 when
# grep exits on the first match and git dies of SIGPIPE, which reads as
# "builds nothing" for a commit that does.
builds_something() {
  local sha="$1" parent files
  parent=$(git rev-parse --verify --quiet "${sha}^1" 2>/dev/null || true)
  if [[ -n "$parent" ]] && git cat-file -e "${parent}^{commit}" 2>/dev/null; then
    files=$(git diff-tree --no-commit-id --name-only -r "$parent" "$sha")
  else
    files=$(git diff-tree --no-commit-id --name-only -r --root "$sha")
  fi
  files=$(grep -vE "$PIN_PATHS_RE" <<<"$files" || true)
  [[ -n "$files" ]] && grep -qE "$BUILD_PATHS_RE" <<<"$files"
}

SLACK_N=2
CODE_COMMITS=()
while IFS=' ' read -r sha msg_rest; do
  # `[skip ci]` is the one thing a subject line can say that a diff
  # cannot: GitHub really does not run the workflow, so no image exists
  # however much build-relevant code the commit changed. Counting them
  # made this guard cry wolf after EVERY release — release.yml pushes two
  # [skip ci] sync commits back to development (platform/VERSION +
  # CHANGELOG), enough on their own to push the last built commit outside
  # SLACK_N (observed 2026-08-26 after v2026.8.18).
  case "$msg_rest" in
    *'[skip ci]'*) continue ;;
  esac
  # A commit that changed nothing Build Images watches has no image to be
  # pinned to, so counting it spends the slack on a pin that can never
  # exist. Three documentation commits in a row did exactly that while
  # cutting a release — the pin was healthy and this guard called it
  # orphaned.
  builds_something "$sha" || continue
  CODE_COMMITS+=("$sha")
  if [[ ${#CODE_COMMITS[@]} -gt $SLACK_N ]]; then
    break
  fi
done < <(git log --pretty='%H %s' -n 100)

if [[ ${#CODE_COMMITS[@]} -eq 0 ]]; then
  # No commit in the window produces an image, so there is nothing for the
  # pin to be behind and failing here would be the very false alarm this
  # guard keeps raising on documentation runs. A pin orphaned WITHIN the
  # window still fails, because the commit that orphaned it built by
  # definition and is therefore in this list.
  #
  # It is still worth saying out loud: on this repository a hundred
  # commits that touch no build path is not a normal state, and an orphan
  # older than the window would hide behind exactly this message. A
  # warning annotation puts it in front of whoever reads the run without
  # blocking them.
  echo "::warning::no commit in the last 100 builds an image — the pin cannot be checked against them"
  echo "✓ nothing in the window builds; pin left alone"
  exit 0
fi

LAST_CODE_FULL_SHA="${CODE_COMMITS[0]}"
LAST_CODE_SHORT=$(git rev-parse --short=7 "$LAST_CODE_FULL_SHA")

# Happy path: pin matches the latest code commit exactly.
if [[ "$PIN_SHA" == "$LAST_CODE_SHORT" ]]; then
  echo "✓ pin SHA $PIN_SHA matches last code commit ${LAST_CODE_FULL_SHA:0:12}"
  exit 0
fi

# Slack: pin may still reference a code commit up to SLACK_N positions
# behind LAST_CODE if its auto-pin hasn't landed yet (typical race:
# ~5 min from push to pin landing) or if multiple Build Images jobs
# finished out of order. The auto-pin step only runs once Build Images
# finishes, so these in-flight states are expected — not orphans.
for ((i = 1; i < ${#CODE_COMMITS[@]}; i++)); do
  ancestor_full="${CODE_COMMITS[$i]}"
  ancestor_short=$(git rev-parse --short=7 "$ancestor_full")
  if [[ "$PIN_SHA" == "$ancestor_short" ]]; then
    echo "⚠ pin SHA $PIN_SHA matches code commit ${ancestor_full:0:12} ($i behind last) — auto-pin queue likely draining"
    exit 0
  fi
done

# Lag detected.
echo "::error::PIN LAG DETECTED — development-branch image pin is stale"
echo ""
echo "  pin file:           $PIN_FILE"
echo "  pin SHA:            0.1.0-$PIN_SHA"
echo "  last code commit:   ${LAST_CODE_FULL_SHA:0:12} (short: ${LAST_CODE_SHORT})"
echo "  acceptable slack:   last ${#CODE_COMMITS[@]} code commit(s) — none matched"
echo "  last code commits:"
for ((i = 0; i < ${#CODE_COMMITS[@]}; i++)); do
  ancestor_short=$(git rev-parse --short=7 "${CODE_COMMITS[$i]}")
  echo "    [$i] ${CODE_COMMITS[$i]:0:12} (short: ${ancestor_short})"
done
echo ""
echo "Likely cause: a recent Build Images run successfully built and pushed"
echo "images to GHCR, but its trailing auto-pin commit failed to land on"
echo "development (the rebase recovery from cross-workflow collisions can"
echo "still fail in rare cases). Subsequent auto-pins will skip over"
echo "the orphaned image — the workload it should have deployed is stuck"
echo "on the previous version."
echo ""
echo "Recovery:"
echo "  1. List recent Build Images runs:"
echo "       gh run list --branch development --workflow='Build Images' --limit 5"
echo "  2. Find the failed run for short SHA $LAST_CODE_SHORT, view its"
echo "     'Update development platform-version → Pin image tags' step log,"
echo "     and copy BACKEND_TAG / ADMIN_TAG / TENANT_TAG."
echo "  3. Write the pin manually by updating these three files:"
echo "       k8s/overlays/development/platform-version-patch.yaml"
echo "       k8s/overlays/development/deploy-rev-patch.yaml"
echo "       k8s/overlays/development/kustomization.yaml"
echo "     (the apply-development-pin.sh helper does this idempotently)."
echo "  4. Commit + push to development (a commit touching only the pin"
echo "     files counts as a pin, not as code, so this guard won't fail again)."
echo ""
echo "Or, if the Build Images run for $LAST_CODE_SHORT failed entirely"
echo "(no images pushed to GHCR), re-trigger a build with:"
echo "       gh workflow run 'Build Images' --ref development"
exit 1
