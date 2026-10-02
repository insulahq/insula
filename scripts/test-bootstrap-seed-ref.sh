#!/usr/bin/env bash
# TDD harness for the git ref bootstrap.sh's one-shot platform apply ("seed")
# clones. Run: ./scripts/test-bootstrap-seed-ref.sh   (exit 0 = all pass)
#
# Why this exists: a production install with `--release-tag v2026.10.2` cloned
# origin HEAD (main) for its imperative apply while Flux was pinned to the tag.
# With a release candidate on main, the "v2026.10.2" install applied the RC's
# manifests: RC images started and ran the RC's DB migrations before Flux rolled
# the Deployments back, and objects that exist only on main (seven admission
# policies) stayed behind for good — Flux prunes only what it applied itself.
# The seed must be the SAME ref Flux reconciles, in every environment.
#
# The pure helpers are extracted from the SHIPPED script and run for real
# against a stub kubectl; call sites are asserted structurally (the repo's
# ci-*-check idiom), because apply_platform_manifests cannot run off-host.
# shellcheck disable=SC2034
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.sh"

pass=0; fail=0
ok()    { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }
has()   { if grep -qF -- "$2" <<<"$1"; then ok "$3"; else bad "$3 — not found: $2"; fi; }
hasnt() { if grep -qF -- "$2" <<<"$1"; then bad "$3 — unexpectedly found: $2"; else ok "$3"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fn_body() { sed -n "/^$1() {/,/^}/p" "$BOOTSTRAP"; }

for fn in resolve_production_release_tag platform_seed_ref; do
  body="$(fn_body "$fn")"
  if [[ -z "$body" ]]; then bad "bootstrap.sh defines $fn()"; else ok "bootstrap.sh defines $fn()"; fi
  printf '%s\n' "$body" >> "$WORK/helpers.sh"
done

# A checkout whose platform/VERSION says 2026.10.2 (BOOTSTRAP_SCRIPT_DIR/../platform/VERSION).
mkdir -p "$WORK/repo/scripts" "$WORK/repo/platform"
printf '2026.10.2\n' > "$WORK/repo/platform/VERSION"

# seed <env> [release-tag] [live-tag] [live-branch] [artifact-revision] [skip-flux]
# — runs platform_seed_ref against a stub kctl serving that GitRepository
# (only the source named for <env>; any other name answers empty).
SHA=a7018ac3166db995cca7f7da467f8bf3546e5bf8
seed() {
  ( PLATFORM_ENV="$1" RELEASE_TAG="${2:-}" STUB_TAG="${3:-}" STUB_BRANCH="${4:-}" STUB_REV="${5:-}"
    SKIP_FLUX="${6:-false}"
    BOOTSTRAP_SCRIPT_DIR="$WORK/repo/scripts"
    SEED_REF_WAIT_TRIES=2
    local src="hosting-platform-${PLATFORM_ENV}"; [[ "$PLATFORM_ENV" == dev ]] && src="hosting-platform"
    kctl() {
      case "$* " in
        *"gitrepository ${src} "*) ;;  # the env's own source name, exactly
        *) return 1 ;;
      esac
      case "$*" in
        *spec.ref.tag*)            printf '%s' "$STUB_TAG" ;;
        *spec.ref.branch*)         printf '%s' "$STUB_BRANCH" ;;
        *status.artifact.revision*) printf '%s' "$STUB_REV" ;;
      esac
    }
    sleep() { printf 'z' >> "$WORK/slept"; }
    # shellcheck source=/dev/null
    source "$WORK/helpers.sh"
    platform_seed_ref; echo " rc=$?" )
}

echo "── platform_seed_ref: the ref Flux reconciles ──"
check "dev seeds from the live development branch"       "development rc=0"      "$(seed dev '' '' development)"
check "dev: the LIVE branch is read, not assumed"         "release-x rc=0"        "$(seed dev '' '' release-x)"
check "production seeds from the pinned tag, not HEAD"   "v2026.10.2 rc=0"       "$(seed production v2026.10.2 v2026.10.2)"
check "re-run after an upgrade: the LIVE pin wins over --release-tag" \
                                                         "v2026.10.3 rc=0"       "$(seed production v2026.10.2 v2026.10.3)"
check "staging seeds from the tag Flux's semver resolved" "v2026.10.3-rc.1 rc=0" "$(seed staging '' '' '' "v2026.10.3-rc.1@sha1:$SHA")"
check "staging: a branch revision is not a release tag"   " rc=1"                "$(seed staging '' '' '' "main@sha1:$SHA")"
check "staging: no resolved artifact → no answer (rc=1)" " rc=1"                "$(seed staging)"
echo "── no Flux source (--skip-flux, or not created) ──"
check "production: --release-tag"                         "v2026.9.9 rc=0"       "$(seed production v2026.9.9 '' '' '' true)"
check "production: v<platform/VERSION> without --release-tag" "v2026.10.2 rc=0"  "$(seed production '' '' '' '' true)"
check "production with Flux but no source yet: --release-tag" "v2026.9.9 rc=0"   "$(seed production v2026.9.9)"
check "dev: development"                                  "development rc=0"     "$(seed dev '' '' '' '' true)"
check "staging: unknowable → rc=1"                        " rc=1"                "$(seed staging '' '' '' '' true)"
check "an unknown env has no seed ref"                    " rc=1"                "$(seed qa)"
echo "── only staging waits for a resolved revision ──"
: > "$WORK/slept"; seed production v2026.9.9 >/dev/null; seed dev >/dev/null
check "production/dev with no source answer at once (no wait)" "" "$(cat "$WORK/slept")"
: > "$WORK/slept"; seed staging >/dev/null
check "staging polls for the revision (SEED_REF_WAIT_TRIES=2)" "zz" "$(cat "$WORK/slept")"

echo "── call sites ──"
apply_body="$(fn_body apply_platform_manifests)"
flux_body="$(fn_body install_flux)"
has   "$apply_body" 'platform_seed_ref'                    "apply_platform_manifests asks platform_seed_ref for the clone ref"
hasnt "$apply_body" 'local apply_ref="HEAD"'              "apply_platform_manifests no longer defaults to origin HEAD"
has   "$apply_body" 'clone_branch_flag=(--branch "$apply_ref")' "the resolved ref reaches git clone"
has   "$flux_body"  'resolve_production_release_tag'      "install_flux pins the same tag helper the seed uses"
hasnt "$flux_body"  'flux_tag="$RELEASE_TAG"'             "install_flux has no private copy of the tag precedence"
# Production must never fall back to a branch: an unresolvable production ref aborts.
prod_fallback="$(grep -n 'HEAD' <<<"$apply_body" | grep -c 'production' || true)"
check "no production → HEAD fallback in apply_platform_manifests" "0" "$prod_fallback"
has   "$apply_body" 'error "Cannot determine the git ref'   "an unresolved production/dev seed is a hard error"

echo
echo "seed-ref: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
