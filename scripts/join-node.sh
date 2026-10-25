#!/usr/bin/env bash
# join-node.sh — join this host to an Insula cluster. The admin panel's join
# command (Security → Network trust → Pending peers → Get bootstrap command) is
# one line that downloads this file, checks its SHA-256 and runs it:
#
#   bash join-node.sh --release <version> --join-as <server|worker> --server <ip> \
#        [--token <token>] [--repo <owner/repo>] [<more insula bootstrap flags>]
#
# As root on the NEW node, whose pre-enrolment must exist. It
#   1. downloads the insula CLI of --release — the cluster's own release, since
#      bootstrap pins k3s per release — and its signature from GitHub;
#   2. verifies the signature against the release key below, and installs the
#      CLI to /usr/local/bin only when it matches;
#   3. runs `insula bootstrap --join-as … --server … --token …` plus any further
#      flags. Without --token it asks for the token (hidden input): for a server,
#      the one in /var/lib/rancher/k3s/server/node-token on any existing server.
#
# The panel's line checks this file's SHA-256 before running it, so the key below
# is one the cluster vouches for, not whatever GitHub serves next to the binary.
# It must equal platform/cosign.pub (join-script.test.ts asserts it).
set -euo pipefail

RELEASE_KEY='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgpnmvll+UUxL+WXlHXtF4blbmK1T
2KYM0pZapVJy/NexTvGvRLP6J5m0oTyzMfeV2shGPN9VhdeZshKPva8FGg==
-----END PUBLIC KEY-----'

BIN_DIR="${JOIN_NODE_BIN_DIR:-/usr/local/bin}"

say() { printf '%s\n' "$*" >&2; }
die() { say "join-node: $*"; exit 1; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

release="" role="" server="" repo="insulahq/insula" token="${INSULA_JOIN_TOKEN:-}"
extra=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release|--join-as|--server|--token|--repo)
      [[ $# -ge 2 ]] || die "$1 needs a value"
      case "$1" in
        --release) release="$2" ;;
        --join-as) role="$2" ;;
        --server) server="$2" ;;
        --token) token="$2" ;;
        --repo) repo="$2" ;;
      esac
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) extra+=("$1"); shift ;;
  esac
done

[[ "$release" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "--release <version> is required (the cluster's release, e.g. 2026.10.17)"
[[ "$role" == server || "$role" == worker ]] || die "--join-as must be server or worker"
[[ "$server" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "--server must be the IPv4 address of an existing server"
[[ "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$ && "${repo#*/}" != . && "${repo#*/}" != .. ]] \
  || die "--repo must be <owner>/<repo>"
[[ "$(id -u)" -eq 0 ]] || die "run this as root (sudo -i), then run the same command again"
for tool in curl openssl base64 install; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is needed on this host — install it, then run the same command again"
done

case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "no insula CLI is released for $(uname -m)" ;;
esac

if [[ -z "$token" ]]; then
  [[ "$role" == server ]] && say "The server join token is in /var/lib/rancher/k3s/server/node-token on any existing server."
  read -rsp 'Paste the join token, then press Enter: ' token || [[ -n "$token" ]] \
    || die "no token given (run this in a terminal, or pass --token)"
  say ""
  [[ -n "$token" ]] || die "no token given"
fi

# /var/tmp, not a tmpfs /tmp: the CLI is large, and RAM is scarce on a small node.
work="$(mktemp -d "${TMPDIR:-/var/tmp}/join-node.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$work"

base="https://github.com/${repo}/releases/download/v${release}"
say "Downloading the insula CLI ${release} (linux-${arch}) and its signature from github.com/${repo} ..."
fetch() { curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 900 -o "$1" "$2" || die "downloading $2 failed"; }
fetch insula "${base}/insula-linux-${arch}"
fetch insula.sig "${base}/insula-linux-${arch}.sig"

printf '%s\n' "$RELEASE_KEY" > cosign.pub
base64 -d insula.sig > insula.sig.der 2>/dev/null || die "the downloaded signature is not valid base64. Nothing was installed or run."
if ! openssl dgst -sha256 -verify cosign.pub -signature insula.sig.der insula >&2; then
  die "signature verification FAILED: the download is not what was released. Nothing was installed or run."
fi
install -m 0755 insula "${BIN_DIR}/insula"
say "Installed ${BIN_DIR}/insula (signature verified). Joining the cluster as a ${role} through ${server} ..."

# exec skips the EXIT trap: clean up first.
cd /
rm -rf "$work"
trap - EXIT
exec "${BIN_DIR}/insula" bootstrap --join-as "$role" --server "$server" --token "$token" ${extra[@]+"${extra[@]}"}
