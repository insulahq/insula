#!/usr/bin/env bash
# ensure-workstation-deps.sh — install the CLI tools the integration suites need
# on the WORKSTATION (the machine driving the suite), so a fresh checkout runs
# `integration-all.sh` / `integration-staging.sh` with zero manual `apt-get`.
#
# Idempotent + fast: probes each tool with `command -v` first and returns
# immediately when everything is present (the common case), so it adds no
# latency to a warm workstation.
#
# Deliberately does NOT install `kubectl` or `docker`: the staging suites reach
# the cluster via the $KUBECTL SSH shim (scripts/lib/kubectl-remote.sh), and
# `docker` is only for the local-DinD suites (a different harness).
#
# Source it and call `ensure_workstation_deps [tool ...]`. With no args it
# installs the full default set the suites reference (openssl, curl, jq,
# python3+dnspython, dig, ncat, sshpass, sftp, rsync, age, psql, restic, …).
# Opt out entirely with INTEGRATION_SKIP_DEP_INSTALL=1.

# Map a required command → the OS package that provides it. Package names differ
# by family; resolved per package manager below.
_wsdep_pkg_apt() {
  case "$1" in
    openssl) echo openssl ;;
    curl) echo curl ;;
    jq) echo jq ;;
    python3) echo python3 ;;
    pip3) echo python3-pip ;;
    dig) echo dnsutils ;;
    ncat) echo ncat ;;
    nc) echo netcat-openbsd ;;
    sshpass) echo sshpass ;;
    sftp) echo openssh-client ;;
    rsync) echo rsync ;;
    age) echo age ;;
    psql|pg_restore) echo postgresql-client ;;
    restic) echo restic ;;
    yq) echo yq ;;
    git) echo git ;;
    base64) echo coreutils ;;
    *) echo "$1" ;;
  esac
}
_wsdep_pkg_dnf() {
  case "$1" in
    dig) echo bind-utils ;;
    nc) echo nmap-ncat ;;
    ncat) echo nmap-ncat ;;
    sftp) echo openssh-clients ;;
    psql|pg_restore) echo postgresql ;;
    pip3) echo python3-pip ;;
    base64) echo coreutils ;;
    *) echo "$1" ;;
  esac
}

_wsdep_have() { command -v "$1" >/dev/null 2>&1; }

ensure_workstation_deps() {
  [[ "${INTEGRATION_SKIP_DEP_INSTALL:-0}" == "1" ]] && return 0

  local -a want
  if [[ $# -gt 0 ]]; then
    want=("$@")
  else
    want=(openssl curl jq python3 dig ncat sshpass sftp rsync age psql restic base64 git)
  fi

  # 1) Which requested commands are missing?
  local -a missing=()
  local t
  for t in "${want[@]}"; do _wsdep_have "$t" || missing+=("$t"); done

  # 2) python3 dnspython module (used by the DNS SRV/TXT/PTR probes) — a module,
  #    not a command; check import.
  local need_dnspython=0
  if printf '%s\n' "${want[@]}" | grep -qx python3; then
    if _wsdep_have python3 && ! python3 -c 'import dns.resolver' >/dev/null 2>&1; then need_dnspython=1; fi
  fi

  if [[ ${#missing[@]} -eq 0 && $need_dnspython -eq 0 ]]; then
    return 0  # warm path — nothing to do
  fi

  # 3) Resolve the package manager + a sudo prefix (root needs none).
  local mgr install_cmd update_cmd pkgfn
  if command -v apt-get >/dev/null 2>&1; then
    mgr=apt; pkgfn=_wsdep_pkg_apt
    update_cmd="apt-get update -qq"; install_cmd="apt-get install -y -qq"
  elif command -v dnf >/dev/null 2>&1; then
    mgr=dnf; pkgfn=_wsdep_pkg_dnf
    update_cmd=":"; install_cmd="dnf install -y -q"
  elif command -v brew >/dev/null 2>&1; then
    mgr=brew; pkgfn=_wsdep_pkg_apt
    update_cmd=":"; install_cmd="brew install"
  else
    echo "ensure_workstation_deps: no supported package manager (apt/dnf/brew) — install manually: ${missing[*]}" >&2
    return 0  # non-fatal: each suite's own `command -v` guard will skip cleanly
  fi
  local SUDO=""; [[ "$(id -u)" != "0" ]] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

  # 4) Map missing commands → unique package set, then install.
  if [[ ${#missing[@]} -gt 0 ]]; then
    local -A seen=(); local -a pkgs=()
    for t in "${missing[@]}"; do
      local p; p=$("$pkgfn" "$t")
      [[ -n "$p" && -z "${seen[$p]:-}" ]] && { seen[$p]=1; pkgs+=("$p"); }
    done
    echo "ensure_workstation_deps: installing missing tools via $mgr: ${missing[*]} (packages: ${pkgs[*]})" >&2
    # shellcheck disable=SC2086
    $SUDO $update_cmd >/dev/null 2>&1 || true
    # Install per-package so one unavailable package (e.g. restic on an old
    # distro) doesn't block the rest; a still-missing tool self-skips its suite.
    local pk
    for pk in "${pkgs[@]}"; do
      # shellcheck disable=SC2086
      $SUDO $install_cmd "$pk" >/dev/null 2>&1 || echo "ensure_workstation_deps: could not install '$pk' — its suite(s) will self-skip" >&2
    done
  fi

  # 5) python dnspython via pip (or the distro package).
  if [[ $need_dnspython -eq 1 ]]; then
    if _wsdep_have pip3 || python3 -m pip --version >/dev/null 2>&1; then
      python3 -m pip install --quiet --disable-pip-version-check dnspython >/dev/null 2>&1 \
        || $SUDO $install_cmd "$([[ $mgr == dnf ]] && echo python3-dns || echo python3-dnspython)" >/dev/null 2>&1 \
        || echo "ensure_workstation_deps: could not install dnspython — DNS-probe suites will self-skip" >&2
    else
      # shellcheck disable=SC2086
      $SUDO $install_cmd "$([[ $mgr == dnf ]] && echo python3-dns || echo python3-dnspython)" >/dev/null 2>&1 \
        || echo "ensure_workstation_deps: could not install dnspython" >&2
    fi
  fi
  return 0
}
