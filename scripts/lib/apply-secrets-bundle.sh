#!/usr/bin/env bash
# apply-secrets-bundle.sh — profile-aware Secret application for the
# DR-bundle restore path. Sourced by `scripts/bootstrap.sh
# --secrets-bundle …` and by `make secrets-restore` so both surfaces
# honour the same `--restore-profile` semantics.
#
# Profiles:
#   conservative  → apply tier-1-platform only (default; safe for
#                   unattended bootstrap of a fresh cluster).
#   full          → apply tier-1 + tier-2 + unclassified.
#   <both>        → entries in MANIFEST.json.skipAtRestore are SKIPPED
#                   unless --override-skip-at-restore is also passed.
#
# Orthogonal flags:
#   --dry-run        log what would be applied, change nothing.
#   --extract-to=<dir>  write decrypted YAML files to <dir> instead of
#                   `kubectl apply`. The default profile gating still
#                   applies — only files that WOULD be applied land
#                   in the dir. Use this for forensic / incident-
#                   response workflows.
#
# Expected inputs (positional args):
#   $1  path to the AGE-encrypted bundle (.tar.age)
#   $2  path to the operator's age private key
#
# Expected env (set by caller):
#   RESTORE_PROFILE                  conservative|full (default: conservative)
#   RESTORE_DRY_RUN                  0|1
#   RESTORE_EXTRACT_TO               empty or absolute dir path
#   RESTORE_OVERRIDE_SKIP_AT_RESTORE 0|1
#   KCTL                             kubectl binary path (default: kubectl)
#   AGE                              age binary path (default: age)
#   JQ                               jq binary path (default: jq)

set -euo pipefail

