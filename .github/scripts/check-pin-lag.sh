#!/bin/bash
# Verify staging is pinned to the most-recent code commit.
#
# Detects "orphaned image" state: when an auto-pin commit failed to
# land (e.g. cross-workflow race), the previous pin remains in place,
# the just-built image stays unpinned forever, and the next code push
# pin "skips over" it. This script catches that state at PR time so
# the operator can recover before piling more PRs on top.
#
# Rule
# ----
# `0.1.0-XXXXX` in k8s/overlays/staging/platform-version-patch.yaml
# MUST equal the short SHA of the most-recent commit on the ref whose
# message does NOT start with `chore(staging):` (i.e. the last code /
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

PIN_FILE=k8s/overlays/staging/platform-version-patch.yaml

if [[ ! -f "$PIN_FILE" ]]; then
  echo "::error::$PIN_FILE not found"
  exit 1
fi

# Extract the SHA after `0.1.0-` from `version: "0.1.0-XXXXXXX"`.
PIN_SHA=$(grep -oE 'version: *"0\.1\.0-[0-9a-f]+"' "$PIN_FILE" \
  | head -1 \
  | sed -E 's/.*0\.1\.0-([0-9a-f]+)".*/\1/')

if [[ -z "$PIN_SHA" ]]; then
  echo "::error::could not extract '0.1.0-XXXXXXX' from $PIN_FILE — file shape changed?"
  cat "$PIN_FILE"
  exit 1
fi

# Collect up to SLACK_N+1 most-recent commits whose message does NOT
# begin with `chore(staging):`. That filter excludes both bot
# auto-pins ("chore(staging): pin platform-version to ...") and human
# manual pins ("chore(staging): manual pin to ..."). Anything else —
# feat/fix/refactor/chore(other)/ci/merge commits — counts as a
# "code commit" whose images should be represented in the pin.
#
# SLACK_N defines how many code commits behind the latest is still
# considered "in flight, not yet orphaned":
#   - 0 → strict (pin must match HEAD's last code commit exactly)
#   - 1 → covers single auto-pin in flight
#   - 2 → covers 3-commit-rapid-fire race (typical operator workflow
#         where two PRs merge in quick succession + one in-flight pin)
# We use 2 — false-positive rate < 1% on hourly cron, and a real
# orphan would still be caught within 2 more code commits (or by the
# next cron tick) which is acceptable detection latency.
#
# Implemented as a while-read loop (instead of `grep -v | head -3`)
# to avoid SIGPIPE under `set -o pipefail` — head closing the pipe
# after the third match would terminate grep with rc=141 and fail
# the script.
SLACK_N=2
CODE_COMMITS=()
while IFS=' ' read -r sha msg_rest; do
  case "$msg_rest" in
    'chore(staging):'*) continue ;;
    *)
      CODE_COMMITS+=("$sha")
      if [[ ${#CODE_COMMITS[@]} -gt $SLACK_N ]]; then
        break
      fi
      ;;
  esac
done < <(git log --pretty='%H %s' -n 100)

if [[ ${#CODE_COMMITS[@]} -eq 0 ]]; then
  echo "::error::no non-chore(staging) commit found in last 100 commits — fetch depth too shallow or branch is pure staging churn"
  exit 1
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
echo "::error::PIN LAG DETECTED — staging image pin is stale"
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
echo "main (the rebase recovery from cross-workflow collisions can still"
echo "fail in rare cases). Subsequent commits' auto-pins will skip over"
echo "the orphaned image — the workload it should have deployed is stuck"
echo "on the previous version."
echo ""
echo "Recovery:"
echo "  1. List recent Build Images runs:"
echo "       gh run list --branch main --workflow='Build Images' --limit 5"
echo "  2. Find the failed run for short SHA $LAST_CODE_SHORT, view its"
echo "     'Update staging platform-version → Pin image tags' step log,"
echo "     and copy BACKEND_TAG / ADMIN_TAG / TENANT_TAG."
echo "  3. Write the pin manually by updating these three files:"
echo "       k8s/overlays/staging/platform-version-patch.yaml"
echo "       k8s/overlays/staging/deploy-rev-patch.yaml"
echo "       k8s/overlays/staging/kustomization.yaml"
echo "     (the apply-staging-pin.sh helper does this idempotently)."
echo "  4. Commit + push to main (the manual-pin commit itself satisfies"
echo "     the chore(staging): prefix filter so this guard won't fail again)."
echo ""
echo "Or, if the Build Images run for $LAST_CODE_SHORT failed entirely"
echo "(no images pushed to GHCR), re-trigger a build with:"
echo "       gh workflow run 'Build Images' --ref main"
exit 1
