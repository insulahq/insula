#!/usr/bin/env bash
# ci-no-platform-root-hostpath.sh — no pod may mount a whole platform root
# from the host.
#
# Why this guard exists
# ---------------------
# ADR-055 (2026.7.4) made the generic roots symlinks into the branded ones:
#
#   /etc/platform, /etc/hosting-platform          → /etc/insula
#   /var/lib/platform, /var/lib/hosting-platform  → /var/lib/insula
#
# /etc/insula holds the platform's credential files (admin, Stalwart, Valkey,
# Roundcube, the host-config kubeconfig); /var/lib/insula holds the operator
# key and the age-encrypted secrets bundles. Before the rebrand,
# /etc/hosting-platform held only firewall.conf, so the security-probe mounted
# the whole directory to read it — and after the rebrand that same mount handed
# every probe pod the credential files. The probe drops all capabilities, but
# it runs as uid 0 and the files are root-owned 0600, so owner permission was
# enough. Nobody re-checked the mount when the directories merged.
#
# A hostPath of one of these roots is never needed: mount the one file or
# subdirectory the pod reads (`/etc/hosting-platform/firewall`,
# `/var/lib/platform/snapshots`, `/etc/platform/host-config`, …).
#
# What is checked
# ---------------
#   * every `path:` in k8s/**/*.yaml and in shell heredocs under scripts/ —
#     block or flow style — whose value is exactly one of the six roots
#     (optional quotes / trailing /)
#   * every TypeScript string literal under backend/src that is exactly one of
#     them on a line that also says `hostPath` or `path:`
#
# REPO_ROOT may be overridden (the guard's own negative test uses a temp tree).

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

ROOTS_RE='/(etc|var/lib)/(insula|platform|hosting-platform)/?'
# Block style (`path: /etc/insula`) and flow style (`hostPath: {path: /etc/insula, type: …}`).
YAML_RE="(^[[:space:]-]*|[{,][[:space:]]*)path:[[:space:]]*[\"']?${ROOTS_RE}[\"']?[[:space:]]*([,}#]|$)"
TS_RE="(hostPath|path:).*[\"'\`]${ROOTS_RE}[\"'\`]"

violations=0
report() {
  echo "  $1"
  violations=$((violations + 1))
}

scan_files() {
  local re="$1"; shift
  local f hit
  for f in "$@"; do
    [[ -f "$f" ]] || continue
    while IFS= read -r hit; do
      report "${f#"$REPO_ROOT"/}:${hit}"
    done < <(grep -nE "$re" "$f" || true)
  done
}

mapfile -t yaml_files < <(find "$REPO_ROOT/k8s" -type f \( -name '*.yaml' -o -name '*.yml' \) 2>/dev/null | sort)
mapfile -t sh_files < <(find "$REPO_ROOT/scripts" -type f -name '*.sh' ! -name "$(basename "$0")" 2>/dev/null | sort)
mapfile -t ts_files < <(find "$REPO_ROOT/backend/src" -type f -name '*.ts' ! -name '*.test.ts' 2>/dev/null | sort)

if [[ ${#yaml_files[@]} -eq 0 ]]; then
  echo "ci-no-platform-root-hostpath: no manifests found under $REPO_ROOT/k8s — refusing to pass vacuously" >&2
  exit 1
fi

echo "── platform-root hostPath guard ──────────────────────────────────────"
scan_files "$YAML_RE" "${yaml_files[@]}"
scan_files "$YAML_RE" "${sh_files[@]}"
scan_files "$TS_RE" "${ts_files[@]}"

if [[ $violations -gt 0 ]]; then
  echo
  echo "ci-no-platform-root-hostpath: FAIL — ${violations} hostPath(s) mount a whole platform root." >&2
  echo "  These directories hold credentials and the operator key. Mount the one file or" >&2
  echo "  subdirectory the pod reads instead." >&2
  exit 1
fi
echo "ci-no-platform-root-hostpath: OK — ${#yaml_files[@]} manifest(s), ${#sh_files[@]} script(s), ${#ts_files[@]} source file(s); no platform root is mounted."