apply_secrets_bundle() {
  local bundle_path="$1"
  local age_key="$2"

  local profile="${RESTORE_PROFILE:-conservative}"
  local dry_run="${RESTORE_DRY_RUN:-0}"
  local extract_to="${RESTORE_EXTRACT_TO:-}"
  local override_skip="${RESTORE_OVERRIDE_SKIP_AT_RESTORE:-0}"
  local kctl="${KCTL:-kubectl}"
  local age="${AGE:-age}"
  local jq="${JQ:-jq}"

  if [[ "$profile" != "conservative" && "$profile" != "full" ]]; then
    echo "apply-secrets-bundle: invalid --restore-profile='$profile' (must be conservative|full)" >&2
    return 2
  fi
  if [[ ! -r "$bundle_path" ]]; then
    echo "apply-secrets-bundle: bundle not readable: $bundle_path" >&2
    return 2
  fi
  if [[ ! -r "$age_key" ]]; then
    echo "apply-secrets-bundle: age key not readable: $age_key" >&2
    return 2
  fi

  # Stage to /dev/shm so plaintext doesn't hit the root filesystem.
  # Cleanup is mandatory — RETURN/EXIT trap below.
  local stage
  stage=$(mktemp -d --tmpdir=/dev/shm apply-bundle.XXXXXX 2>/dev/null || mktemp -d)
  chmod 700 "$stage"
  _apply_bundle_cleanup() {
    local s="${stage:-}"
    if [[ -n "$s" && -d "$s" ]]; then
      find "$s" -type f -exec sh -c ': > "$1"' _ {} \; 2>/dev/null || true
      rm -rf "$s"
      stage=""
    fi
  }
  trap _apply_bundle_cleanup RETURN EXIT

  # Decrypt + extract.
  if ! "$age" -d -i "$age_key" "$bundle_path" | tar -xf - -C "$stage" 2>/dev/null; then
    echo "apply-secrets-bundle: failed to decrypt/extract bundle" >&2
    return 1
  fi
  if [[ ! -r "$stage/MANIFEST.json" ]]; then
    echo "apply-secrets-bundle: bundle missing MANIFEST.json (not a v2 bundle?)" >&2
    return 1
  fi

  # Build the apply list per profile + skip-at-restore.
  local skip_filter='select(.namespace as $n | .name as $m | ($skip | map("\(.namespace)/\(.name)") | index("\($n)/\($m)") | not))'
  local tier_filter
  case "$profile" in
    conservative) tier_filter='.restoreTier == "tier-1-platform"' ;;
    full)         tier_filter='true' ;;
  esac

  local list_jq
  if [[ "$override_skip" == "1" ]]; then
    # Operator overrode the skip-at-restore decisions; bypass that filter.
    list_jq=".entries[] | select($tier_filter) | \"\(.namespace)|\(.name)|\(.restoreTier)|\(.sha256OfYaml)\""
  else
    list_jq='.entries as $entries | .skipAtRestore as $skip | $entries[] | select('"$tier_filter"') | '"$skip_filter"' | "\(.namespace)|\(.name)|\(.restoreTier)|\(.sha256OfYaml)"'
  fi

  local total_in_bundle skipped_total applied_total=0 skipped_tier=0 skipped_op=0 hash_mismatch=0
  total_in_bundle=$("$jq" '.entries | length' "$stage/MANIFEST.json")
  skipped_total=$(("$total_in_bundle" - $("$jq" "[.entries[] | select($tier_filter)] | length" "$stage/MANIFEST.json")))
  echo "[restore] bundle entries: $total_in_bundle"
  echo "[restore] profile: $profile (skip-by-tier: $skipped_total)"
  if [[ "$override_skip" == "1" ]]; then
    echo "[restore] --override-skip-at-restore: applying skip-at-restore entries too"
  fi
  if [[ "$dry_run" == "1" ]]; then
    echo "[restore] DRY-RUN — no kubectl apply will happen"
  fi
  if [[ -n "$extract_to" ]]; then
    mkdir -p "$extract_to"
    chmod 700 "$extract_to"
    echo "[restore] extracting to $extract_to (no kubectl apply)"
  fi

  local line ns name tier sha
  while IFS='|' read -r ns name tier sha; do
    [[ -z "$ns" ]] && continue
    local file="$stage/${ns}__${name}.yaml"
    if [[ ! -r "$file" ]]; then
      echo "[restore] WARN: $ns/$name listed in MANIFEST.json but YAML missing — skipping"
      continue
    fi
    # Verify sha256 against MANIFEST.json claim before applying.
    local actual_sha
    actual_sha=$(sha256sum "$file" | awk '{print $1}')
    if [[ "$actual_sha" != "$sha" ]]; then
      echo "[restore] ERROR: $ns/$name sha256 mismatch (expected $sha, got $actual_sha) — refusing to apply"
      hash_mismatch=$((hash_mismatch + 1))
      continue
    fi
    if [[ -n "$extract_to" ]]; then
      cp -p "$file" "$extract_to/${ns}__${name}.yaml"
      # Tar extraction inherits the process umask, which can leave
      # plaintext Secret YAMLs world-readable on operator machines.
      # Force 0600 explicitly after copy.
      chmod 0600 "$extract_to/${ns}__${name}.yaml"
      applied_total=$((applied_total + 1))
      continue
    fi
    if [[ "$dry_run" == "1" ]]; then
      echo "[restore] DRY-RUN: would apply $ns/$name [$tier]"
      applied_total=$((applied_total + 1))
      continue
    fi
    # Apply for real. Ensure namespace exists first.
    "$kctl" create namespace "$ns" --dry-run=client -o yaml | "$kctl" apply -f - >/dev/null 2>&1 || true
    if "$kctl" apply -f "$file" >/dev/null 2>&1; then
      echo "[restore] applied $ns/$name [$tier]"
      applied_total=$((applied_total + 1))
    else
      echo "[restore] ERROR: kubectl apply failed for $ns/$name"
    fi
  done < <("$jq" -r "$list_jq" "$stage/MANIFEST.json")

  # Skip-at-restore + tier-skipped counts for the summary line.
  if [[ "$override_skip" == "0" ]]; then
    skipped_op=$("$jq" "[.skipAtRestore[]] | length" "$stage/MANIFEST.json")
  fi
  echo "[restore] summary: applied=$applied_total skipped-by-tier=$skipped_total skipped-by-operator=$skipped_op hash-mismatch=$hash_mismatch"
  if (( hash_mismatch > 0 )); then
    return 1
  fi
}
