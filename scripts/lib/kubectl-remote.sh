#!/usr/bin/env bash
# kubectl-remote.sh — run kubectl on a remote cluster over SSH.
#
# For integration harnesses that invoke `$KUBECTL ...` to do in-cluster
# checks (e.g. node-terminal's DB step-up reset, pod-existence probes).
# When the suite runs from a workstation against a remote cluster (rather
# than locally in DinD), set KUBECTL to this script in scripts/integration.env:
#
#   KUBECTL=/abs/path/to/scripts/lib/kubectl-remote.sh
#
# Uses SSH_HOST + SSH_KEY from the environment. Each argument is shell-quoted
# with printf %q so values containing spaces / SQL / quotes survive the SSH
# re-parse on the remote shell intact.
set -uo pipefail
exec ssh -i "${SSH_KEY:-$HOME/hosting-platform.key}" \
  -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o LogLevel=ERROR \
  "${SSH_HOST:-root@127.0.0.1}" \
  "KUBECONFIG=/etc/rancher/k3s/k3s.yaml kubectl $(printf '%q ' "$@")"
