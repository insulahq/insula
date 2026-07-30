#!/usr/bin/env bash
# scripts/lib/require-tools.sh — shared fail-fast dependency preflight.
#
# Usage (source once, then call with the external tools the script needs):
#   source "${SCRIPT_DIR}/lib/require-tools.sh"
#   require_cmds docker helm kubectl jq
#
# Aggregates EVERY missing tool and exits 1 with a one-line install command for
# each (tailored to the host's package manager), so a script fails EARLY and
# actionably instead of dying deep in after minutes of work — e.g. local.sh
# used to run the docker builds + k3s bringup before discovering `helm` was
# missing (2026-07-30).
#
# Side-effect-free: only probes `command -v`; never installs anything. For the
# auto-installing variant used by the integration suites see
# scripts/lib/ensure-workstation-deps.sh.

# Detect a usable package manager once (for install hints only).
_rt_pkgmgr() {
  if command -v brew    >/dev/null 2>&1; then echo brew
  elif command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf     >/dev/null 2>&1; then echo dnf
  else echo none; fi
}

# One-line install hint for a command, tailored to the package manager. Command
# name == package name for the common CLIs (jq/curl/git/openssl/python3/…); the
# special cases below have their own upstream installers.
_rt_hint() {
  local cmd="$1" pm="$2"
  case "$cmd" in
    docker)
      case "$pm" in
        brew) echo "brew install --cask docker";;
        *)    echo "curl -fsSL https://get.docker.com | sh";;
      esac;;
    helm)
      case "$pm" in
        brew) echo "brew install helm";;
        *)    echo "curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash";;
      esac;;
    kubectl)
      case "$pm" in
        brew) echo "brew install kubectl";;
        apt)  echo "sudo apt-get update && sudo apt-get install -y kubectl   # or https://kubernetes.io/docs/tasks/tools/";;
        dnf)  echo "sudo dnf install -y kubectl";;
        *)    echo "https://kubernetes.io/docs/tasks/tools/";;
      esac;;
    node|npm)
      case "$pm" in
        brew) echo "brew install node";;
        apt)  echo "sudo apt-get install -y nodejs npm   # or https://github.com/nvm-sh/nvm";;
        dnf)  echo "sudo dnf install -y nodejs npm";;
        *)    echo "https://nodejs.org/ (or nvm)";;
      esac;;
    *)
      case "$pm" in
        brew) echo "brew install $cmd";;
        apt)  echo "sudo apt-get install -y $cmd";;
        dnf)  echo "sudo dnf install -y $cmd";;
        *)    echo "install '$cmd' with your package manager";;
      esac;;
  esac
}

# require_cmds <tool>...  — exit 1 listing every missing tool + how to install it.
require_cmds() {
  local missing=() cmd pm
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  [ "${#missing[@]}" -eq 0 ] && return 0
  pm="$(_rt_pkgmgr)"
  {
    echo ""
    echo "ERROR: missing required tool(s): ${missing[*]}"
    echo "Install, then re-run this command:"
    for cmd in "${missing[@]}"; do
      printf '  %-9s %s\n' "$cmd" "$(_rt_hint "$cmd" "$pm")"
    done
    echo ""
  } >&2
  exit 1
}

# require_docker_running — verify the Docker daemon is reachable (not just the
# binary). Call after `require_cmds docker`. Honours DOCKER_HOST.
require_docker_running() {
  docker info >/dev/null 2>&1 && return 0
  echo "" >&2
  echo "ERROR: Docker is installed but the daemon is not reachable${DOCKER_HOST:+ (DOCKER_HOST=$DOCKER_HOST)}." >&2
  echo "Start Docker (or fix DOCKER_HOST) and re-run." >&2
  echo "" >&2
  exit 1
}
