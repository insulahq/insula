#!/usr/bin/env bash
# idempotent: reads holdSamplesFor first and writes only when it is still the upstream 180d default — a second run, and any install an operator tuned deliberately, is a no-op
# allow-paths: (none — updates the Stalwart SpamClassifier singleton through the kube API; writes no host files)
set -euo pipefail

# Backfill SpamClassifier.holdSamplesFor 180d -> 30d on EXISTING clusters.
#
# Why this needs a migration: the setting is applied by
# scripts/bootstrap.sh configure_stalwart_full(), which reaches FRESH installs
# only. Without this script every cluster installed before that change keeps the
# upstream 180-day default forever, and the runbook's manual one-liner becomes a
# step someone has to remember on every existing host.
#
# What it bounds: Stalwart blob storage is reference-counted, and a
# spam-classifier training sample pins the message blob via a
# 'BlobLink::Temporary{until}' stamped AT INGEST as 'midnight + holdSamplesFor'.
# Destroying the account does NOT release it (destroy_account_blobs unlinks only
# Email/FileNode/SieveScript hard links), so at 180d a deleted mailbox keeps its
# bytes on the mail PVC for six months — invisibly, because the mailbox is gone
# and the account quota reads 0 B. Measured on v0.16.16: 2 GiB survived EXPUNGE,
# every forced purge task and outright account deletion, then fell to 11 MB in
# one compaction once the samples went.
# See docs/operations/MAIL_STORE_SPACE_RECLAIM.md.
#
# Why 30d and not lower: 'retrain' rebuilds from a FRESH trainer and aborts with
# "Not enough samples for training" unless the survivors clear
# minHamSamples/minSpamSamples (100 each). Routine 12-hourly 'train' is
# unaffected either way — it only reads samples newer than the last run.
#
# Scope: affects mail ingested AFTER it runs ('until' is stamped at ingest). It
# does not retroactively shorten existing samples, and it is NOT the fast path
# for deletions — that is the per-principal purge in
# backend/src/modules/mail-admin/spam-sample-cleanup.ts, which ships separately.

MIG=0001-stalwart-spam-sample-retention

DEFAULT_180D=15552000000   # upstream default, milliseconds
TARGET_30D=2592000000      # 30 d, milliseconds

KUBECONFIG_PATH=/etc/rancher/k3s/k3s.yaml
if [ ! -r "$KUBECONFIG_PATH" ]; then
  echo "${MIG}: no kubeconfig at ${KUBECONFIG_PATH} — agent node, skipping."
  exit 0
fi
export KUBECONFIG="$KUBECONFIG_PATH"

if ! command -v kubectl >/dev/null 2>&1; then
  echo "${MIG}: kubectl not found — skipping." >&2
  exit 0
fi

if ! kubectl get namespace mail >/dev/null 2>&1; then
  echo "${MIG}: no mail namespace (--skip-mail?) — nothing to do."
  exit 0
fi

if ! kubectl -n mail get deploy stalwart-mail >/dev/null 2>&1; then
  echo "${MIG}: stalwart-mail Deployment absent — nothing to do."
  exit 0
fi

# A rolling mail pod means no JMAP endpoint. Defer rather than fail: this runs
# on every node daily, so the next converge picks it up, and halting the whole
# host-migration run over a transient mail restart would be the wrong trade.
READY=$(kubectl -n mail get deploy stalwart-mail -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)
case "$READY" in ""|*[!0-9]*) READY=0 ;; esac
if [ "$READY" -lt 1 ]; then
  echo "${MIG}: stalwart-mail has no ready replica — deferring to the next converge." >&2
  exit 0
fi

ADMIN_PW=$(kubectl -n mail get secret stalwart-admin-creds \
  -o jsonpath='{.data.adminPassword}' 2>/dev/null | base64 -d 2>/dev/null || true)
RECOVERY_PW=$(kubectl -n mail get secret stalwart-admin-creds \
  -o jsonpath='{.data.recoveryPassword}' 2>/dev/null | base64 -d 2>/dev/null || true)
if [ -z "$ADMIN_PW" ] && [ -z "$RECOVERY_PW" ]; then
  echo "${MIG}: stalwart-admin-creds unreadable — skipping." >&2
  exit 0
fi

# in-pod curl against the loopback management port: no cluster-network access
# needed from the host. Credential and body go over STDIN, never argv — kubectl's
# command line is world-readable in the node's process table.
jmap() {
  printf '%s\n%s\n' "$1" "$2" | kubectl -n mail exec -i deploy/stalwart-mail -- sh -c '
    IFS= read -r PW
    IFS= read -r BODY
    curl -sf -u "admin:$PW" -X POST http://127.0.0.1:8080/jmap/ \
      -H "Content-Type: application/json" --max-time 30 -d "$BODY"
  ' 2>/dev/null || true
}

read_hold() {
  jmap "$1" '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:SpamClassifier/get",{"ids":["singleton"],"properties":["holdSamplesFor"]},"g"]]}' |
    sed -n 's/.*"holdSamplesFor":\([0-9]*\).*/\1/p' | head -1
}

# bootstrap-job probes adminPassword first and falls back to recoveryPassword;
# mirror that instead of assuming which one is live on this cluster.
PW=""
CURRENT=""
for candidate in "$ADMIN_PW" "$RECOVERY_PW"; do
  [ -n "$candidate" ] || continue
  value=$(read_hold "$candidate" || true)
  if [ -n "$value" ]; then
    PW="$candidate"
    CURRENT="$value"
    break
  fi
done
if [ -z "$PW" ]; then
  echo "${MIG}: could not read holdSamplesFor with either credential — deferring." >&2
  exit 0
fi

if [ "$CURRENT" = "$TARGET_30D" ]; then
  echo "${MIG}: holdSamplesFor already ${TARGET_30D}ms (30d) — no change."
  exit 0
fi

# Only move the upstream default. An operator who raised or lowered this on
# purpose keeps their value — a migration that silently overwrote it would be
# indistinguishable from a bug the next time someone tuned it.
if [ "$CURRENT" != "$DEFAULT_180D" ]; then
  echo "${MIG}: holdSamplesFor is ${CURRENT}ms — operator-tuned, leaving it alone."
  exit 0
fi

jmap "$PW" '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:SpamClassifier/set",{"accountId":"d333333","update":{"singleton":{"holdSamplesFor":'"${TARGET_30D}"'}}},"s"]]}' >/dev/null

VERIFY=$(read_hold "$PW" || true)
if [ "$VERIFY" != "$TARGET_30D" ]; then
  echo "${MIG}: set did not take (holdSamplesFor=${VERIFY:-unreadable}) — failing so the run halts." >&2
  exit 1
fi

echo "${MIG}: holdSamplesFor ${DEFAULT_180D}ms (180d) -> ${TARGET_30D}ms (30d)."
